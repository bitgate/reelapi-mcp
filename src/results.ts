import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ApiError, NetworkError, type Job } from "./api.js";
import { elapsedSeconds, type SavedFile, type ToolContext } from "./context.js";
import { errorMessage, log } from "./log.js";

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

const HINTS: Record<string, string> = {
  INVALID_REQUEST: "Fix the fields listed above and call the tool again.",
  UNAUTHORIZED: "The API key was rejected. Check REELSDK_KEY in this MCP server's config (rsdk_live_ followed by 32 characters) and restart the server.",
  PAYLOAD_TOO_LARGE: "Uploads are capped at 100 MB. Host the file somewhere public and pass its URL instead (URL inputs can be up to 500 MB).",
  UNSUPPORTED_LANGUAGE: "Use one of en, es, fr, ja, zh or ko.",
  CONTENT_REJECTED: "The image safety filter flagged the scenes. Try a less graphic topic or script.",
  INVALID_SPEC: "The render engine rejected the parameters. Check the values and try again.",
  INPUT_FETCH_FAILED: "reelsdk couldn't download an input. Pass a local file path instead (it gets uploaded), or make sure the URL is public.",
  INPUT_TOO_LARGE: "An input is too big (500 MB per file, 1 GB per job, 15 min of media). Trim or compress it first.",
  INPUT_UNSUPPORTED: "An input isn't a readable image, video or audio file.",
  TRANSCRIBE_FAILED: "Speech-to-text failed. Make sure the audio has clear speech, or set language explicitly.",
  FFMPEG_FAILED: "ffmpeg exited with an error; the message above ends with its stderr. Fix the args and try again.",
  OUTPUT_MISSING: "ffmpeg finished without writing every file listed in outputs. Make sure args write exactly those filenames.",
  TIMEOUT: "The job hit its time limit (10 min). Try quality draft or shorter inputs; for run_ffmpeg, a faster preset or a higher timeout_s.",
  BUSY: "reelsdk is at capacity right now. Try again in a minute.",
  DOWNLOAD_TIMEOUT: "The connection stalled or was too slow. The file stays on reelsdk for now: download it from its url.",
  TOO_MANY_OUTPUTS: "Get this job from the reelsdk API directly for all of its links.",
};

const SERVER_HINT = "This failed on reelsdk's side. Try again; if it keeps failing, report the job id.";

function hintFor(code: string, status: number, endpoint?: string): string | undefined {
  if (code === "NOT_FOUND") {
    return endpoint?.startsWith("/v1/jobs/") ? "No job with that id exists for this API key." : `This reelsdk deployment doesn't support ${endpoint ?? "that endpoint"} yet.`;
  }
  if (status === 429) return "reelsdk is rate limiting this key. Wait a minute, then try again.";
  return HINTS[code] ?? (status >= 500 ? SERVER_HINT : undefined);
}

export function textResult(summary: string, details: Record<string, unknown>, isError = false): CallToolResult {
  const content: CallToolResult["content"] = [{ type: "text", text: `${summary}\n${JSON.stringify(details, null, 2)}` }];
  return isError ? { content, isError } : { content };
}

export function succeededResult(job: Job, files: SavedFile[], ctx: ToolContext): CallToolResult {
  const saved = files.filter((file) => file.path);
  const main = saved.find((file) => file.name === "video") ?? saved[0];
  const failed = files.length - saved.length;

  let summary = main?.path ? `Done: ${main.path}` : "Done, but nothing could be saved locally; use the URLs below.";
  if (main && saved.length > 1) summary += ` (+${saved.length - 1} more files)`;
  if (main && failed > 0) summary += `. ${failed} file(s) failed to download, see files[].error.`;

  return textResult(summary, {
    status: "succeeded",
    job_id: job.id,
    files: files.map(({ name, path, url, bytes, error }) => ({ name, path, url, bytes, error })),
    duration_s: job.duration_s,
    usage: job.usage,
    result: job.result ?? undefined,
    elapsed_s: elapsedSeconds(ctx),
  });
}

export function runningResult(job: Job, ctx: ToolContext): CallToolResult {
  const stage = job.stage ? ` (${job.stage})` : "";
  const age = jobAge(job);
  return textResult(
    `Job ${job.id} is still ${job.status}${stage}${age === undefined ? "" : `, started ${age} s ago`}. Call get_job with job_id "${job.id}" to keep waiting; it saves the files when the job is done.`,
    { status: job.status, job_id: job.id, stage: job.stage ?? undefined, elapsed_s: elapsedSeconds(ctx) },
  );
}

export function jobAge(job: Job): number | undefined {
  const created = Date.parse(job.created_at);
  return Number.isFinite(created) ? Math.max(0, Math.round((Date.now() - created) / 1000)) : undefined;
}

export function failedResult(job: Job): CallToolResult {
  const code = job.error?.code ?? "FAILED";
  return textResult(
    `${job.op} job ${job.id} failed: ${code}: ${job.error?.message ?? "no details"}`,
    { status: "failed", job_id: job.id, error: job.error, hint: hintFor(code, 500) },
    true,
  );
}

export function fileError(error: unknown): string {
  const lines = [`download failed: ${errorMessage(error)}`];
  if (error instanceof ApiError) {
    const hint = HINTS[error.code];
    if (hint) lines.push(hint);
    if (error.requestId) lines.push(`Request-Id: ${error.requestId}`);
  }
  return lines.join("\n");
}

export function errorResult(error: unknown): CallToolResult {
  return { content: [{ type: "text", text: describeError(error) }], isError: true };
}

function describeError(error: unknown): string {
  if (error instanceof ToolError) return error.message;

  if (error instanceof ApiError) {
    const lines = [
      error.status === 0
        ? `reelsdk-mcp refused reelsdk's answer (${error.code}): ${error.message}`
        : error.issues.length > 0
          ? `reelsdk rejected the request (HTTP ${error.status} ${error.code}):`
          : `reelsdk returned HTTP ${error.status} ${error.code}: ${error.message}`,
      ...error.issues.map((issue) => `- ${issue.path || "body"}: ${issue.message}`),
    ];
    const hint = hintFor(error.code, error.status, error.endpoint);
    if (hint) lines.push(hint);
    if (error.requestId) lines.push(`Request-Id: ${error.requestId}`);
    return lines.join("\n");
  }

  if (error instanceof NetworkError) return `${error.message}. Check the network connection and REELSDK_BASE_URL, then try again.`;
  if (error instanceof Error && error.name === "AbortError") return "Cancelled.";

  log("unexpected error", error);
  return `Unexpected error in reelsdk-mcp: ${errorMessage(error)}`;
}
