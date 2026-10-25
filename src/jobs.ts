import { mkdir, open, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Job, ReelApi } from "./api.js";
import type { Config } from "./config.js";
import { elapsedSeconds, type SavedFile, type ToolContext } from "./context.js";
import { errorMessage, log } from "./log.js";
import { failedResult, runningResult, succeededResult } from "./results.js";
import { resolvePath, type Workspace } from "./workspace.js";

const POLL_WAIT_S = 10;
const SIDECARS = new Set(["transcript", "srt", "vtt", "ass"]);
const OUTPUT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface Tracked {
  stem?: string;
  job?: Job;
  files?: SavedFile[];
}

export class JobRunner {
  readonly #tracked = new Map<string, Tracked>();

  constructor(
    private readonly api: ReelApi,
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
    if (tracked?.job && tracked.files) return succeededResult(tracked.job, tracked.files, ctx);
    return this.#follow(await this.api.getJob(jobId, 0, ctx.signal), ctx);
  }

  async #follow(created: Job, ctx: ToolContext): Promise<CallToolResult> {
    const deadline = ctx.startedAt + this.config.waitSeconds * 1000;

    let job = created;
    while (job.status !== "succeeded" && job.status !== "failed") {
      const remainingS = Math.floor((deadline - Date.now()) / 1000);
      if (remainingS <= 0) return runningResult(job, ctx);

      ctx.progress(`${job.op} ${job.status}${job.stage ? ` (${job.stage})` : ""}, ${Math.round(elapsedSeconds(ctx))} s`);
      job = await this.api.getJob(job.id, Math.min(POLL_WAIT_S, remainingS), ctx.signal);
    }

    log(`${job.op} job ${job.id} ${job.status}`);
    if (job.status === "failed") return failedResult(job);

    const tracked = this.#tracked.get(job.id) ?? {};
    const files = await this.#save(job, tracked.stem ?? defaultStem(job), ctx);
    this.#tracked.set(job.id, { ...tracked, job, files });
    return succeededResult(job, files, ctx);
  }

  async #save(job: Job, stem: string, ctx: ToolContext): Promise<SavedFile[]> {
    const outputs = Object.entries(job.outputs);
    if (outputs.length === 0) return [];

    const dir = resolvePath(this.config.outputDir, await this.workspace.baseDir());
    ctx.progress(`saving ${outputs.length} file(s) to ${dir}`);

    let targets: string[];
    try {
      targets =
        job.op === "ffmpeg"
          ? await Promise.all(outputs.map(async ([name]) => (await reserve(dir, (n) => [numbered(safeName(name), n)]))[0]!))
          : await reserve(dir, (n) => plannedNames(outputs, n === 1 ? stem : `${stem}-${n}`));
    } catch (error) {
      const reason = `couldn't write to ${dir} (${errorMessage(error)}); set REELAPI_OUTPUT_DIR to a writable folder`;
      log(reason);
      return outputs.map(([name, url]) => ({ name, url, error: reason }));
    }

    return Promise.all(
      outputs.map(async ([name, url], index): Promise<SavedFile> => {
        const target = targets[index]!;
        try {
          return { name, url, path: target, bytes: await this.api.download(url, target, ctx.signal) };
        } catch (error) {
          await rm(target, { force: true });
          log(`saving ${url} failed`, error);
          return { name, url, error: `download failed: ${errorMessage(error)}` };
        }
      }),
    );
  }
}

// Subtitles go in captions/ so players don't auto-load them on top of the burned-in captions
export function plannedNames(outputs: [string, string][], stem: string): string[] {
  return outputs.map(([name, url]) => {
    const ext = extensionOf(url);
    if (name === "transcript") return path.join("captions", `${stem}.transcript${ext}`);
    if (SIDECARS.has(name)) return path.join("captions", `${stem}${ext}`);
    return name === "video" ? `${stem}${ext}` : `${stem}-${name}${ext}`;
  });
}

// Never overwrite: bump a numeric suffix until every name is free, then claim the first one atomically
async function reserve(dir: string, candidate: (attempt: number) => string[]): Promise<string[]> {
  for (let attempt = 1; attempt < 1000; attempt++) {
    const targets = candidate(attempt).map((name) => path.join(dir, name));
    const taken = await Promise.all(targets.map((target) => stat(target).then(() => true, () => false)));
    if (taken.some(Boolean)) continue;

    await Promise.all(targets.map((target) => mkdir(path.dirname(target), { recursive: true })));
    try {
      await (await open(targets[0]!, "wx")).close();
      return targets;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`no free filename left in ${dir}`);
}

function numbered(name: string, attempt: number): string {
  if (attempt === 1) return name;
  const ext = path.extname(name);
  return `${name.slice(0, name.length - ext.length)}-${attempt}${ext}`;
}

function safeName(name: string): string {
  if (OUTPUT_NAME.test(name)) return name;
  return name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[^A-Za-z0-9]+/, "") || "output";
}

function extensionOf(url: string): string {
  const ext = URL.canParse(url) ? path.posix.extname(new URL(url).pathname).toLowerCase() : "";
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : "";
}

function defaultStem(job: Job): string {
  const title = (job.result as { title?: unknown } | null | undefined)?.title;
  const slug = typeof title === "string" ? slugify(title) : "";
  return slug ? `short-${slug}` : `${job.op}-${job.id.slice(-6)}`;
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
