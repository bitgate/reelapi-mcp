import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const GOOD_KEY = "rsdk_live_0123456789abcdefghijABCDEFGHIJkl";

type Body = Record<string, unknown>;
type JobStatus = "running" | "succeeded" | "failed";

interface FakeJob {
  id: string;
  op: string;
  body: Body;
  polls: number;
}

export interface Scenario {
  pollsUntilDone: number;
  failGets: number;
  createError?: { status: number; body: Body };
  failJob?: { code: string; message: string };
  outputs?: (file: (name: string) => string) => Record<string, string>;
  finished?: Body;
  onFile?: (pathname: string, res: ServerResponse) => Promise<boolean | void> | boolean | void;
}

export interface FakeApi {
  baseUrl: string;
  scenario: Scenario;
  requests: string[];
  uploads: { filename: string; bytes: number; url: string }[];
  created: { op: string; body: Body }[];
  downloads: { path: string; authorization?: string }[];
  close(): Promise<void>;
}

export async function startFakeApi(): Promise<FakeApi> {
  const jobs = new Map<string, FakeJob>();
  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => send(res, 500, { error: { code: "INTERNAL", message: String(error) } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const api: FakeApi = {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    scenario: { pollsUntilDone: 1, failGets: 0 },
    requests: [],
    uploads: [],
    created: [],
    downloads: [],
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", api.baseUrl);
    const body = await readBody(req);
    api.requests.push(`${req.method} ${url.pathname}`);

    if (url.pathname.startsWith("/f/")) {
      api.downloads.push({ path: url.pathname, authorization: req.headers.authorization });
      if (await api.scenario.onFile?.(url.pathname, res)) return;
      return send(res, 200, `bytes of ${url.pathname}`);
    }
    if (req.headers.authorization !== `Bearer ${GOOD_KEY}`) return send(res, 401, { error: { code: "UNAUTHORIZED", message: "invalid API key" } });

    if (req.method === "POST" && url.pathname === "/v1/uploads") {
      if (!req.headers["content-length"]) return send(res, 400, { error: { code: "CONTENT_LENGTH_REQUIRED", message: "send a Content-Length" } });
      const filename = url.searchParams.get("filename") ?? "file";
      const upload = { filename, bytes: body.length, url: `${api.baseUrl}/f/in/${token(16)}/${filename}` };
      api.uploads.push(upload);
      return send(res, 201, { url: upload.url, bytes: upload.bytes, content_type: "video/mp4", expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString() });
    }

    const create = /^\/v1\/(captions|slideshow|ffmpeg|shorts)$/.exec(url.pathname);
    if (req.method === "POST" && create) {
      if (api.scenario.createError) return send(res, api.scenario.createError.status, api.scenario.createError.body);
      const job: FakeJob = { id: `job_${token(20)}`, op: create[1]!, body: JSON.parse(body.toString("utf8")) as Body, polls: 0 };
      jobs.set(job.id, job);
      api.created.push({ op: job.op, body: job.body });
      return send(res, 202, { job: view(job, "running") });
    }

    const job = jobs.get(/^\/v1\/jobs\/(job_[a-z0-9]{20})$/.exec(url.pathname)?.[1] ?? "");
    if (req.method === "GET" && job) {
      if (api.scenario.failGets > 0) {
        api.scenario.failGets -= 1;
        return send(res, 503, "upstream unavailable");
      }

      job.polls += 1;
      if (job.polls < api.scenario.pollsUntilDone) return send(res, 202, { job: view(job, "running") });
      if (api.scenario.failJob) return send(res, 422, { error: api.scenario.failJob, job: view(job, "failed") });
      return send(res, 200, { job: view(job, "succeeded") });
    }

    send(res, 404, { error: { code: "NOT_FOUND", message: "not found" } });
  }

  function view(job: FakeJob, status: JobStatus): Body {
    const done = status === "succeeded";
    return {
      id: job.id,
      op: job.op,
      status,
      stage: status === "running" && job.op === "shorts" ? "images" : null,
      created_at: new Date().toISOString(),
      finished_at: status === "running" ? null : new Date().toISOString(),
      outputs: done ? outputsFor(job) : {},
      duration_s: done ? 12.5 : null,
      error: status === "failed" ? (api.scenario.failJob ?? null) : null,
      usage: done ? { output_seconds: 12.5 } : {},
      result: done && job.op === "shorts" ? { title: "The Ghost Ship", post_caption: "Nobody was on board.", scenes: [] } : undefined,
      poll_url: `${api.baseUrl}/v1/jobs/${job.id}`,
      ...(done ? api.scenario.finished : undefined),
    };
  }

  function outputsFor(job: FakeJob): Record<string, string> {
    const file = (name: string) => `${api.baseUrl}/f/out/${job.id}/${name}`;
    if (api.scenario.outputs) return api.scenario.outputs(file);
    if (job.op === "ffmpeg") return Object.fromEntries((job.body.outputs as string[]).map((name) => [name, file(name)]));

    const outputs: Record<string, string> = { video: file("video.mp4") };
    if (job.op === "shorts") outputs.poster = file("poster.jpg");
    outputs.transcript = file("transcript.json");
    outputs.srt = file("captions.srt");
    outputs.vtt = file("captions.vtt");
    if (job.op !== "shorts") outputs.ass = file("captions.ass");
    return outputs;
  }

  return api;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, body: Body | string): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain" : "application/json" });
  res.end(text);
}

function token(length: number): string {
  return Array.from(randomBytes(length), (byte) => "abcdefghijklmnopqrstuvwxyz0123456789"[byte % 36]).join("");
}
