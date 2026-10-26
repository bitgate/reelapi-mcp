import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { plannedNames, slugify } from "../src/jobs.js";
import { VERSION } from "../src/version.js";
import { resolvePath } from "../src/workspace.js";

describe("loadConfig", () => {
  it("requires a key", () => {
    const result = loadConfig({});
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("REELSDK_KEY");
  });

  it("applies defaults", () => {
    expect(loadConfig({ REELSDK_KEY: "rsdk_live_x" })).toEqual({
      ok: true,
      config: { apiKey: "rsdk_live_x", baseUrl: "https://api.reelsdk.com", outputDir: "reelsdk-output", waitSeconds: 50 },
    });
  });

  it("clamps the wait and rejects nonsense", () => {
    expect(loadConfig({ REELSDK_KEY: "k", REELSDK_WAIT_S: "900" })).toMatchObject({ ok: true, config: { waitSeconds: 300 } });
    expect(loadConfig({ REELSDK_KEY: "k", REELSDK_WAIT_S: "soon" }).ok).toBe(false);
    expect(loadConfig({ REELSDK_KEY: "k", REELSDK_BASE_URL: "ftp://example.com" }).ok).toBe(false);
  });
});

describe("output names", () => {
  it("keeps subtitles out of the video's folder", () => {
    const url = (name: string) => `https://api.reelsdk.com/f/out/job_x/${name}`;
    const outputs: [string, string][] = [
      ["video", url("video.mp4")],
      ["poster", url("poster.jpg")],
      ["transcript", url("transcript.json")],
      ["srt", url("captions.srt")],
    ];

    expect(plannedNames(outputs, "clip")).toEqual(["clip.mp4", "clip-poster.jpg", path.join("captions", "clip.transcript.json"), path.join("captions", "clip.srt")]);
  });

  it("slugifies titles", () => {
    expect(slugify("Café Noir: The Ghost Ship!")).toBe("cafe-noir-the-ghost-ship");
  });
});

describe("resolvePath", () => {
  it("handles relative, home and file URL paths", () => {
    expect(resolvePath("clip.mp4", "/project")).toBe(path.resolve("/project", "clip.mp4"));
    expect(resolvePath("~/clip.mp4", "/project")).toBe(path.join(os.homedir(), "clip.mp4"));
    expect(resolvePath("file:///tmp/clip.mp4", "/project")).toBe(path.resolve("/tmp/clip.mp4"));
  });
});

it("VERSION matches package.json", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  expect(VERSION).toBe(pkg.version);
});
