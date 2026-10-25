import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { ReelApi, Upload } from "./api.js";
import type { ToolContext } from "./context.js";
import { log } from "./log.js";
import { ToolError } from "./results.js";
import { resolvePath, type Workspace } from "./workspace.js";

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const HTTP_URL = /^https?:\/\//i;
const OTHER_URL = /^[a-z][a-z0-9+.-]+:\/\//i;
const PRIVATE_HOST = /^(localhost|.+\.localhost|.+\.local|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|0\.0\.0\.0|\[::1?\])$/i;
const REUSE_MARGIN_MS = 60 * 60 * 1000;

export interface LocalFile {
  path: string;
  size: number;
  mtimeMs: number;
}

interface CachedUpload {
  upload: Promise<Upload>;
  expiresAt?: number;
}

export class Media {
  readonly #uploads = new Map<string, CachedUpload>();

  constructor(
    private readonly api: ReelApi,
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

  async localFile(input: string): Promise<LocalFile> {
    const baseDir = await this.workspace.baseDir();
    const filePath = resolvePath(input.trim(), baseDir);

    const stats = await stat(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        throw new ToolError(`File not found: ${filePath}. Relative paths resolve against ${baseDir}; pass an absolute path or a public http(s) URL.`);
      }
      throw new ToolError(`Can't read ${filePath}: ${error.message}`);
    });

    if (!stats.isFile()) throw new ToolError(`${filePath} is not a file.`);
    if (stats.size === 0) throw new ToolError(`${filePath} is empty.`);
    if (stats.size > MAX_UPLOAD_BYTES) {
      throw new ToolError(
        `${filePath} is ${megabytes(stats.size)}, and local files are uploaded with a 100 MB cap. Host it somewhere public and pass the http(s) URL instead (URL inputs can be up to 500 MB).`,
      );
    }

    return { path: filePath, size: stats.size, mtimeMs: stats.mtimeMs };
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

    const upload = await this.api.upload(name, await openAsBlob(file.path), ctx.signal);
    log(`uploaded ${file.path} (${file.size} bytes)`);
    return upload;
  }
}

function publicUrl(value: string): string {
  if (!URL.canParse(value)) throw new ToolError(`"${value}" is not a valid URL.`);

  const { hostname } = new URL(value);
  if (PRIVATE_HOST.test(hostname)) {
    throw new ToolError(`reelapi downloads URL inputs over the internet and can't reach ${hostname}. Pass the local file path instead; it gets uploaded.`);
  }
  return value;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
