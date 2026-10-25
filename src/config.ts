export const DEFAULT_BASE_URL = "https://reelapi.bitgate.dev";
export const DEFAULT_OUTPUT_DIR = "reelapi-output";
export const DEFAULT_WAIT_S = 50;
export const MAX_WAIT_S = 300;

export interface Config {
  apiKey: string;
  baseUrl: string;
  outputDir: string;
  waitSeconds: number;
}

export type ConfigResult = { ok: true; config: Config } | { ok: false; error: string };

export function loadConfig(env: NodeJS.ProcessEnv): ConfigResult {
  const problems: string[] = [];

  const apiKey = env.REELAPI_KEY?.trim() ?? "";
  if (!apiKey) {
    problems.push("REELAPI_KEY is not set. Add your reelapi API key (rk_live_...) to the env of this MCP server in your client config, then restart the server.");
  }

  const baseUrl = (env.REELAPI_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
  if (!URL.canParse(baseUrl) || !/^https?:$/.test(new URL(baseUrl).protocol)) {
    problems.push(`REELAPI_BASE_URL must be an http(s) URL, got "${baseUrl}".`);
  }

  const rawWait = env.REELAPI_WAIT_S?.trim();
  const waitSeconds = rawWait ? Number(rawWait) : DEFAULT_WAIT_S;
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0) {
    problems.push(`REELAPI_WAIT_S must be a number of seconds from 0 to ${MAX_WAIT_S}, got "${rawWait}".`);
  }

  if (problems.length > 0) return { ok: false, error: problems.join(" ") };

  return {
    ok: true,
    config: {
      apiKey,
      baseUrl,
      outputDir: env.REELAPI_OUTPUT_DIR?.trim() || DEFAULT_OUTPUT_DIR,
      waitSeconds: Math.min(MAX_WAIT_S, Math.floor(waitSeconds)),
    },
  };
}
