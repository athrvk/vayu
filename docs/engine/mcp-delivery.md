# Vayu MCP — Delivery Summary

> Session deliverable record for the MCP server feature on branch
> `claude/epic-allen-elmc8s`. Design rationale lives in
> [`mcp.md`](./mcp.md); this file records **what shipped**, how it was verified,
> and what remains. Commit: `7549e08`.

## What shipped

A TypeScript MCP server hosted in the Electron main process, using the official
`@modelcontextprotocol/sdk` over Streamable HTTP at `127.0.0.1:9877/mcp`,
proxying the engine's REST API. The C++ engine is untouched.

### Tasks delivered

| Task | Deliverable |
| --- | --- |
| **T1** | `@modelcontextprotocol/sdk@1.29.0` dependency + `MCP_HOST`/`MCP_PORT` (9877) / `MCP_ENDPOINT_URL` in `app/electron/constants.ts` |
| **T2** | `engine-client.ts` (fetch wrapper + SSE metrics snapshot) + `safety.ts` / `config.ts` (allowlist, caps, duration parsing) |
| **T3** | `tools.ts` (tool registry + dispatch), `server.ts` (SDK wiring), `http.ts` (Streamable HTTP host + DNS-rebinding protection), `compare.ts` (two-report diff) |
| **T4** | Wired into `app/electron/main.ts` lifecycle — best-effort start, stop on quit, `mcp:status` IPC |
| **T5** | `cli.ts` — standalone stdio server reusing the same registry (Zed / headless / CI) |
| **T6** | 33 unit tests (safety guards, tool dispatch, run comparison) |
| **T7** | `SECURITY.md` (MCP threat model) + `docs/engine/mcp.md` updated to "as built" |
| **T8** | Verified, committed, pushed |

### Tools

- **Read:** `get_engine_health`, `list_collections`, `list_requests`,
  `list_environments`, `list_runs`, `get_run_report`
- **Execute:** `run_request`
- **Load:** `start_load_run` (confirmation-gated + caps), `stop_run`,
  `get_live_metrics` (bounded snapshot), `compare_runs`

### Safety (on by default)

- Loopback-only bind + DNS-rebinding protection (Host validation)
- Target allowlist, **empty by default** — no outbound requests until a host is
  added
- Hard RPS / concurrency / duration caps
- Confirmation gate before any load is generated
- Read-only by default (collection/environment writes behind a flag)

### File layout (`app/electron/mcp/`)

`config.ts`, `safety.ts`, `engine-client.ts`, `compare.ts`, `tools.ts`,
`server.ts`, `http.ts`, `cli.ts`, `index.ts` (+ `*.test.ts`).

## Verification

CI gates (`.github/workflows/pr-tests.yml`) are `pnpm type-check` and
`pnpm test`.

- `pnpm type-check` — clean
- `tsc -p tsconfig.node.json --noEmit` (electron) — clean
- `pnpm test` — **321 passed (42 files)**, including 33 new MCP tests
- New files lint clean. (~125 pre-existing `@typescript-eslint/no-explicit-any`
  errors exist in untouched `src/services/**`; lint is not a CI gate.)

## Not verified in this environment

This container cannot launch Electron or a live engine, so:

- The Streamable HTTP path (`http.ts`) and stdio CLI were validated via
  type-check + unit tests against a **mocked** engine, not a real MCP client
  handshake. First real test: run the app, then
  `claude mcp add --transport http vayu http://127.0.0.1:9877/mcp` and call
  `get_engine_health`.
- `get_live_metrics` SSE parsing is unit-tested but not exercised against a
  running load test.

## Follow-ups

1. ~~**Settings UI + "Connect to Claude Code" button**~~ — **done.**
   `Settings → MCP` toggles the server on/off and edits the allowlist (incl.
   allow-all), caps, and write toggle, persisting them in the Electron main
   process (`electron-store`). It shows live connection status + connect snippets
   for Claude Code / Cursor / VS Code / Codex. Renderer input is sanitized
   main-side (`sanitizeSafetyInput`). See `mcp.md` → "Resolved: safety-config
   storage & UI".
2. **MCP-originated run tagging** (deferred) — mark runs started via MCP so
   History shows provenance.
3. **Package the stdio CLI** (deferred) as a `vayu mcp` bin / documented
   entrypoint in the installer.
