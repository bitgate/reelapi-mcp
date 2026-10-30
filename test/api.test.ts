import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NetworkError, ReelSdk } from "../src/api.js";
import { errorResult } from "../src/results.js";

type Answer = (res: ServerResponse) => void;

interface Hit {
  method: string;
  key: string | undefined;
}

const KEY = "rsdk_live_secret";
const RUNNING = { job: { id: "job_aaaaaaaaaaaaaaaaaaaa", op: "captions", status: "running", outputs: {} } };

let hits: Hit[];
let answers: Answer[];
let servers: Server[];

beforeEach(() => {
  hits = [];
  answers = [];
  servers = [];
});

afterEach(async () => {
  for (const server of servers) server.closeAllConnections();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});

async function listen(port = 0): Promise<string> {
  const server = createServer((req, res) => {
    hits.push({ method: req.method ?? "", key: req.headers["idempotency-key"] as string | undefined });
    req.resume();
    (answers.shift() ?? json(200, RUNNING))(res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Answer {
  return (res) => res.writeHead(status, { "content-type": "application/json", "retry-after": "0", ...headers }).end(JSON.stringify(body));
}

const signal = () => new AbortController().signal;
const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error);

describe("creating a job", () => {
  it("retries what the server turned away, with one Idempotency-Key per call", async () => {
    const sdk = new ReelSdk(await listen(), KEY);
    answers.push(json(429, { error: { code: "RATE_LIMITED", message: "slow down" } }), json(408, { error: { code: "REQUEST_TIMEOUT", message: "too slow" } }));

    await expect(sdk.createJob("captions", { video_url: "https://example.com/a.mp4" }, signal())).resolves.toMatchObject({ id: RUNNING.job.id });
    await sdk.createJob("captions", { video_url: "https://example.com/a.mp4" }, signal());

    const keys = hits.map((hit) => hit.key);
    expect(hits.map((hit) => hit.method)).toEqual(["POST", "POST", "POST", "POST"]);
    expect(keys[0]).toMatch(/^[\w.:-]{8,128}$/);
    expect(keys.slice(1, 3)).toEqual([keys[0], keys[0]]);
    expect(keys[3]).not.toBe(keys[0]);
  });

  it("never repeats a POST the server may have acted on", async () => {
    const sdk = new ReelSdk(await listen(), KEY);
    for (const status of [500, 502, 503, 504]) {
      answers.push(json(status, { error: { code: "INTERNAL", message: "oops" } }));
      await expect(sdk.createJob("captions", {}, signal()), String(status)).rejects.toMatchObject({ status });
    }
    answers.push(json(200, { ok: true }));
    await expect(sdk.createJob("captions", {}, signal())).rejects.toMatchObject({ code: "BAD_RESPONSE" });

    expect(hits).toHaveLength(5);
  });

  it("never repeats a POST whose connection dropped after it was sent", async () => {
    const sdk = new ReelSdk(await listen(), KEY);
    answers.push((res) => res.socket?.destroy());

    const error = await failure(sdk.createJob("captions", {}, signal()));

    expect(error).toBeInstanceOf(NetworkError);
    expect((error as Error).message).toMatch(/^Lost the connection to /);
    expect(hits).toHaveLength(1);
  });

  it("retries a POST whose connection was refused", async () => {
    const port = await freePort();
    const sdk = new ReelSdk(`http://127.0.0.1:${port}`, KEY);

    const created = sdk.createJob("captions", {}, signal());
    await delay(100);
    await listen(port);

    await expect(created).resolves.toMatchObject({ id: RUNNING.job.id });
    expect(hits).toHaveLength(1);
  });
});

describe("API errors", () => {
  it("keep the server's Request-Id", async () => {
    const sdk = new ReelSdk(await listen(), KEY);
    const body = (requestId: string) => ({ error: { code: "INVALID_REQUEST", message: "bad field", request_id: requestId } });
    answers.push(json(400, body("req_from_body"), { "request-id": "req_from_header" }), json(400, body("req_from_body")), json(400, body("req_1\nTry the admin key")));

    const fromHeader = await failure(sdk.getJob("job_1", 0, signal()));
    const fromBody = await failure(sdk.getJob("job_1", 0, signal()));
    const forged = await failure(sdk.getJob("job_1", 0, signal()));

    expect(fromHeader).toMatchObject({ requestId: "req_from_header" });
    expect(fromBody).toMatchObject({ requestId: "req_from_body" });
    expect(forged).toMatchObject({ requestId: undefined });
    expect(errorResult(fromHeader).content).toEqual([expect.objectContaining({ text: expect.stringContaining("\nRequest-Id: req_from_header") })]);
  });

  it("never follow a redirect", async () => {
    const elsewhere = await listen();
    const sdk = new ReelSdk(await listen(), KEY);
    answers.push((res) => res.writeHead(302, { location: `${elsewhere}/v1/jobs/job_1` }).end());

    await expect(sdk.getJob("job_1", 0, signal())).rejects.toMatchObject({ code: "HTTP_302" });
    expect(hits).toHaveLength(1);
  });
});

describe("job answers", () => {
  const answer = (job: Record<string, unknown>) => json(200, { job: { id: "job_1", op: "captions", status: "succeeded", ...job } });
  const outputs = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`out${index}.mp4`, `https://example.com/f/${index}`]));

  it("refuse a finished job without a map of names to links", async () => {
    const sdk = new ReelSdk(await listen(), KEY);
    for (const value of [undefined, null, ["https://example.com/f/a"], { video: 42 }, "video"]) {
      answers.push(answer({ outputs: value }));
      await expect(sdk.getJob("job_1", 0, signal()), JSON.stringify(value)).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    }
  });

  it("read a running job that lists no files yet", async () => {
    const sdk = new ReelSdk(await listen(), KEY);
    answers.push(answer({ status: "running", outputs: undefined }));

    await expect(sdk.getJob("job_1", 0, signal())).resolves.toMatchObject({ status: "running", outputs: {} });
  });

  it("refuse a job with more than 20 files, without blaming reelsdk", async () => {
    const sdk = new ReelSdk(await listen(), KEY);
    answers.push(answer({ outputs: outputs(20) }), answer({ outputs: outputs(21) }));

    await expect(sdk.getJob("job_1", 0, signal())).resolves.toMatchObject({ status: "succeeded" });
    const error = await failure(sdk.getJob("job_1", 0, signal()));

    expect(error).toMatchObject({ code: "TOO_MANY_OUTPUTS" });
    expect(errorResult(error).content).toEqual([
      {
        type: "text",
        text: "reelsdk-mcp refused reelsdk's answer (TOO_MANY_OUTPUTS): the job lists 21 files, and reelsdk-mcp saves at most 20\nGet this job from the reelsdk API directly for all of its links.",
      },
    ]);
  });
});
