import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { plannedNames, safeName, slugify } from "../src/jobs.js";
import { hasHiddenSegment, isDeviceName, isNetworkPath } from "../src/paths.js";
import { isMediaHead } from "../src/sniff.js";
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

  it("sends the key over https, or plain http only to this machine", () => {
    for (const url of ["https://api.reelsdk.com", "http://localhost:8787", "http://127.0.0.1:9000", "http://[::1]:3000"]) {
      expect(loadConfig({ REELSDK_KEY: "k", REELSDK_BASE_URL: url }).ok, url).toBe(true);
    }
    for (const url of ["http://api.reelsdk.com", "http://localhost.attacker.com", "http://127.0.0.1.nip.io", "http://10.0.0.5"]) {
      expect(loadConfig({ REELSDK_KEY: "k", REELSDK_BASE_URL: url }).ok, url).toBe(false);
    }
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

  it("turns a name from the API into one plain file name Windows can open", () => {
    const cases: [string, string][] = [
      ["out.mp4", "out.mp4"],
      ["../../../evil", "evil"],
      ["..", "output"],
      ["C:\\Windows\\win.ini", "C_Windows_win.ini"],
      ["CON", "CON_"],
      ["nul.mp4", "nul_.mp4"],
      ["COM1.tar.gz", "COM1_.tar.gz"],
      ["lpt9", "lpt9_"],
      ["clip.mp4.", "clip.mp4"],
      ["clip.mp4 . .", "clip.mp4_._"],
    ];
    for (const [name, safe] of cases) expect(safeName(name), name).toBe(safe);
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

describe("Windows path rules", () => {
  it("treats UNC, device and NT paths as another machine", () => {
    const remote = [
      "\\\\server\\share\\clip.mp4",
      "//server/share/clip.mp4",
      "\\/server/share/clip.mp4",
      "\\\\?\\UNC\\server\\share\\clip.mp4",
      "\\\\?\\C:\\clip.mp4",
      "\\\\.\\pipe\\clip",
      "\\??\\C:\\clip.mp4",
      "file://server/share/clip.mp4",
      "file:////server/share/clip.mp4",
      "FILE://server/clip.mp4",
    ];
    for (const input of remote) expect(isNetworkPath(input), input).toBe(true);

    for (const input of ["C:\\Users\\me\\clip.mp4", "\\clip.mp4", "/home/me/clip.mp4", "clip.mp4", "file:///home/me/clip.mp4", "file:///C:/clip.mp4"]) {
      expect(isNetworkPath(input), input).toBe(false);
    }
  });

  it("knows the device names, whatever the extension", () => {
    for (const name of ["CON", "con", "PRN.mp4", "AUX", "NUL.txt", "nul.tar.gz", "COM0", "COM1", "com9.log", "LPT1", "lpt9.mp4"]) {
      expect(isDeviceName(name), name).toBe(true);
    }
    for (const name of ["CONSOLE", "con_.txt", "nul-1.mp4", "COM10", "LPT", "clip.mp4"]) {
      expect(isDeviceName(name), name).toBe(false);
    }
  });

  it("finds hidden folders below the project, and anywhere outside it", () => {
    expect(hasHiddenSegment("/home/me/.config/project/clip.mp4", "/home/me/.config/project")).toBe(false);
    expect(hasHiddenSegment("/home/me/project/.env", "/home/me/project")).toBe(true);
    expect(hasHiddenSegment("/home/me/.ssh/id_rsa", "/home/me/project")).toBe(true);
    expect(hasHiddenSegment("/home/me/Downloads/clip.mp4", "/home/me/project")).toBe(false);
  });
});

describe("isMediaHead", () => {
  const transportStream = Buffer.alloc(400);
  for (const offset of [0, 188, 376]) transportStream[offset] = 0x47;

  it("recognises video, image, audio and subtitle files by their first bytes", () => {
    const heads: Record<string, Buffer> = {
      mp4: Buffer.from("\0\0\0\x18ftypisom\0\0\x02\0isomiso2", "latin1"),
      webm: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f]),
      ts: transportStream,
      png: Buffer.from("\x89PNG\r\n\x1a\n\0\0\0\rIHDR", "latin1"),
      jpg: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      gif: Buffer.from("GIF89a"),
      webp: Buffer.from("RIFF\x24\0\0\0WEBPVP8 ", "latin1"),
      wav: Buffer.from("RIFF\x24\0\0\0WAVEfmt ", "latin1"),
      mp3: Buffer.from([0xff, 0xfb, 0x90, 0x64]),
      id3: Buffer.from("ID3\x04\0", "latin1"),
      aac: Buffer.from([0xff, 0xf1, 0x50, 0x80]),
      ogg: Buffer.from("OggS\0\x02"),
      flac: Buffer.from("fLaC\0"),
      srt: Buffer.from("\ufeff1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n"),
      vtt: Buffer.from("WEBVTT\n\n00:01.000 --> 00:02.000\nHi\n"),
      ass: Buffer.from("[Script Info]\nTitle: clip\n"),
      concat: Buffer.from("file 'a.mp4'\nfile 'b.mp4'\n"),
    };
    for (const [kind, head] of Object.entries(heads)) expect(isMediaHead(head, 1000), kind).toBe(true);
  });

  it("refuses anything else, whatever its name", () => {
    const heads: Record<string, Buffer> = {
      sshKey: Buffer.from("-----BEGIN OPENSSH PRIVATE KEY-----\n"),
      env: Buffer.from("OPENAI_API_KEY=sk-123\n"),
      json: Buffer.from('{"token": "secret"}'),
      utf16: Buffer.from("\ufeffhello", "utf16le"),
      zip: Buffer.from("PK\x03\x04", "latin1"),
      sqlite: Buffer.from("SQLite format 3\0"),
      pdf: Buffer.from("%PDF-1.7"),
      oversizedBox: Buffer.from("\x7f\0\0\0ftypisom", "latin1"),
      empty: Buffer.alloc(0),
    };
    for (const [kind, head] of Object.entries(heads)) expect(isMediaHead(head, 1000), kind).toBe(false);
  });
});

it("VERSION matches package.json", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  expect(VERSION).toBe(pkg.version);
});
