import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { ReelSdk, Upload } from "./api.js";
import type { ToolContext } from "./context.js";
import { log } from "./log.js";
import { hasHiddenSegment, isNetworkPath, LinkError, resolveLinks } from "./paths.js";
import { ToolError } from "./results.js";
import { HEAD_BYTES, isMediaHead } from "./sniff.js";
import { resolvePath, type Workspace } from "./workspace.js";

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

const HTTP_URL = /^https?:\/\//i;
const OTHER_URL = /^[a-z][a-z0-9+.-]+:\/\//i;
const PRIVATE_HOST = /^(localhost|.+\.localhost|.+\.local|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|0\.0\.0\.0|\[::1?\])$/i;
const REUSE_MARGIN_MS = 60 * 60 * 1000;

export interface LocalFile {
  path: string;
  realPath: string;
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}

interface CachedUpload {
  upload: Promise<Upload>;
  expiresAt?: number;
}

export class Media {
  readonly #uploads = new Map<string, CachedUpload>();

  constructor(
    private readonly api: ReelSdk,
    private readonly workspace: Workspace,
  ) {}

  async toUrl(input: string, ctx: ToolContext): Promise<string> {
    const value = input.trim();
    if (HTTP_URL.test(value)) return publicUrl(value);
    if (OTHER_URL.test(value) && !/^file:\/\//i.test(value)) {
      throw new ToolError(`Can't use "${value}": pass a local file path or a public http(s) URL.`);
    }

    const upload = await this.upload(await this.localFile(value), ctx);
    return upload.url;
  }

  // Whatever the path, only a regular media file on this machine outside hidden folders gets uploaded, since its URL is public
  async localFile(input: string): Promise<LocalFile> {
    const value = input.trim();
    if (isNetworkPath(value)) throw new ToolError(`${value} is on another machine. Pass a file on this computer or a public http(s) URL.`);

    const baseDir = await this.workspace.baseDir();
    const filePath = resolvePath(value, baseDir);
    if (hasHiddenSegment(filePath, baseDir)) throw hiddenFile(filePath);

    const unreadable = (error: NodeJS.ErrnoException): never => {
      if (error instanceof LinkError) throw new ToolError(`Can't upload ${filePath}: ${error.message}.`);
      if (error.code === "ENOENT") {
        throw new ToolError(`File not found: ${filePath}. Relative paths resolve against ${baseDir}; pass an absolute path or a public http(s) URL.`);
      }
      throw new ToolError(`Can't read ${filePath}: ${error.message}`);
    };
    const realPath = await resolveLinks(filePath).catch(unreadable);
    if (hasHiddenSegment(realPath, await realpath(baseDir).catch(() => baseDir))) throw hiddenFile(filePath);

    // lstat, so the identity we check later is never that of a file a link leads to
    const stats = await lstat(realPath).catch(unreadable);
    if (stats.isSymbolicLink()) throw changed(filePath);
    if (!stats.isFile()) throw new ToolError(`${filePath} is not a file.`);
    if (stats.size === 0) throw new ToolError(`${filePath} is empty.`);
    if (stats.size > MAX_UPLOAD_BYTES) {
      throw new ToolError(
        `${filePath} is ${megabytes(stats.size)}, and local files are uploaded with a 100 MB cap. Host it somewhere public and pass the http(s) URL instead (URL inputs can be up to 500 MB).`,
      );
    }

    const file: LocalFile = { path: filePath, realPath, size: stats.size, mtimeMs: stats.mtimeMs, dev: stats.dev, ino: stats.ino };
    const handle = await openUnchanged(file);
    try {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(HEAD_BYTES), 0, HEAD_BYTES, 0);
      if (!isMediaHead(buffer.subarray(0, bytesRead), file.size)) {
        throw new ToolError(`${filePath} doesn't look like a video, image, audio or subtitle file, so it isn't uploaded.`);
      }
    } finally {
      await handle.close();
    }
    return file;
  }

  // Same file, same session: reuse the upload until it gets close to expiring
  upload(file: LocalFile, ctx: ToolContext): Promise<Upload> {
    const key = `${file.path}|${file.size}|${file.mtimeMs}`;
    const cached = this.#uploads.get(key);
    if (cached && (cached.expiresAt === undefined || cached.expiresAt - Date.now() > REUSE_MARGIN_MS)) return cached.upload;

    const entry: CachedUpload = { upload: this.#send(file, ctx) };
    this.#uploads.set(key, entry);
    entry.upload.then(
      (upload) => {
        const expiresAt = Date.parse(upload.expires_at);
        entry.expiresAt = Number.isFinite(expiresAt) ? expiresAt : undefined;
      },
      () => this.#uploads.delete(key),
    );
    return entry.upload;
  }

  async #send(file: LocalFile, ctx: ToolContext): Promise<Upload> {
    const name = path.basename(file.path);
    ctx.progress(`uploading ${name} (${megabytes(file.size)})`);

    const handle = await openUnchanged(file);
    try {
      const upload = await this.api.upload(name, { handle, size: file.size }, ctx.signal);
      log(`uploaded ${file.path} (${file.size} bytes)`);
      return upload;
    } finally {
      await handle.close();
    }
  }
}

// We open what we checked, without following a link where the system can refuse one (Windows can't), and refuse it when
// another file took its place: by identity, and by path, since a parent folder swapped for a link fools lstat and open alike
async function openUnchanged(file: LocalFile): Promise<FileHandle> {
  const handle = await open(file.realPath, OPEN_FLAGS);
  const now = await handle.stat();
  const samePath = await realpath(file.realPath).then((real) => real === file.realPath, () => false);
  if (samePath && now.isFile() && now.dev === file.dev && now.ino === file.ino && now.size === file.size && now.mtimeMs === file.mtimeMs) return handle;

  await handle.close();
  throw changed(file.path);
}

function changed(filePath: string): ToolError {
  return new ToolError(`${filePath} changed while it was being checked; try again.`);
}

function hiddenFile(filePath: string): ToolError {
  return new ToolError(`${filePath} is hidden or inside a hidden folder, and those are never uploaded.`);
}

function publicUrl(value: string): string {
  if (!URL.canParse(value)) throw new ToolError(`"${value}" is not a valid URL.`);

  const { hostname } = new URL(value);
  if (PRIVATE_HOST.test(hostname)) {
    throw new ToolError(`reelsdk downloads URL inputs over the internet and can't reach ${hostname}. Pass the local file path instead; it gets uploaded.`);
  }
  return value;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
