import { createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { errorMessage, log } from "./log.js";
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

const MAX_ATTEMPTS = 4;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const USER_AGENT = `reelsdk-mcp/${VERSION} node/${process.versions.node}`;

interface Call {
  method: "GET" | "POST";
  path: string;
  query: Record<string, string | number>;
  json?: unknown;
  blob?: Blob;
  signal: AbortSignal;
  timeoutMs: number;
}

type Body = Record<string, unknown>;

export class ReelSdk {
  constructor(
    readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  // wait=0 returns the job id at once; the long waits happen on GET, which is safe to retry
  async createJob(op: string, body: Body, signal: AbortSignal): Promise<Job> {
    const path = `/v1/${op}`;
    return jobFrom(await this.#call({ method: "POST", path, query: { wait: 0 }, json: body, signal, timeoutMs: 60_000 }), path);
  }

  async getJob(id: string, waitS: number, signal: AbortSignal): Promise<Job> {
    const path = `/v1/jobs/${encodeURIComponent(id)}`;
    return jobFrom(await this.#call({ method: "GET", path, query: { wait: waitS }, signal, timeoutMs: (waitS + 30) * 1000 }), path);
  }

  async upload(filename: string, blob: Blob, signal: AbortSignal): Promise<Upload> {
    const data = await this.#call({ method: "POST", path: "/v1/uploads", query: { filename }, blob, signal, timeoutMs: 30 * 60_000 });
    if (typeof data?.url !== "string") throw new ApiError(502, "BAD_RESPONSE", "the upload response has no url", "/v1/uploads");
    return data as unknown as Upload;
  }

  async download(url: string, destination: string, signal: AbortSignal): Promise<number> {
    return this.#retrying(`GET ${url}`, signal, async () => {
      const response = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: withTimeout(signal, 30 * 60_000) });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new ApiError(response.status, `HTTP_${response.status}`, `download failed with HTTP ${response.status}`, url);
      }

      const partial = `${destination}.part`;
      try {
        await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
        await rename(partial, destination);
      } catch (error) {
        await rm(partial, { force: true });
        throw error;
      }

      return (await stat(destination)).size;
    });
  }

  async #call(call: Call): Promise<Body | null> {
    const query = new URLSearchParams(Object.entries(call.query).map(([key, value]): [string, string] => [key, String(value)]));
    const url = `${this.baseUrl}${call.path}?${query}`;

    return this.#retrying(`${call.method} ${call.path}`, call.signal, async () => {
      const response = await fetch(url, {
        method: call.method,
        headers: this.#headers(call),
        body: call.json === undefined ? call.blob : JSON.stringify(call.json),
        signal: withTimeout(call.signal, call.timeoutMs),
      });

      // A failed job comes back as 422/500 with the job attached: that's an answer, not a transport error
      const text = await response.text();
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
    if (call.blob !== undefined) headers["content-type"] = "application/octet-stream";
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
