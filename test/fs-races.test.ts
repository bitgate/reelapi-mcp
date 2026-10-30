import type { RmOptions } from "node:fs";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile, type FileHandle } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReelSdk } from "../src/api.js";
import type { SavedFile, ToolContext } from "../src/context.js";
import { JobRunner } from "../src/jobs.js";
import { saveExclusive } from "../src/paths.js";
import { Workspace } from "../src/workspace.js";
import { GOOD_KEY, startFakeApi, type FakeApi } from "./fake-api.js";

const hooks = vi.hoisted(() => ({
  opened: undefined as ((handle: FileHandle) => void) | undefined,
  removing: undefined as ((target: string) => void) | undefined,
  checked: undefined as ((target: string) => Promise<void>) | undefined,
}));

// Every call goes to the real file system; a test can step in around one
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async open(file: string, flags: string | number, mode?: number) {
      const handle = await actual.open(file, flags, mode);
      hooks.opened?.(handle);
      return handle;
    },
    async rm(target: string, options?: RmOptions) {
      hooks.removing?.(target);
      return actual.rm(target, options);
    },
    async lstat(target: string) {
      try {
        return await actual.lstat(target);
      } finally {
        await hooks.checked?.(target);
      }
    },
  };
});

let out: string;

beforeEach(async () => {
  out = await realpath(await mkdtemp(path.join(os.tmpdir(), "reelsdk-races-")));
});

afterEach(async () => {
  hooks.opened = hooks.removing = hooks.checked = undefined;
  await rm(out, { recursive: true, force: true });
});

const signal = () => new AbortController().signal;

async function* bytes(text: string): AsyncGenerator<Uint8Array> {
  yield Buffer.from(text);
}

describe("saveExclusive", () => {
  it("removes its temporary file even when closing it fails", async () => {
    hooks.opened = (handle) => {
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        throw Object.assign(new Error("EIO: i/o error, close"), { code: "EIO" });
      };
    };

    await expect(saveExclusive(bytes("video"), path.join(out, "clip.mp4"))).rejects.toThrow(/EIO/);
    expect(await readdir(out)).toEqual([]);
  });
});

describe("download", () => {
  it("keeps counting a failed attempt's bytes while its file is still on disk", async () => {
    let hits = 0;
    const host = createServer((_req, res) => {
      hits += 1;
      if (hits > 1) return res.end("x".repeat(700));
      res.writeHead(200, { "content-length": "700" }).write("x".repeat(600));
      setTimeout(() => res.destroy(), 50);
    });
    await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;
    hooks.removing = (target) => {
      if (target.endsWith(".part")) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    };

    const sdk = new ReelSdk(base, "rsdk_live_secret", { outputBytes: 1024 });
    const budget = sdk.outputBudget();
    try {
      await expect(sdk.download(`${base}/f/out/job_1/video.mp4`, path.join(out, "video.mp4"), signal(), budget)).rejects.toMatchObject({ code: "OUTPUT_TOO_LARGE" });
      expect(budget.left).toBe(424);
    } finally {
      host.closeAllConnections();
      await new Promise((resolve) => host.close(resolve));
    }
  });
});

describe("saving a job's files", () => {
  let api: FakeApi;

  beforeEach(async () => {
    api = await startFakeApi();
  });

  afterEach(() => api.close());

  const context = (): ToolContext => ({ signal: signal(), startedAt: Date.now(), progress: () => {} });
  const theirs = () => path.join(out, "reelsdk-output", "captions", "clip.srt");

  // Someone else takes one of the names right after we found it free
  const claimedByAnotherCall = () => {
    hooks.checked = async (target) => {
      if (target !== theirs()) return;
      hooks.checked = undefined;
      await writeFile(target, "theirs");
    };
  };

  async function save(): Promise<SavedFile[]> {
    const config = { apiKey: GOOD_KEY, baseUrl: api.baseUrl, outputDir: "reelsdk-output", waitSeconds: 30 };
    const runner = new JobRunner(new ReelSdk(api.baseUrl, GOOD_KEY), config, new Workspace({ CLAUDE_PROJECT_DIR: out }, async () => undefined));
    const result: CallToolResult = await runner.start("captions", { video_url: "https://example.com/clip.mp4" }, "clip", context());
    const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    return (JSON.parse(text.slice(text.indexOf("\n{") + 1)) as { files: SavedFile[] }).files;
  }

  it("never overwrites a file another call claimed", async () => {
    claimedByAnotherCall();

    const files = await save();

    expect(await readFile(theirs(), "utf8")).toBe("theirs");
    expect(files.find((file) => file.name === "srt")?.path).toBe(path.join(out, "reelsdk-output", "captions", "clip-2.srt"));
    expect((await readdir(path.join(out, "reelsdk-output"))).sort()).toEqual(["captions", "clip-2.mp4"]);
  });

  it("never deletes a file another call claimed when its own download fails", async () => {
    claimedByAnotherCall();
    api.scenario.onFile = (pathname, res) => {
      if (!pathname.endsWith("/captions.srt")) return false;
      res.writeHead(404).end();
      return true;
    };

    const files = await save();

    expect(files.find((file) => file.name === "srt")?.error).toContain("HTTP 404");
    expect(await readFile(theirs(), "utf8")).toBe("theirs");
  });
});
