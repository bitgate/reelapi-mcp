import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { displayUrl, type Job, type ReelSdk } from "./api.js";
import type { Config } from "./config.js";
import { elapsedSeconds, type SavedFile, type ToolContext } from "./context.js";
import { errorMessage, log } from "./log.js";
import { discard, isDeviceName, isInside, placeIn, realDir } from "./paths.js";
import { failedResult, fileError, jobAge, runningResult, succeededResult } from "./results.js";
import { resolvePath, type Workspace } from "./workspace.js";

const POLL_WAIT_S = 10;
const PARALLEL_DOWNLOADS = 4;
const MAX_NAME = 64;
const SIDECARS = new Set(["transcript", "srt", "vtt", "ass"]);

interface Tracked {
  stem?: string;
  job?: Job;
  saved?: Promise<SavedFile[]>;
}

export class JobRunner {
  readonly #tracked = new Map<string, Tracked>();

  constructor(
    private readonly api: ReelSdk,
    private readonly config: Config,
    private readonly workspace: Workspace,
  ) {}

  async start(op: string, body: Record<string, unknown>, stem: string | undefined, ctx: ToolContext): Promise<CallToolResult> {
    const job = await this.api.createJob(op, body, ctx.signal);
    log(`${op} job ${job.id} created`);
    this.#tracked.set(job.id, { stem });
    return this.#follow(job, ctx);
  }

  async resume(jobId: string, ctx: ToolContext): Promise<CallToolResult> {
    const tracked = this.#tracked.get(jobId);
    if (tracked?.job && tracked.saved) return succeededResult(tracked.job, await tracked.saved, ctx);
    return this.#follow(await this.api.getJob(jobId, 0, ctx.signal), ctx);
  }

  async #follow(created: Job, ctx: ToolContext): Promise<CallToolResult> {
    const deadline = ctx.startedAt + this.config.waitSeconds * 1000;

    let job = created;
    while (job.status !== "succeeded" && job.status !== "failed") {
      const remainingS = Math.floor((deadline - Date.now()) / 1000);
      if (remainingS <= 0) return runningResult(job, ctx);

      ctx.progress(`${job.op} ${job.status}${job.stage ? ` (${job.stage})` : ""}, ${jobAge(job) ?? Math.round(elapsedSeconds(ctx))} s`);
      job = await this.api.getJob(job.id, Math.min(POLL_WAIT_S, remainingS), ctx.signal);
    }

    log(`${job.op} job ${job.id} ${job.status}`);
    if (job.status === "failed") return failedResult(job);

    // Calls that find the job done at the same time share one save
    const tracked = this.#tracked.get(job.id) ?? {};
    if (!tracked.job || !tracked.saved) {
      tracked.job = job;
      tracked.saved = this.#save(job, tracked.stem ?? defaultStem(job), ctx).catch((error: unknown) => {
        tracked.saved = undefined;
        throw error;
      });
      this.#tracked.set(job.id, tracked);
    }
    return succeededResult(tracked.job, await tracked.saved, ctx);
  }

  async #save(job: Job, stem: string, ctx: ToolContext): Promise<SavedFile[]> {
    const outputs = Object.entries(job.outputs);
    if (outputs.length === 0) return [];

    const base = await this.workspace.baseDir();
    const dir = resolvePath(this.config.outputDir, base);
    ctx.progress(`saving ${outputs.length} file(s) to ${dir}`);

    const failAll = (reason: string): SavedFile[] => {
      log(reason);
      return outputs.map(([name, url]) => ({ name, url: displayUrl(url), error: reason }));
    };

    // Names that differ only in case are one file on macOS and Windows, and would keep bumping each other's number
    const clash = job.op === "ffmpeg" ? undefined : firstClash(plannedNames(outputs, stem));
    if (clash !== undefined) return failAll(`two of the job's files would both be saved as ${clash}`);

    let targets: string[];
    try {
      const root = await outputRoot(dir, base);
      targets =
        job.op === "ffmpeg"
          ? await Promise.all(outputs.map(async ([name]) => (await reserve(root, (n) => [numbered(safeName(name), n)]))[0]!))
          : await reserve(root, (n) => plannedNames(outputs, n === 1 ? stem : `${stem}-${n}`));
    } catch (error) {
      return failAll(`couldn't write to ${dir} (${errorMessage(error)}); set REELSDK_OUTPUT_DIR to a writable folder`);
    }

    const budget = this.api.outputBudget();
    return mapLimited(outputs, PARALLEL_DOWNLOADS, async ([name, url], index): Promise<SavedFile> => {
      const target = targets[index]!;
      try {
        return { name, url: displayUrl(url), path: target, bytes: await this.api.download(url, target, ctx.signal, budget) };
      } catch (error) {
        await discard(target).catch(() => {});
        log(`saving ${displayUrl(url)} failed`, error);
        return { name, url: displayUrl(url), error: fileError(error) };
      }
    });
  }
}

