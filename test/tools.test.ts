import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { ReelSdk } from "../src/api.js";
import type { ToolContext } from "../src/context.js";
import { JobRunner } from "../src/jobs.js";
import { MAX_UPLOAD_BYTES, Media } from "../src/media.js";
import { createServer } from "../src/server.js";
import { Workspace } from "../src/workspace.js";
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
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "reelsdk-mcp-")));
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
  return outcomeOf((await client.callTool({ name, arguments: args }, undefined, options)) as CallToolResult);
}

function outcomeOf(result: CallToolResult): Outcome {
  const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
  const start = text.indexOf("\n{");
  return { isError: result.isError === true, text, json: start >= 0 ? JSON.parse(text.slice(start + 1)) : {} };
}

async function tempDir(prefix: string): Promise<string> {
  const created = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  onTestFinished(() => rm(created, { recursive: true, force: true }));
  return created;
}

const context = (): ToolContext => ({ signal: new AbortController().signal, startedAt: Date.now(), progress: () => {} });
const workspace = () => new Workspace({ CLAUDE_PROJECT_DIR: dir }, async () => undefined);

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

describe("what gets uploaded", () => {
  it("uploads a media file from anywhere on this machine", async () => {
    const downloads = path.join(await tempDir("reelsdk-home-"), "Downloads");
    await mkdir(downloads);
    await writeFile(path.join(downloads, "holiday.mp4"), MP4);

    const outcome = await call(await connect(), "upload_file", { path: path.join(downloads, "holiday.mp4") });

    expect(outcome.isError).toBe(false);
    expect(api.uploads).toMatchObject([{ filename: "holiday.mp4", bytes: MP4.length }]);
  });

  it("never uploads a hidden file or anything in a hidden folder, even through a link", async () => {
    const home = await tempDir("reelsdk-home-");
    await mkdir(path.join(home, ".ssh"));
    await mkdir(path.join(home, "vault"));
    await Promise.all([writeFile(path.join(dir, ".env"), MP4), writeFile(path.join(home, ".ssh", "key.mp4"), MP4), writeFile(path.join(home, "vault", "key.mp4"), MP4)]);
    await symlink(path.join(home, ".ssh", "key.mp4"), path.join(dir, "innocent.mp4"));
    await symlink(path.join(home, "vault"), path.join(dir, ".secrets"));

    const client = await connect();
    for (const input of [".env", path.join(home, ".ssh", "key.mp4"), "~/.ssh/id_rsa", "innocent.mp4", ".secrets/key.mp4"]) {
      const outcome = await call(client, "upload_file", { path: input });
      expect(outcome.isError, input).toBe(true);
      expect(outcome.text, input).toContain("hidden");
    }
    expect(api.uploads).toEqual([]);
  });

  it("only uploads files that start like a video, image, audio or subtitle file", async () => {
    await writeFile(path.join(dir, "notes.mp4"), "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n");
    await writeFile(path.join(dir, "settings.json"), '{"token": "secret"}');

    const client = await connect();
    for (const input of ["notes.mp4", "settings.json"]) {
      expect((await call(client, "upload_file", { path: input })).text, input).toContain("doesn't look like a video");
    }
    expect(api.uploads).toEqual([]);
  });

  it("refuses folders and devices", async () => {
    await mkdir(path.join(dir, "folder.mp4"));

    const client = await connect();
    for (const input of ["folder.mp4", "/dev/zero"]) {
      expect((await call(client, "upload_file", { path: input })).text, input).toContain("is not a file");
    }
    expect(api.uploads).toEqual([]);
  });

  it("never opens a path on another machine", async () => {
    await symlink("//attacker/share/clip.mp4", path.join(dir, "share.mp4"));
    const inputs = [
      "\\\\attacker\\share\\clip.mp4",
      "//attacker/share/clip.mp4",
      "\\\\?\\UNC\\attacker\\share\\clip.mp4",
      "\\\\.\\pipe\\clip",
      "file://attacker/share/clip.mp4",
      "share.mp4",
    ];

    const client = await connect();
    for (const input of inputs) {
      expect((await call(client, "add_captions", { video: input })).text, input).toContain("another machine");
    }
    expect(api.requests).toEqual([]);
  });

  it("uploads the file it checked, not one swapped in afterwards", async () => {
    const media = new Media(new ReelSdk(api.baseUrl, GOOD_KEY), workspace());
    const clip = path.join(dir, "clip.mp4");
    await utimes(clip, 1_700_000_000, 1_700_000_000);
    const checked = await media.localFile("clip.mp4");

    await writeFile(path.join(dir, "secret"), Buffer.alloc(MP4.length, "s"));
    await utimes(path.join(dir, "secret"), 1_700_000_000, 1_700_000_000);
    await rename(path.join(dir, "secret"), clip);

    await expect(media.upload(checked, context())).rejects.toThrow("changed while it was being checked");
    expect(api.uploads).toEqual([]);
  });
});

