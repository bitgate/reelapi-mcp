export const DEFAULT_BASE_URL = "https://api.reelsdk.com";
export const DEFAULT_OUTPUT_DIR = "reelsdk-output";
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

  const apiKey = env.REELSDK_KEY?.trim() || "";
  if (!apiKey) {
    problems.push("REELSDK_KEY is not set. Add your reelsdk API key (rsdk_live_...) to the env of this MCP server in your client config, then restart the server.");
  }

  const baseUrl = (env.REELSDK_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
  if (!isSafeBaseUrl(baseUrl)) {
    problems.push(`REELSDK_BASE_URL must be an https URL (plain http only for localhost), got "${baseUrl}".`);
  }

  const rawWait = env.REELSDK_WAIT_S?.trim();
  const waitSeconds = rawWait ? Number(rawWait) : DEFAULT_WAIT_S;
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0) {
    problems.push(`REELSDK_WAIT_S must be a number of seconds from 0 to ${MAX_WAIT_S}, got "${rawWait}".`);
  }

  if (problems.length > 0) return { ok: false, error: problems.join(" ") };

  return {
    ok: true,
    config: {
      apiKey,
      baseUrl,
      outputDir: env.REELSDK_OUTPUT_DIR?.trim() || DEFAULT_OUTPUT_DIR,
      waitSeconds: Math.min(MAX_WAIT_S, Math.floor(waitSeconds)),
    },
  };
}

// The key goes along with every call, so only over https, or plain http to this machine
function isSafeBaseUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;

  const { protocol, hostname } = new URL(value);
  return protocol === "https:" || (protocol === "http:" && /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/.test(hostname));
}
