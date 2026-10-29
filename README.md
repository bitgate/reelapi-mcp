# reelsdk-mcp

Let your coding agent edit video: TikTok-style captions, photo slideshows with voiceover, AI-generated shorts and any ffmpeg command, rendered in the cloud and saved straight into your project. No ffmpeg, whisper or GPU on your machine.

```text
> add TikTok captions to ./clip.mp4
> turn the 8 photos in ./trip into a 30 s slideshow with a voiceover and ./song.mp3 underneath
> make a 45 s short about the Mary Celeste in the dark-documentary style
> crop ./demo.mp4 to 9:16 for Reels
```

The agent calls a tool, local files are uploaded, the job runs on [reelsdk](https://reelsdk.com), and the finished files land in `./reelsdk-output`.

## Setup

You need Node 20+ and a reelsdk API key (`rsdk_live_...`).

### Claude Code

```bash
claude mcp add reelsdk --env REELSDK_KEY=rsdk_live_xxx -- npx -y github:bitgate/reelsdk-mcp
```

Add `--scope project` to share it with your team through `.mcp.json`.

### Cursor

`.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` for every project):

```json
{
  "mcpServers": {
    "reelsdk": {
      "command": "npx",
      "args": ["-y", "github:bitgate/reelsdk-mcp"],
      "env": { "REELSDK_KEY": "rsdk_live_xxx" }
    }
  }
}
```

### Claude Desktop

Settings → Developer → Edit Config (`claude_desktop_config.json`). Desktop has no project folder, so pass absolute paths and pick where results go:

```json
{
  "mcpServers": {
    "reelsdk": {
      "command": "npx",
      "args": ["-y", "github:bitgate/reelsdk-mcp"],
      "env": { "REELSDK_KEY": "rsdk_live_xxx", "REELSDK_OUTPUT_DIR": "~/Movies/reelsdk" }
    }
  }
}
```

### VS Code

`.vscode/mcp.json` (asks for the key once and stores it encrypted):

```json
{
  "inputs": [{ "type": "promptString", "id": "reelsdk-key", "description": "reelsdk API key", "password": true }],
  "servers": {
    "reelsdk": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:bitgate/reelsdk-mcp"],
      "env": { "REELSDK_KEY": "${input:reelsdk-key}" }
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
| `get_job` | Keeps waiting on a job that outlived the tool call and saves its files when it's done. | up to `REELSDK_WAIT_S` |
| `upload_file` | Uploads a local file (max 100 MB) and returns a public URL valid for 7 days. Rarely needed: the other tools upload local paths themselves. | upload time |

Every media argument takes a local path (absolute or relative to the project) or a public http(s) URL. Results are never overwritten (`clip-captioned-2.mp4`), and subtitle files go into `reelsdk-output/captions/` so players don't stack them on top of the burned-in captions.

Tools wait up to `REELSDK_WAIT_S` seconds, sending progress updates if your client shows them. A job that takes longer comes back as a `job_id`, and the agent calls `get_job` to pick it up.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `REELSDK_KEY` | | Required. Your `rsdk_live_...` key. |
| `REELSDK_OUTPUT_DIR` | `reelsdk-output` | Where results are saved. Relative paths resolve against the project root and may not pass through a link; use an absolute path to save elsewhere. |
| `REELSDK_WAIT_S` | `50` | Seconds a tool waits for its job before handing back a `job_id` (0-300). Keep it under your client's tool timeout. |
| `REELSDK_BASE_URL` | `https://api.reelsdk.com` | API endpoint. https only; plain http only for localhost. |

The project root is `CLAUDE_PROJECT_DIR` when Claude Code sets it, else the client's first workspace root, else the directory the server was started in.

## Limits

Local files up to 100 MB (pass a public URL for bigger inputs, up to 500 MB). Up to 15 minutes of media and 10 minutes of processing per job, and up to 2 GiB of saved files per job.

A local file is only uploaded when it starts like a video, image, audio or subtitle file. Hidden files, anything in a hidden folder (`.env`, `~/.ssh`) and paths on another machine (`\\server\share`) are refused.

Results are only downloaded from the API's own `/f/` links, and never saved through a link inside the project or the output folder. Node can't open or rename relative to a folder handle, so another program running as you could still swap the folder for a link between the last check and the final rename.

## Development

```bash
npm ci
npm test            # unit + tool tests against a fake API
npm run typecheck
npm run bundle      # rebuilds dist/index.js, which is committed
```

`dist/` is committed so `npx github:bitgate/reelsdk-mcp` starts without a build step. See [AGENTS.md](AGENTS.md).

## License

MIT
