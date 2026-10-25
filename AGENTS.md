# AGENTS.md

Local stdio MCP server that wraps the reelapi video API. The API contract lives in the `bitgate/reelapi` repo (`docs/CONTRACT.md`, `docs/SHORTS.md`) and at https://reelapi.bitgate.dev/openapi.json.

## Layout

- `src/index.ts`: entry point, stdio transport
- `src/server.ts`: builds the `McpServer`, project root detection, config errors
- `src/tools.ts`: the six tools; names, descriptions and parameter docs are what agents read to pick a tool
- `src/api.ts`: HTTP client with retries (network errors, 408/429/5xx), uploads and streamed downloads
- `src/jobs.ts`: create job, long-poll, save outputs without overwriting
- `src/media.ts`: local path or URL to an API URL, upload cache, 100 MB check
- `src/results.ts`: tool results and error hints
- `test/`: vitest against `test/fake-api.ts`, through a real MCP client over an in-memory transport

## Rules

- Never write to stdout: it's the protocol channel. Log with `log()` from `src/log.ts` (stderr).
- `dist/index.js` is committed and must match the source: run `npm run bundle` and commit it. CI fails on drift (`npm run bundle:check`).
- No `build`, `prepare`, `prepack`, `install`, `preinstall` or `postinstall` scripts: npm would then run a full dev install whenever someone starts the server with `npx github:bitgate/reelapi-mcp`.
- No runtime dependencies. Everything is bundled into `dist/index.js`.
- Import zod as `import * as z from "zod"`; `import { z }` pulls every zod locale into the bundle.
- `vite` is pinned to 7 in `overrides`: vite 8 crashes npm 10's installer (`Cannot read properties of null (reading 'edgesOut')`).
- Keep tool descriptions short and concrete: what it does, when to use it instead of local ffmpeg, what comes back, how long it takes.
- Bump `version` in `package.json` and `src/version.ts` together (a test checks they match).

## Checks

```bash
npm run typecheck && npm test && npm run bundle:check
```

Live smoke test: `npx @modelcontextprotocol/inspector -e REELAPI_KEY=rk_live_... node dist/index.js`.
