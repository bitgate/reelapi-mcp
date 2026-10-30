import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { errorMessage, log } from "./log.js";
import { saveExclusive } from "./paths.js";
import { VERSION } from "./version.js";

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface Job {
  id: string;
  op: string;
  status: JobStatus;
  stage?: string | null;
  created_at: string;
  finished_at: string | null;
  outputs: Record<string, string>;
  duration_s: number | null;
  error: { code: string; message: string } | null;
  usage: Record<string, number>;
  result?: unknown;
  poll_url: string;
}

export interface Upload {
  url: string;
  bytes?: number;
  content_type?: string;
  expires_at: string;
}

export interface Issue {
  path: string;
  message: string;
}

export interface ErrorDetails {
  issues?: Issue[];
  retryAfterS?: number;
  requestId?: string;
  retryable?: boolean;
}

export class ApiError extends Error {
  readonly issues: Issue[];
  readonly retryAfterS: number | undefined;
  readonly requestId: string | undefined;
  readonly retryable: boolean | undefined;

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly endpoint: string,
    details: ErrorDetails = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.issues = details.issues ?? [];
    this.retryAfterS = details.retryAfterS;
    this.requestId = details.requestId;
    this.retryable = details.retryable;
  }
}

export class NetworkError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NetworkError";
  }
}

export interface Limits {
  outputBytes: number;
  answerBytes: number;
  idleMs: number;
  bytesPerSecond: number;
}

export interface OutputBudget {
  left: number;
}

export interface UploadFile {
  handle: FileHandle;
  size: number;
}

export const MAX_OUTPUTS = 20;

const MAX_ATTEMPTS = 4;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const NOT_CONNECTED = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);
const REQUEST_ID = /^[\w-]{1,128}$/;
const MAX_TIMER_MS = 2 ** 31 - 1;
const USER_AGENT = `reelsdk-mcp/${VERSION} node/${process.versions.node}`;

// reelsdk stores at most 2 GiB of files per job, and none of its JSON answers comes near 8 MiB.
// A download may go quiet for a minute, and gets as long as its size takes at 64 KiB/s on top of that
const LIMITS: Limits = { outputBytes: 2 * 1024 ** 3, answerBytes: 8 * 1024 ** 2, idleMs: 60_000, bytesPerSecond: 64 * 1024 };

interface Call {
  method: "GET" | "POST";
  path: string;
  query: Record<string, string | number>;
  json?: unknown;
  file?: UploadFile;
  idempotencyKey?: string;
  retryIf?: (error: unknown) => boolean;
  signal: AbortSignal;
  timeoutMs: number;
}

interface Answer {
  data: Body | null;
  requestId: string | undefined;
}

type Body = Record<string, unknown>;

export class ReelSdk {
  readonly #limits: Limits;

  constructor(
    readonly baseUrl: string,
    private readonly apiKey: string,
    limits: Partial<Limits> = {},
  ) {
    this.#limits = { ...LIMITS, ...limits };
  }

