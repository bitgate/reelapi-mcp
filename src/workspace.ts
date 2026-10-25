import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export class Workspace {
  #baseDir: Promise<string> | undefined;

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly listRoots: () => Promise<string[] | undefined>,
  ) {}

  baseDir(): Promise<string> {
    this.#baseDir ??= this.#detect();
    return this.#baseDir;
  }

  invalidate(): void {
    this.#baseDir = undefined;
  }

  // Claude Code passes the project root; other clients may expose it as an MCP root; else the launch dir
  async #detect(): Promise<string> {
    const projectDir = this.env.CLAUDE_PROJECT_DIR?.trim();
    if (projectDir) return path.resolve(projectDir);

    const roots = await this.listRoots().catch(() => undefined);
    const fileRoot = roots?.find((uri) => uri.startsWith("file://"));
    if (fileRoot) return fileURLToPath(fileRoot);

    const cwd = process.cwd();
    return path.parse(cwd).root === cwd ? os.homedir() : cwd;
  }
}

export function resolvePath(input: string, baseDir: string): string {
  if (/^file:\/\//i.test(input)) return fileURLToPath(input);
  if (input === "~" || /^~[/\\]/.test(input)) return path.join(os.homedir(), input.slice(1));
  return path.resolve(baseDir, input);
}
