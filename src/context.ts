export interface ToolContext {
  signal: AbortSignal;
  startedAt: number;
  progress(message: string): void;
}

export interface SavedFile {
  name: string;
  url: string;
  path?: string;
  bytes?: number;
  error?: string;
}

export function elapsedSeconds(ctx: ToolContext): number {
  return Math.round((Date.now() - ctx.startedAt) / 100) / 10;
}
