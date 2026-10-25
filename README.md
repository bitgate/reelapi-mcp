# reelapi-mcp

Let your coding agent edit video: TikTok-style captions, photo slideshows with voiceover, AI-generated shorts and any ffmpeg command, rendered in the cloud and saved straight into your project. No ffmpeg, whisper or GPU on your machine.

```text
> add TikTok captions to ./clip.mp4
> turn the 8 photos in ./trip into a 30 s slideshow with a voiceover and ./song.mp3 underneath
> make a 45 s short about the Mary Celeste in the dark-documentary style
> crop ./demo.mp4 to 9:16 for Reels
```

The agent calls a tool, local files are uploaded, the job runs on [reelapi](https://reelapi.bitgate.dev), and the finished files land in `./reelapi-output`.

## Setup

You need Node 20+ and a reelapi API key (`rk_live_...`).

### Claude Code

```bash
claude mcp add reelapi --env REELAPI_KEY=rk_live_xxx -- npx -y github:bitgate/reelapi-mcp
```

Add `--scope project` to share it with your team through `.mcp.json`.

### Cursor

`.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` for every project):

```json
{
  "mcpServers": {
    "reelapi": {
      "command": "npx",
      "args": ["-y", "github:bitgate/reelapi-mcp"],
      "env": { "REELAPI_KEY": "rk_live_xxx" }
    }
  }
}
```

### Claude Desktop

Settings → Developer → Edit Config (`claude_desktop_config.json`). Desktop has no project folder, so pass absolute paths and pick where results go:

```json
{
  "mcpServers": {
    "reelapi": {
      "command": "npx",
      "args": ["-y", "github:bitgate/reelapi-mcp"],
      "env": { "REELAPI_KEY": "rk_live_xxx", "REELAPI_OUTPUT_DIR": "~/Movies/reelapi" }
    }
  }
}
```

### VS Code

`.vscode/mcp.json` (asks for the key once and stores it encrypted):

```json
{
  "inputs": [{ "type": "promptString", "id": "reelapi-key", "description": "reelapi API key", "password": true }],
  "servers": {
    "reelapi": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:bitgate/reelapi-mcp"],
      "env": { "REELAPI_KEY": "${input:reelapi-key}" }
    }
  }
}
```

### Windsurf

Settings → Cascade → MCP Servers → View raw config, then add the same `mcpServers` entry as Cursor.

## Tools

| Tool | What it does | Typical time |
| --- | --- | --- |
| `add_captions` | Burns animated word-by-word captions into a video (presets `bold`, `karaoke`, `minimal`, or your own font, position, colors and words per line). Also returns `.srt`, `.vtt`, `.ass` and a word-timed transcript. | 15-60 s |
| `make_slideshow` | Images to mp4 with transitions, Ken Burns motion, text-to-speech or recorded voiceover, background music ducked under the voice, and captions. | 15-90 s |
| `make_short` | Topic or script in, finished short out: AI script, AI images, voiceover, captions and music, plus a poster frame and a ready-to-post caption. | 1-2 min |
| `run_ffmpeg` | Any ffmpeg command: crop, trim, resize, convert, compress, GIFs, extract audio, concatenate. | seconds to minutes |
| `get_job` | Keeps waiting on a job that outlived the tool call and saves its files when it's done. | up to `REELAPI_WAIT_S` |
| `upload_file` | Uploads a local file (max 100 MB) and returns a public URL valid for 7 days. Rarely needed: the other tools upload local paths themselves. | upload time |

Every media argument takes a local path (absolute or relative to the project) or a public http(s) URL. Results are never overwritten (`clip-captioned-2.mp4`), and subtitle files go into `reelapi-output/captions/` so players don't stack them on top of the burned-in captions.

Tools wait up to `REELAPI_WAIT_S` seconds, sending progress updates if your client shows them. A job that takes longer comes back as a `job_id`, and the agent calls `get_job` to pick it up.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `REELAPI_KEY` | | Required. Your `rk_live_...` key. |
| `REELAPI_OUTPUT_DIR` | `reelapi-output` | Where results are saved. Relative paths resolve against the project root. |
| `REELAPI_WAIT_S` | `50` | Seconds a tool waits for its job before handing back a `job_id` (0-300). Keep it under your client's tool timeout. |
| `REELAPI_BASE_URL` | `https://reelapi.bitgate.dev` | API endpoint. |

The project root is `CLAUDE_PROJECT_DIR` when Claude Code sets it, else the client's first workspace root, else the directory the server was started in.

## Limits

Local files up to 100 MB (pass a public URL for bigger inputs, up to 500 MB). Up to 15 minutes of media and 10 minutes of processing per job.

## Development

```bash
npm ci
npm test            # unit + tool tests against a fake API
npm run typecheck
npm run bundle      # rebuilds dist/index.js, which is committed
```

`dist/` is committed so `npx github:bitgate/reelapi-mcp` starts without a build step. See [AGENTS.md](AGENTS.md).

## License

MIT
