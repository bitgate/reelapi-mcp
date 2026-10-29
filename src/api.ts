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

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly endpoint: string,
    readonly issues: Issue[] = [],
    readonly retryAfterS?: number,
  ) {
    super(message);
    this.name = "ApiError";
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
  downloadMs: number;
}

export interface OutputBudget {
  left: number;
}

export interface UploadFile {
  handle: FileHandle;
  size: number;
}

const MAX_ATTEMPTS = 4;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const USER_AGENT = `reelsdk-mcp/${VERSION} node/${process.versions.node}`;

// reelsdk stores at most 2 GiB of files per job, and none of its JSON answers comes near 8 MiB
const LIMITS: Limits = { outputBytes: 2 * 1024 ** 3, answerBytes: 8 * 1024 ** 2, downloadMs: 30 * 60_000 };

interface Call {
  method: "GET" | "POST";
  path: string;
  query: Record<string, string | number>;
  json?: unknown;
  file?: UploadFile;
  signal: AbortSignal;
  timeoutMs: number;
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

  // wait=0 returns the job id at once; the long waits happen on GET, which is safe to retry
  async createJob(op: string, body: Body, signal: AbortSignal): Promise<Job> {
    const path = `/v1/${op}`;
    return jobFrom(await this.#call({ method: "POST", path, query: { wait: 0 }, json: body, signal, timeoutMs: 60_000 }), path);
  }

  async getJob(id: string, waitS: number, signal: AbortSignal): Promise<Job> {
    const path = `/v1/jobs/${encodeURIComponent(id)}`;
    return jobFrom(await this.#call({ method: "GET", path, query: { wait: waitS }, signal, timeoutMs: (waitS + 30) * 1000 }), path);
  }

  async upload(filename: string, file: UploadFile, signal: AbortSignal): Promise<Upload> {
    const data = await this.#call({ method: "POST", path: "/v1/uploads", query: { filename }, file, signal, timeoutMs: 30 * 60_000 });
    if (typeof data?.url !== "string") throw new ApiError(502, "BAD_RESPONSE", "the upload response has no url", "/v1/uploads");
    return data as unknown as Upload;
  }

  outputBudget(): OutputBudget {
    return { left: this.#limits.outputBytes };
  }

  async download(url: string, destination: string, signal: AbortSignal, budget = this.outputBudget()): Promise<number> {
    const deadline = withTimeout(signal, this.#limits.downloadMs);
    const tooLarge = () => new ApiError(413, "OUTPUT_TOO_LARGE", `the job's files are over ${sizeOf(this.#limits.outputBytes)}, more than reelsdk stores`, url);

    return this.#retrying(`GET ${url}`, deadline, async () => {
      const response = await this.#fetchOutput(url, deadline);
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new ApiError(response.status, `HTTP_${response.status}`, `download failed with HTTP ${response.status}`, url);
      }
      if (Number(response.headers.get("content-length")) > budget.left) {
        await response.body.cancel();
        throw tooLarge();
      }

      // We count every byte against the job's budget, whatever Content-Length said, and hand them back if this attempt fails
      let bytes = 0;
      async function* counted(body: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
        for await (const chunk of body) {
          bytes += chunk.byteLength;
          budget.left -= chunk.byteLength;
          if (budget.left < 0) throw tooLarge();
          yield chunk;
        }
      }

      try {
        await saveExclusive(counted(response.body), destination);
        return bytes;
      } catch (error) {
        budget.left += bytes;
        throw error;
      }
    });
  }

  // Files only come from the API's own /f/ links, every redirect hop is held to the same rule, and the key is never sent along
  async #fetchOutput(url: string, signal: AbortSignal): Promise<Response> {
    let next = url;
    for (let hops = 0; ; hops++) {
      if (!this.#isOutputUrl(next)) throw new Error(`refused ${next}: files only download from ${this.baseUrl}/f/`);

      const response = await fetch(next, { headers: { "user-agent": USER_AGENT }, redirect: "manual", signal });
      const location = response.headers.get("location");
      if (!REDIRECT_STATUS.has(response.status) || location === null) return response;

      await response.body?.cancel();
      if (hops === MAX_REDIRECTS) throw new Error(`refused ${url}: more than ${MAX_REDIRECTS} redirects`);
      next = new URL(location, next).href;
    }
  }

  #isOutputUrl(url: string): boolean {
    if (!URL.canParse(url)) return false;

    const target = new URL(url);
    const base = new URL(this.baseUrl);
    return target.origin === base.origin && target.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/f/`);
  }

  async #call(call: Call): Promise<Body | null> {
    const query = new URLSearchParams(Object.entries(call.query).map(([key, value]): [string, string] => [key, String(value)]));
    const url = `${this.baseUrl}${call.path}?${query}`;

    return this.#retrying(`${call.method} ${call.path}`, call.signal, async () => {
      const response = await fetch(url, {
        method: call.method,
        headers: this.#headers(call),
        body: call.file ? fileBody(call.file) : call.json === undefined ? undefined : JSON.stringify(call.json),
        duplex: "half",
        signal: withTimeout(call.signal, call.timeoutMs),
      });

      // A failed job comes back as 422/500 with the job attached: that's an answer, not a transport error
      const text = await answerText(response, this.#limits.answerBytes, call.path);
      const data = parseObject(text);
      if (response.ok || isJob(data?.job)) return data;

      throw apiError(response, data, text, call.path);
    });
  }

  #headers(call: Call): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      accept: "application/json",
      "user-agent": USER_AGENT,
    };
    if (call.json !== undefined) headers["content-type"] = "application/json";
    if (call.file !== undefined) {
      headers["content-type"] = "application/octet-stream";
      headers["content-length"] = String(call.file.size);
    }
    return headers;
  }

  async #retrying<T>(label: string, signal: AbortSignal, attempt: () => Promise<T>): Promise<T> {
    for (let n = 1; ; n++) {
      try {
        return await attempt();
      } catch (error) {
        if (signal.aborted) throw error;

        const retryable = error instanceof ApiError ? RETRYABLE_STATUS.has(error.status) : isNetworkFailure(error);
        if (!retryable) throw error;
        if (n >= MAX_ATTEMPTS) {
          if (error instanceof ApiError) throw error;
          throw new NetworkError(`Couldn't reach ${this.baseUrl} after ${n} attempts (${errorMessage(error)})`, { cause: error });
        }