// Subtitles go in captions/ so players don't auto-load them on top of the burned-in captions
export function plannedNames(outputs: [string, string][], stem: string): string[] {
  return outputs.map(([name, url]) => {
    const ext = extensionOf(url);
    if (name === "transcript") return path.join("captions", `${stem}.transcript${ext}`);
    if (SIDECARS.has(name)) return path.join("captions", `${stem}${ext}`);
    return name === "video" ? `${stem}${ext}` : `${stem}-${safeName(name)}${ext}`;
  });
}

// A folder inside the project is walked without following any link, since the project may be a cloned repo; one named elsewhere is the user's own
async function outputRoot(dir: string, base: string): Promise<string> {
  const realBase = await realpath(base);
  const project = [base, realBase].find((root) => root === dir || isInside(root, dir));
  if (project !== undefined) return realDir(realBase, path.join(realBase, path.relative(project, dir)));

  await mkdir(dir, { recursive: true });
  return realpath(dir);
}

// Never overwrite, not even a link: bump a numeric suffix until every name is ours. Each one is claimed as an empty file,
// which no other call can claim too, and which only its own download replaces
async function reserve(root: string, candidate: (attempt: number) => string[]): Promise<string[]> {
  for (let attempt = 1; attempt < 1000; attempt++) {
    const targets = await Promise.all(candidate(attempt).map((name) => placeIn(root, name)));
    const taken = await Promise.all(targets.map((target) => lstat(target).then(() => true, () => false)));
    if (taken.some(Boolean)) continue;

    const claims = await Promise.allSettled(targets.map(claim));
    if (claims.every(isClaimed)) return targets;

    // Someone else got one of the names first, so we give back the ones we got
    await Promise.all(targets.filter((_, index) => isClaimed(claims[index])).map((target) => discard(target).catch(() => {})));
    const failure = claims.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }
  throw new Error(`no free filename left in ${root}`);
}

// O_EXCL creates the name or fails, and never follows or replaces what is already there
async function claim(target: string): Promise<boolean> {
  try {
    await (await open(target, "wx")).close();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function isClaimed(result: PromiseSettledResult<boolean> | undefined): boolean {
  return result?.status === "fulfilled" && result.value;
}

function firstClash(names: string[]): string | undefined {
  const seen = new Set<string>();
  for (const name of names) {
    const folded = name.toLowerCase();
    if (seen.has(folded)) return name;
    seen.add(folded);
  }
  return undefined;
}

// At most `width` at once, results in order
async function mapLimited<T, R>(items: T[], width: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < items.length; index = next++) results[index] = await work(items[index]!, index);
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  return results;
}

function numbered(name: string, attempt: number): string {
  if (attempt === 1) return name;
  const ext = path.extname(name);
  return `${name.slice(0, name.length - ext.length)}-${attempt}${ext}`;
}

// A name from the API becomes one short plain file name: no folders, no leading dot, nothing Windows would trim or open as a device
export function safeName(name: string): string {
  const plain = shortened(name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[^A-Za-z0-9]+/, "")).replace(/\.+$/, "");
  if (!plain) return "output";
  return isDeviceName(plain) ? plain.replace(/^[^.]*/, "$&_") : plain;
}

// Short enough that the numbered name and its .part file stay far below the 255 bytes file systems allow
function shortened(name: string): string {
  if (name.length <= MAX_NAME) return name;
  const ext = path.extname(name);
  return ext.length <= 10 ? name.slice(0, MAX_NAME - ext.length) + ext : name.slice(0, MAX_NAME);
}

function extensionOf(url: string): string {
  const ext = URL.canParse(url) ? path.posix.extname(new URL(url).pathname).toLowerCase() : "";
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : "";
}

function defaultStem(job: Job): string {
  const title = (job.result as { title?: unknown } | null | undefined)?.title;
  const slug = typeof title === "string" ? slugify(title) : "";
  return slug ? `short-${slug}` : safeName(`${job.op}-${job.id.slice(-6)}`);
}

export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
}
