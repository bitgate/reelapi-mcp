import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { ReelApi } from "./api.js";
import { DEFAULT_OUTPUT_DIR, DEFAULT_WAIT_S, loadConfig } from "./config.js";
import { JobRunner } from "./jobs.js";
import { log } from "./log.js";
import { Media } from "./media.js";
import { ToolError } from "./results.js";
import { registerTools, type Services } from "./tools.js";
import { VERSION } from "./version.js";
import { Workspace } from "./workspace.js";

export function createServer(env: NodeJS.ProcessEnv): McpServer {
  const loaded = loadConfig(env);
  const outputDir = loaded.ok ? loaded.config.outputDir : DEFAULT_OUTPUT_DIR;
  const waitSeconds = loaded.ok ? loaded.config.waitSeconds : DEFAULT_WAIT_S;

  const server = new McpServer({ name: "reelapi", version: VERSION }, { instructions: instructions(outputDir) });

  const workspace = new Workspace(env, async () => {
    if (!server.server.getClientCapabilities()?.roots) return undefined;
    const { roots } = await server.server.listRoots(undefined, { timeout: 3000 });
    return roots.map((root) => root.uri);
  });
  server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => workspace.invalidate());

  // A broken config still starts the server, so the agent sees what to fix instead of a dead connection
  let services: Services | undefined;
  let configError: string | undefined;
  if (loaded.ok) {
    const api = new ReelApi(loaded.config.baseUrl, loaded.config.apiKey);
    services = { media: new Media(api, workspace), jobs: new JobRunner(api, loaded.config, workspace) };
  } else {
    configError = loaded.error;
    log(configError);
  }

  const getServices = (): Services => {
    if (!services) throw new ToolError(configError ?? "reelapi-mcp is not configured.");
    return services;
  };
  registerTools(server, getServices, { outputDir, waitSeconds });

  return server;
}

function instructions(outputDir: string): string {
  return [
    "reelapi renders video in the cloud: burned-in captions, image slideshows with voiceover and music, AI-generated shorts, and any ffmpeg command.",
    "Prefer these tools over installing ffmpeg, whisper or other media tools locally.",
    `Pass local file paths (absolute, or relative to the project root) or public URLs; local files are uploaded automatically. Results are saved under ${outputDir} and returned as absolute paths.`,
    "If a tool returns status running, call get_job with its job_id until it finishes.",
  ].join(" ");
}