describe("where files are saved", () => {
  let victim: string;

  beforeEach(async () => {
    victim = await tempDir("reelsdk-victim-");
  });

  it("keeps names from the API inside the output folder", async () => {
    api.scenario.outputs = (file) => ({ video: file("video.mp4"), "../../../evil": file("evil.mp4") });

    const outcome = await call(await connect(), "add_captions", { video: "clip.mp4" });

    expect(saved(outcome, "video")).toBe(output("clip-captioned.mp4"));
    expect(saved(outcome, "../../../evil")).toBe(output("clip-captioned-evil.mp4"));
  });

  it("names a job without a title safely", async () => {
    api.scenario.finished = { op: "../../../x", result: null };

    const outcome = await call(await connect(), "make_short", { topic: "the ghost ship" });

    expect(saved(outcome, "video")).toBe(output(`x-${outcome.json.job_id?.slice(-6)}.mp4`));
  });

  it("saves names Windows reserves for devices under a safe name", async () => {
    api.scenario.outputs = (file) => ({ "NUL.mp4": file("NUL.mp4"), com1: file("com1") });

    const outcome = await call(await connect(), "run_ffmpeg", { inputs: { "in.mp4": "clip.mp4" }, args: ["-i", "in.mp4", "out.mp4"], outputs: ["out.mp4"] });

    expect(saved(outcome, "NUL.mp4")).toBe(output("NUL_.mp4"));
    expect(saved(outcome, "com1")).toBe(output("com1_"));
  });

  it("refuses device names and trailing dots as ffmpeg file names", async () => {
    const client = await connect();
    for (const names of [{ inputs: { "CON.mp4": "clip.mp4" } }, { outputs: ["nul"] }, { outputs: ["LPT1.txt"] }, { outputs: ["out."] }]) {
      const args = { args: ["-version"], outputs: ["out.mp4"], ...names };
      const refused = await client.callTool({ name: "run_ffmpeg", arguments: args }).then((result) => (result as CallToolResult).isError === true, () => true);
      expect(refused, JSON.stringify(names)).toBe(true);
    }
    expect(api.created).toEqual([]);
  });

  it("never saves through a link where the output folder should be", async () => {
    await symlink(victim, path.join(dir, "reelsdk-output"));

    const outcome = await call(await connect(), "add_captions", { video: "clip.mp4" });

    expect(outcome.text).toContain("is a link");
    expect(await readdir(victim)).toEqual([]);
  });

  it("never saves through a link inside the output folder", async () => {
    await mkdir(output(), { recursive: true });
    await symlink(victim, output("captions"));

    const outcome = await call(await connect(), "add_captions", { video: "clip.mp4" });

    expect(outcome.text).toContain("is a link");
    expect(await readdir(victim)).toEqual([]);
  });

  it("saves into a folder the user named outside the project, even one behind a link", async () => {
    const movies = path.join(await tempDir("reelsdk-home-"), "Movies");
    await symlink(victim, movies);

    const outcome = await call(await connect({ REELSDK_OUTPUT_DIR: movies }), "add_captions", { video: "clip.mp4" });

    expect(saved(outcome, "video")).toBe(path.join(victim, "clip-captioned.mp4"));
  });

  it("counts a link at a file's name as taken and leaves it alone", async () => {
    await mkdir(output("captions"), { recursive: true });
    await symlink(path.join(victim, "planted.srt"), output("captions", "clip-captioned.srt"));

    const outcome = await call(await connect(), "add_captions", { video: "clip.mp4" });

    expect(saved(outcome, "video")).toBe(output("clip-captioned-2.mp4"));
    expect(saved(outcome, "srt")).toBe(output("captions", "clip-captioned-2.srt"));
    expect((await lstat(output("captions", "clip-captioned.srt"))).isSymbolicLink()).toBe(true);
    expect(await readdir(victim)).toEqual([]);
  });

  it("ignores a .part link planted next to the output", async () => {
    await mkdir(output(), { recursive: true });
    await writeFile(path.join(victim, "precious.txt"), "precious");
    await symlink(path.join(victim, "precious.txt"), output("clip-captioned.mp4.part"));

    const outcome = await call(await connect(), "add_captions", { video: "clip.mp4" });

    expect(saved(outcome, "video")).toBe(output("clip-captioned.mp4"));
    expect(await readFile(path.join(victim, "precious.txt"), "utf8")).toBe("precious");
  });

  it("stops saving into a folder that is swapped for a link mid-save", async () => {
    await writeFile(path.join(victim, "clip-captioned.srt"), "precious");
    api.scenario.outputs = (file) => ({ video: file("video.mp4"), srt: file("captions.srt") });
    api.scenario.onFile = async (pathname) => {
      if (!pathname.endsWith("/captions.srt")) return;
      await rename(output("captions"), output("captions-moved"));
      await symlink(victim, output("captions"));
    };

    const outcome = await call(await connect(), "add_captions", { video: "clip.mp4" });

    expect(saved(outcome, "video")).toBe(output("clip-captioned.mp4"));
    expect(saved(outcome, "srt")).toBeUndefined();
    expect(await readdir(victim)).toEqual(["clip-captioned.srt"]);
    expect(await readFile(path.join(victim, "clip-captioned.srt"), "utf8")).toBe("precious");
  });

  it("caps the size of all of a job's files together", async () => {
    const config = { apiKey: GOOD_KEY, baseUrl: api.baseUrl, outputDir: "reelsdk-output", waitSeconds: 30 };
    const runner = new JobRunner(new ReelSdk(api.baseUrl, GOOD_KEY, { outputBytes: 1000 }), config, workspace());
    api.scenario.outputs = (file) => ({ video: file("video.mp4"), srt: file("captions.srt") });
    api.scenario.onFile = (_pathname, res) => {
      res.end("x".repeat(600));
      return true;
    };

    const { files = [] } = outcomeOf(await runner.start("captions", { video_url: "https://example.com/clip.mp4" }, "clip-captioned", context())).json;

    expect(files.filter((file) => file.path !== undefined)).toHaveLength(1);
    expect(JSON.stringify(files)).toContain("more than reelsdk stores");
  });
});
