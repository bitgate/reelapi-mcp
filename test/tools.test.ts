import { mkdtemp, readdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES } from "../src/media.js";
import { createServer } from "../src/server.js";
import { GOOD_KEY, startFakeApi, type FakeApi } from "./fake-api.js";

interface SavedFile {
  name: string;
  path?: string;
  url: string;
}

interface Outcome {
  isError: boolean;
  text: string;
  json: { status?: string; job_id?: string; files?: SavedFile[]; hint?: string; result?: { title?: string } };
}

const MP4 = Buffer.concat([Buffer.from("\0\0\0\x18ftypisom\0\0\x02\0isomiso2", "latin1"), Buffer.from("local video bytes")]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const MP3 = Buffer.from("ID3\x04\0\0\0\0\0\0", "latin1");

let api: FakeApi;
let dir: string;

beforeEach(async () => {
  api = await startFakeApi();
  dir = await mkdtemp(path.join(os.tmpdir(), "reelsdk-mcp-"));
  await writeFile(path.join(dir, "clip.mp4"), MP4);
});

afterEach(async () => {
  await api.close();
  await rm(dir, { recursive: true, force: true });
});

async function connect(env: Record<string, string | undefined> = {}): Promise<Client> {
  const server = createServer({ REELSDK_KEY: GOOD_KEY, REELSDK_BASE_URL: api.baseUrl, CLAUDE_PROJECT_DIR: dir, REELSDK_WAIT_S: "30", ...env });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>, onprogress?: (message: string) => void): Promise<Outcome> {
  const options = onprogress ? { onprogress: (progress: { message?: string }) => onprogress(progress.message ?? "") } : undefined;
  const result = (await client.callTool({ name, arguments: args }, undefined, options)) as CallToolResult;
  const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
  const start = text.indexOf("\n{");
  return { isError: result.isError === true, text, json: start >= 0 ? JSON.parse(text.slice(start + 1)) : {} };
}

const output = (...parts: string[]) => path.join(dir, "reelsdk-output", ...parts);
const saved = (outcome: Outcome, name: string) => outcome.json.files?.find((file) => file.name === name)?.path;
const uploadUrl = (filename: string) => api.uploads.find((upload) => upload.filename === filename)?.url;

describe("add_captions", () => {
  it("uploads a local file, waits for the job and saves every output", async () => {
    const client = await connect();
    const progress: string[] = [];
    const outcome = await call(client, "add_captions", { video: "clip.mp4", preset: "karaoke", highlight_color: "#00FF00" }, (message) => progress.push(message));

    expect(outcome.isError).toBe(false);
    expect(api.uploads).toMatchObject([{ filename: "clip.mp4", bytes: MP4.length }]);
    expect(api.created).toEqual([{ op: "captions", body: { video_url: uploadUrl("clip.mp4"), style: { preset: "karaoke", highlight_color: "#00FF00" } } }]);

    expect(saved(outcome, "video")).toBe(output("clip-captioned.mp4"));
    expect(await readFile(output("clip-captioned.mp4"), "utf8")).toBe(`bytes of /f/out/${outcome.json.job_id}/video.mp4`);
    expect(await readdir(output("captions"))).toEqual(expect.arrayContaining(["clip-captioned.srt", "clip-captioned.transcript.json"]));
    expect(progress.length).toBeGreaterThan(1);
  });

  it("never overwrites an earlier result and reuses the upload", async () => {
    const client = await connect();
    await call(client, "add_captions", { video: "clip.mp4" });
    const second = await call(client, "add_captions", { video: "./clip.mp4" });

    expect(saved(second, "video")).toBe(output("clip-captioned-2.mp4"));
    expect(saved(second, "srt")).toBe(output("captions", "clip-captioned-2.srt"));
    expect(api.uploads).toHaveLength(1);
  });
});

describe("other tools", () => {
  it("make_slideshow spreads duration_s over the images and uploads local audio", async () => {
    const files: [string, Buffer][] = [["a.jpg", JPEG], ["b.jpg", JPEG], ["song.mp3", MP3]];
    await Promise.all(files.map(([name, head]) => writeFile(path.join(dir, name), Buffer.concat([head, Buffer.from(name)]))));
    const client = await connect();
    const outcome = await call(client, "make_slideshow", {
      images: ["a.jpg", "b.jpg", "https://example.com/c.jpg"],
      duration_s: 10,
      transition: "slideleft",
      transition_s: 0.8,
      voiceover_text: "Hello there",
      voice: "orion",
      music: "song.mp3",
      music_volume: 0.3,
      captions: "bold",
    });

    expect(outcome.isError).toBe(false);
    expect(api.created[0]?.body).toEqual({
      images: [uploadUrl("a.jpg"), uploadUrl("b.jpg"), "https://example.com/c.jpg"],
      seconds_per_image: 3.333,
      transition: { type: "slideleft", seconds: 0.8 },
      voiceover: { text: "Hello there", voice: "orion" },
      music: { url: uploadUrl("song.mp3"), volume: 0.3 },
      captions: "bold",
    });
    expect(saved(outcome, "video")).toBe(output("slideshow.mp4"));
  });

  it("run_ffmpeg uploads named inputs and saves outputs under their own names", async () => {
    const client = await connect();
    const args = ["-i", "in.mp4", "-vf", "crop=ih*9/16:ih", "out.mp4"];
    const outcome = await call(client, "run_ffmpeg", { inputs: { "in.mp4": "clip.mp4" }, args, outputs: ["out.mp4"] });

    expect(api.created[0]?.body).toEqual({ inputs: { "in.mp4": uploadUrl("clip.mp4") }, args, outputs: ["out.mp4"] });
    expect(saved(outcome, "out.mp4")).toBe(output("out.mp4"));
  });

  it("make_short needs a topic or a script", async () => {
    const client = await connect();
    const outcome = await call(client, "make_short", { style: "anime" });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("topic");
    expect(api.requests).toHaveLength(0);
  });
});

describe("get_job", () => {
  it("hands back a job id when the wait runs out, then saves the files once done", async () => {
    api.scenario.pollsUntilDone = 2;
    const client = await connect({ REELSDK_WAIT_S: "0" });

    const started = await call(client, "make_short", { topic: "the ghost ship Mary Celeste", captions: "none" });
    expect(started.json.status).toBe("running");
    expect(started.text).toContain("get_job");
    expect(api.created[0]?.body).toEqual({ topic: "the ghost ship Mary Celeste", captions: false });

    const pending = await call(client, "get_job", { job_id: started.json.job_id });
    expect(pending.json.status).toBe("running");

    const done = await call(client, "get_job", { job_id: started.json.job_id });
    expect(done.json.status).toBe("succeeded");
    expect(done.json.result?.title).toBe("The Ghost Ship");
    expect(saved(done, "video")).toBe(output("short-the-ghost-ship.mp4"));
    expect(saved(done, "poster")).toBe(output("short-the-ghost-ship-poster.jpg"));

    const requests = api.requests.length;
    const again = await call(client, "get_job", { job_id: started.json.job_id });
    expect(again.json.status).toBe("succeeded");
    expect(api.requests).toHaveLength(requests);
  });
});

describe("errors", () => {
  it("lists the fields the API rejected", async () => {
    api.scenario.createError = {
      status: 400,
      body: { error: { code: "INVALID_REQUEST", message: "size: unsupported size", issues: [{ path: "size", message: "unsupported size" }] } },
    };
    const client = await connect();
    const outcome = await call(client, "make_slideshow", { images: ["https://example.com/a.jpg"], size: "7x7" });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("- size: unsupported size");
  });

  it("explains a rejected key", async () => {
    const client = await connect({ REELSDK_KEY: "rsdk_live_wrong" });
    const outcome = await call(client, "make_slideshow", { images: ["https://example.com/a.jpg"] });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("401");
    expect(outcome.text).toContain("REELSDK_KEY");
  });

  it("asks for a key before calling the API", async () => {
    const client = await connect({ REELSDK_KEY: undefined });
    const outcome = await call(client, "add_captions", { video: "clip.mp4" });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("REELSDK_KEY is not set");
    expect(api.requests).toHaveLength(0);
  });

  it("reports a missing file with the resolved path", async () => {
    const client = await connect();
    const outcome = await call(client, "add_captions", { video: "nope.mp4" });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain(`File not found: ${path.join(dir, "nope.mp4")}`);
  });

  it("refuses files over the upload cap without sending them", async () => {
    await truncate(path.join(dir, "clip.mp4"), MAX_UPLOAD_BYTES + 1);
    const client = await connect();
    const outcome = await call(client, "add_captions", { video: "clip.mp4" });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("100 MB");
    expect(api.requests).toHaveLength(0);
  });

  it("rejects URLs reelsdk can't reach", async () => {
    const client = await connect();
    const outcome = await call(client, "add_captions", { video: "http://localhost:3000/clip.mp4" });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("Pass the local file path instead");
  });

  it("retries server errors", async () => {
    api.scenario.failGets = 2;
    const client = await connect();
    const outcome = await call(client, "add_captions", { video: "https://example.com/clip.mp4" });

    expect(outcome.isError).toBe(false);
    expect(outcome.json.status).toBe("succeeded");
  });

  it("explains failed jobs", async () => {
    api.scenario.failJob = { code: "FFMPEG_FAILED", message: "ffmpeg exited with code 1: Unrecognized option 'nope'" };
    const client = await connect();
    const outcome = await call(client, "run_ffmpeg", { inputs: { "in.mp4": "clip.mp4" }, args: ["-nope"], outputs: ["out.mp4"] });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("FFMPEG_FAILED");
    expect(outcome.json.hint).toContain("Fix the args");
  });
});