  // wait=0 returns the job id at once; the long waits happen on GET, which is safe to retry.
  // A POST that may have started a job is never repeated, and every attempt of one call carries the same Idempotency-Key
  async createJob(op: string, body: Body, signal: AbortSignal): Promise<Job> {
    const path = `/v1/${op}`;
    const call: Call = { method: "POST", path, query: { wait: 0 }, json: body, idempotencyKey: randomUUID(), retryIf: nothingCreated, signal, timeoutMs: 60_000 };
    return jobFrom(await this.#call(call), path);
  }

  async getJob(id: string, waitS: number, signal: AbortSignal): Promise<Job> {
    const path = `/v1/jobs/${encodeURIComponent(id)}`;
    return jobFrom(await this.#call({ method: "GET", path, query: { wait: waitS }, signal, timeoutMs: (waitS + 30) * 1000 }), path);
  }

  async upload(filename: string, file: UploadFile, signal: AbortSignal): Promise<Upload> {
    const { data, requestId } = await this.#call({ method: "POST", path: "/v1/uploads", query: { filename }, file, signal, timeoutMs: 30 * 60_000 });
    if (typeof data?.url !== "string") throw badResponse("the upload response has no url", "/v1/uploads", requestId);
    return data as unknown as Upload;
  }

  outputBudget(): OutputBudget {
    return { left: this.#limits.outputBytes };
  }

  // A download may go quiet for idleMs, and gets idleMs plus its size at bytesPerSecond in all, retries included
  async download(url: string, destination: string, signal: AbortSignal, budget: OutputBudget): Promise<number> {
    const shown = displayUrl(url);
    const { idleMs, bytesPerSecond } = this.#limits;

    let requestId: string | undefined;
    const tooLarge = () => new ApiError(413, "OUTPUT_TOO_LARGE", `the job's files are over ${sizeOf(this.#limits.outputBytes)}, more than reelsdk stores`, shown, { requestId });
    const timedOut = (reason: string) => new ApiError(504, "DOWNLOAD_TIMEOUT", reason, shown, { requestId, retryable: false });

    const started = Date.now();
    const overall = new AbortController();
    const stopped = AbortSignal.any([signal, overall.signal]);
    let overallTimer: NodeJS.Timeout | undefined;

    const attempt = async (): Promise<number> => {
      const idle = new AbortController();
      const idleTimer = setTimeout(() => idle.abort(timedOut(`no data for ${idleMs / 1000} s`)), idleMs);
      try {
        const response = await this.#fetchOutput(url, AbortSignal.any([stopped, idle.signal]));
        requestId = requestIdOf(response.headers.get("request-id"));
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new ApiError(response.status, `HTTP_${response.status}`, `download failed with HTTP ${response.status}`, shown, { requestId });
        }

        const size = declaredSize(response) ?? budget.left;
        if (size > budget.left) {
          await response.body.cancel();
          throw tooLarge();
        }

        // Node fires a timer longer than MAX_TIMER_MS at once
        const allowedMs = idleMs + (size / bytesPerSecond) * 1000;
        const stop = () => overall.abort(timedOut(`not done after ${Math.round(allowedMs / 1000)} s`));
        overallTimer ??= setTimeout(stop, Math.min(started + allowedMs - Date.now(), MAX_TIMER_MS));

        // We count every byte against the job's budget, whatever Content-Length said, and get them back once a failed attempt's file is gone
        let bytes = 0;
        async function* counted(body: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
          for await (const chunk of body) {
            idleTimer.refresh();
            bytes += chunk.byteLength;
            budget.left -= chunk.byteLength;
            if (budget.left < 0) throw tooLarge();
            yield chunk;
          }
        }

        await saveExclusive(counted(response.body), destination, () => (budget.left += bytes));
        return bytes;
      } catch (error) {
        throw idle.signal.aborted ? idle.signal.reason : error;
      } finally {
        clearTimeout(idleTimer);
      }
    };

    try {
      return await this.#retrying(`GET ${shown}`, stopped, retryable, attempt);
    } catch (error) {
      throw overall.signal.aborted ? overall.signal.reason : error;
    } finally {
      clearTimeout(overallTimer);
    }
  }

  // Files only come from the API's own /f/ links, every redirect hop is held to the same rule, and the key is never sent along
  async #fetchOutput(url: string, signal: AbortSignal): Promise<Response> {
    let next = url;
    for (let hops = 0; ; hops++) {
      if (!this.#isOutputUrl(next)) throw new Error(`refused ${displayUrl(next)}: files only download from ${this.baseUrl}/f/`);

      const response = await fetch(next, { headers: { "user-agent": USER_AGENT }, redirect: "manual", signal });
      const location = response.headers.get("location");
      if (!REDIRECT_STATUS.has(response.status) || location === null) return response;

      await response.body?.cancel();
      if (hops === MAX_REDIRECTS) throw new Error(`refused ${displayUrl(url)}: more than ${MAX_REDIRECTS} redirects`);
      next = new URL(location, next).href;
    }
  }

  #isOutputUrl(url: string): boolean {
    if (!URL.canParse(url)) return false;

    const target = new URL(url);
    const base = new URL(this.baseUrl);
    return target.origin === base.origin && !target.username && !target.password && target.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/f/`);
  }

  async #call(call: Call): Promise<Answer> {
    const query = new URLSearchParams(Object.entries(call.query).map(([key, value]): [string, string] => [key, String(value)]));
    const url = `${this.baseUrl}${call.path}?${query}`;

    return this.#retrying(`${call.method} ${call.path}`, call.signal, call.retryIf ?? retryable, async () => {
      const response = await fetch(url, {
        method: call.method,
        headers: this.#headers(call),
        body: call.file ? fileBody(call.file) : call.json === undefined ? undefined : JSON.stringify(call.json),
        duplex: "half",
        redirect: "manual",
        signal: withTimeout(call.signal, call.timeoutMs),
      });

      // A failed job comes back as 422/500 with the job attached: that's an answer, not a transport error
      const headerId = requestIdOf(response.headers.get("request-id"));
      const text = await answerText(response, this.#limits.answerBytes, call.path, headerId);
      const data = parseObject(text);
      const requestId = headerId ?? requestIdOf((data?.error as Body | null | undefined)?.request_id);
      if (response.ok || isJob(data?.job)) return { data, requestId };

      throw apiError(response, data, text, call.path, requestId);
    });
  }

  #headers(call: Call): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      accept: "application/json",
      "user-agent": USER_AGENT,
    };
    if (call.idempotencyKey !== undefined) headers["idempotency-key"] = call.idempotencyKey;
    if (call.json !== undefined) headers["content-type"] = "application/json";
    if (call.file !== undefined) {
      headers["content-type"] = "application/octet-stream";
      headers["content-length"] = String(call.file.size);
    }
    return headers;
  }

  async #retrying<T>(label: string, signal: AbortSignal, retryIf: (error: unknown) => boolean, attempt: () => Promise<T>): Promise<T> {
    for (let n = 1; ; n++) {
      try {
        return await attempt();
      } catch (error) {
        if (signal.aborted) throw error;

        if (!retryIf(error) || n >= MAX_ATTEMPTS) {
          if (error instanceof ApiError || !isNetworkFailure(error)) throw error;
          const lost = neverSent(error) ? "Couldn't reach" : "Lost the connection to";
          throw new NetworkError(`${lost} ${this.baseUrl} after ${n} attempt${n === 1 ? "" : "s"} (${errorMessage(error)})`, { cause: error });
        }

        const waitMs = error instanceof ApiError && error.retryAfterS !== undefined ? Math.min(error.retryAfterS * 1000, 20_000) : backoffMs(n);
        log(`${label} failed (${errorMessage(error)}), retry ${n}/${MAX_ATTEMPTS - 1} in ${Math.round(waitMs)} ms`);
        await delay(waitMs, undefined, { signal });
      }
    }
  }
}

// Links from an answer are shown without credentials, and URL's own normalization escapes control characters
export function displayUrl(url: string): string {
  if (!URL.canParse(url)) return "(not a valid link)";

  const shown = new URL(url);
  shown.username = "";
  shown.password = "";
  return shown.href;
}

// Every attempt re-reads the file from the start through the handle we checked, never by its name
function fileBody(file: UploadFile): RequestInit["body"] {
  return Readable.toWeb(file.handle.createReadStream({ start: 0, end: file.size - 1, autoClose: false })) as unknown as RequestInit["body"];
}

// We read at most maxBytes of an answer, whatever its Content-Length claims
async function answerText(response: Response, maxBytes: number, endpoint: string, requestId: string | undefined): Promise<string> {
  const tooLarge = () => refused("RESPONSE_TOO_LARGE", `the answer is over ${sizeOf(maxBytes)}`, endpoint, requestId);
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }

  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body ?? []) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw tooLarge();
    chunks.push(chunk);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function declaredSize(response: Response): number | undefined {
  const value = Number(response.headers.get("content-length") ?? Number.NaN);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function sizeOf(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${bytes / 1024 ** 3} GiB` : `${Math.ceil(bytes / 1024 ** 2)} MiB`;
}

function withTimeout(signal: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

function backoffMs(attempt: number): number {
  return Math.min(8000, 500 * 2 ** (attempt - 1)) + Math.random() * 250;
}

function retryable(error: unknown): boolean {
  if (error instanceof ApiError) return error.retryable ?? RETRYABLE_STATUS.has(error.status);
  return isNetworkFailure(error);
}

// A job POST is only repeated when the server certainly started nothing: it said so, or the connection never opened
function nothingCreated(error: unknown): boolean {
  if (error instanceof ApiError) return error.status === 408 || error.status === 429;
  return neverSent(error);
}

function neverSent(error: unknown): boolean {
  const cause = error instanceof Error ? (error.cause as NodeJS.ErrnoException | undefined) : undefined;
  return NOT_CONNECTED.has(cause?.code ?? "");
}

function isNetworkFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError") return true;
  if (error.name === "TypeError" && (error.cause !== undefined || error.message === "fetch failed" || error.message === "terminated")) return true;

  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && /^(ECONN|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR)/.test(code);
}

function parseObject(text: string): Body | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Body) : null;
  } catch {
    return null;
  }
}