        const waitMs = error instanceof ApiError && error.retryAfterS !== undefined ? Math.min(error.retryAfterS * 1000, 20_000) : backoffMs(n);
        log(`${label} failed (${errorMessage(error)}), retry ${n}/${MAX_ATTEMPTS - 1} in ${Math.round(waitMs)} ms`);
        await delay(waitMs, undefined, { signal });
      }
    }
  }
}

// Every attempt re-reads the file from the start through the handle we checked, never by its name
function fileBody(file: UploadFile): RequestInit["body"] {
  return Readable.toWeb(file.handle.createReadStream({ start: 0, end: file.size - 1, autoClose: false })) as unknown as RequestInit["body"];
}

// We read at most maxBytes of an answer, whatever its Content-Length claims
async function answerText(response: Response, maxBytes: number, endpoint: string): Promise<string> {
  const tooLarge = () => new ApiError(413, "RESPONSE_TOO_LARGE", `the answer is over ${sizeOf(maxBytes)}`, endpoint);
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

function sizeOf(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${bytes / 1024 ** 3} GiB` : `${Math.ceil(bytes / 1024 ** 2)} MiB`;
}

function withTimeout(signal: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

function backoffMs(attempt: number): number {
  return Math.min(8000, 500 * 2 ** (attempt - 1)) + Math.random() * 250;
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

function isJob(value: unknown): value is Job {
  return typeof value === "object" && value !== null && typeof (value as Job).id === "string" && typeof (value as Job).status === "string";
}

function jobFrom(data: Body | null, endpoint: string): Job {
  if (!isJob(data?.job)) throw new ApiError(502, "BAD_RESPONSE", "the response has no job", endpoint);
  return data.job;
}

function isIssue(value: unknown): value is Issue {
  return typeof value === "object" && value !== null && typeof (value as Issue).message === "string";
}

function apiError(response: Response, data: Body | null, text: string, endpoint: string): ApiError {
  const body = (typeof data?.error === "object" && data.error !== null ? data.error : {}) as Body;
  const code = typeof body.code === "string" ? body.code : `HTTP_${response.status}`;
  const snippet = text && !text.trimStart().startsWith("<") ? `: ${text.slice(0, 200)}` : "";
  const message = typeof body.message === "string" ? body.message : `HTTP ${response.status} ${response.statusText}${snippet}`;
  const issues = Array.isArray(body.issues) ? body.issues.filter(isIssue) : [];
  return new ApiError(response.status, code, message, endpoint, issues, retryAfter(response.headers.get("retry-after")));
}

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, (date - Date.now()) / 1000) : undefined;
}