function requestIdOf(value: unknown): string | undefined {
  return typeof value === "string" && REQUEST_ID.test(value) ? value : undefined;
}

function isJob(value: unknown): value is Job {
  return typeof value === "object" && value !== null && typeof (value as Job).id === "string" && typeof (value as Job).status === "string";
}

function jobFrom({ data, requestId }: Answer, endpoint: string): Job {
  const job = data?.job;
  if (!isJob(job)) throw badResponse("the response has no job", endpoint, requestId);

  // Only a finished job has to list its files, and few enough that one answer can't fan out into thousands of downloads
  const outputs: unknown = job.outputs ?? (job.status === "succeeded" ? undefined : {});
  if (!isOutputMap(outputs)) throw badResponse("the job's outputs are not a map of names to links", endpoint, requestId);

  const count = Object.keys(outputs).length;
  if (count > MAX_OUTPUTS) throw refused("TOO_MANY_OUTPUTS", `the job lists ${count} files, and reelsdk-mcp saves at most ${MAX_OUTPUTS}`, endpoint, requestId);
  return { ...job, outputs };
}

function isOutputMap(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((url) => typeof url === "string");
}

function badResponse(message: string, endpoint: string, requestId: string | undefined): ApiError {
  return new ApiError(502, "BAD_RESPONSE", message, endpoint, { requestId });
}

// Status 0: reelsdk-mcp turned the answer down itself, so there is no HTTP status to show
function refused(code: string, message: string, endpoint: string, requestId: string | undefined): ApiError {
  return new ApiError(0, code, message, endpoint, { requestId });
}

function isIssue(value: unknown): value is Issue {
  return typeof value === "object" && value !== null && typeof (value as Issue).message === "string";
}

function apiError(response: Response, data: Body | null, text: string, endpoint: string, requestId: string | undefined): ApiError {
  const body = (typeof data?.error === "object" && data.error !== null ? data.error : {}) as Body;
  const code = typeof body.code === "string" ? body.code : `HTTP_${response.status}`;
  const snippet = text && !text.trimStart().startsWith("<") ? `: ${text.slice(0, 200)}` : "";
  const message = typeof body.message === "string" ? body.message : `HTTP ${response.status} ${response.statusText}${snippet}`;
  const issues = Array.isArray(body.issues) ? body.issues.filter(isIssue) : [];
  return new ApiError(response.status, code, message, endpoint, { issues, retryAfterS: retryAfter(response.headers.get("retry-after")), requestId });
}

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, (date - Date.now()) / 1000) : undefined;
}
