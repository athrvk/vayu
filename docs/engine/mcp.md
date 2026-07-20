# Vayu MCP Server

**Endpoint:** `http://127.0.0.1:9877/mcp` (Streamable HTTP) · **Also:** stdio CLI

Vayu exposes its engine to AI agents (Claude Code, Cursor, VS Code, Codex, Zed)
through a [Model Context Protocol](https://modelcontextprotocol.io) server. The
server is TypeScript, hosted in the Electron main process, built on the official
[`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk),
and proxies the engine's REST API on `:9876`. The **C++ engine is not modified** —
the MCP layer is Apache-2.0 like the rest of the app.

Once Vayu is running, any agent opts in with one command; if Vayu is down, the
agent gets a clean "start Vayu" error. Threat model and posture: [`SECURITY.md`](../../SECURITY.md).

## Overview

- **Hosted in the app.** MCP is a capability the running app exposes, not a
  separate process to manage. It is started and stopped alongside the engine
  sidecar by `app/electron/main.ts`, best-effort (a bind failure logs and the app
  continues without it).
- **Proxy, not a second source of truth.** Every tool maps to an existing engine
  endpoint via a thin `fetch` client (`engine-client.ts`). The main process
  cannot import the renderer's `@/services`, so this client is standalone.
- **Local-only.** Binds `127.0.0.1`, with Host-header (DNS-rebinding) validation
  on `/mcp`.
- **Configurable from Settings.** Server on/off, the allowlist, caps, the write
  toggle, and per-tool switches live in **Settings → MCP** and persist across
  restarts.

## Connecting

Ensure Vayu is running, then register the endpoint once per machine. In the app,
**Settings → MCP** offers a one-click **Connect** for Claude Code and VS Code
(shells out to their CLIs) and copyable snippets for the rest.

```bash
# Claude Code (or click Connect in Settings → MCP)
claude mcp add --transport http vayu http://127.0.0.1:9877/mcp
```

```json
// Claude Code (.mcp.json) / Cursor (.cursor/mcp.json)
{
  "mcpServers": {
    "vayu": { "type": "http", "url": "http://127.0.0.1:9877/mcp" }
  }
}
```

```json
// VS Code (.vscode/mcp.json) — note the "servers" key
{
  "servers": { "vayu": { "type": "http", "url": "http://127.0.0.1:9877/mcp" } }
}
```

```toml
# Codex (~/.codex/config.toml)
[mcp_servers.vayu]
url = "http://127.0.0.1:9877/mcp"
```

### Client compatibility

MCP defines three transports: **stdio**, **Streamable HTTP**, and the legacy
**HTTP+SSE** (deprecated; not built for). The fixed-port Streamable HTTP endpoint
covers most clients with a single URL; Zed (stdio-only) uses the CLI below.

| Client           | Streamable HTTP    | stdio | Config location                                 |
| ---------------- | ------------------ | ----- | ----------------------------------------------- |
| **Claude Code**  | ✅ (`http`)        | ✅    | `.mcp.json`, `~/.claude.json`, `claude mcp add` |
| **Cursor**       | ✅                 | ✅    | `.cursor/mcp.json`, `~/.cursor/mcp.json`        |
| **VS Code**      | ✅ (`servers` key) | ✅    | `.vscode/mcp.json`                              |
| **OpenAI Codex** | ✅                 | ✅    | `~/.codex/config.toml`                          |
| **Zed**          | ❌ not yet         | ✅    | `context_servers` (stdio CLI)                   |

## Transports

### Streamable HTTP (primary)

`http.ts` hosts the endpoint on `127.0.0.1:9877/mcp`. It is **stateless**: each
`POST /mcp` gets a fresh SDK server + transport (`sessionIdGenerator: undefined`,
`enableJsonResponse: true`); `GET`/`DELETE` return `405`; non-`/mcp` paths `404`.
DNS-rebinding protection is on (Host must be `127.0.0.1:9877` / `localhost:9877`).
The per-request rebuild means Settings changes (allowlist, caps, disabled tools)
take effect on the next request with no extra bookkeeping.

### stdio CLI (Zed / headless / CI)

`cli.ts` is a standalone stdio server that reuses the same server factory and
tool registry. It is for stdio-only clients (Zed) and headless/CI. Run:

```bash
node dist-electron/mcp/cli.js
```

Configuration comes from environment variables (see [Configuration](#configuration)),
since there is no Settings UI. It still requires a running engine.

### What is live on each transport

Elicitation (human confirmation) and `tools/list_changed` (live tool-set updates)
need a server→client channel, which exists on **stdio** but not on the stateless
HTTP host. On HTTP they degrade gracefully: load-run confirmation falls back to a
`confirmed: true` flag, and a tool toggle applies on the client's next
`tools/list`. Both are safe on HTTP, just not instantaneous. See
[Design notes](#design-notes).

## Tools

Every tool carries a `category` (surfaced in Settings for enable/disable), MCP
**annotations** (`readOnlyHint` / `destructiveHint` / `idempotentHint` /
`openWorldHint` + a display title), and a **Zod** input schema (arguments are
validated by the SDK). A few declare an `outputSchema` and return validated
`structuredContent` alongside the text rendering.

| Tool                   | Category | Maps to                                      | Gate                       |
| ---------------------- | -------- | -------------------------------------------- | -------------------------- |
| `get_engine_health`    | read     | `GET /health` (structured)                   | —                          |
| `list_collections`     | read     | `GET /collections`                           | —                          |
| `list_requests`        | read     | `GET /requests?collectionId=`                | —                          |
| `list_environments`    | read     | `GET /environments`                          | —                          |
| `list_runs`            | read     | `GET /runs`                                  | —                          |
| `get_run_report`       | read     | `GET /run/:id/report`                        | —                          |
| `get_engine_config`    | read     | `GET /config`                                | —                          |
| `run_request`          | write    | `POST /request`                              | allowlist                  |
| `create_request`       | write    | `POST /requests`                             | write toggle               |
| `update_environment`   | write    | `GET`+`POST /environments` (fetch-merge)     | write toggle               |
| `update_engine_config` | write    | `POST /config`                               | write toggle               |
| `run_collection_smoke` | write    | `GET /requests?…` + `POST /request` (×N)     | allowlist per host         |
| `start_load_run`       | load     | `POST /run`                                  | allowlist + caps + confirm |
| `stop_run`             | load     | `POST /run/:id/stop`                         | —                          |
| `get_live_metrics`     | load     | SSE snapshot of last N ticks                 | —                          |
| `compare_runs`         | load     | 2× `GET /run/:id/report` → diff (structured) | —                          |

Notes:

- **`start_load_run`** requires confirmation — via elicitation when the client
  supports it, otherwise a `confirmed: true` flag — and enforces the RPS /
  concurrency / duration caps. `get_live_metrics` is a **bounded snapshot** (SSE
  read with a time budget), not a stream — `tools/call` stays request/response.
- **`update_environment`** fetches the environment and merges the supplied
  variables (the engine's upsert replaces the whole variables blob), so partial
  updates preserve untouched variables and the name.
- **`run_collection_smoke`** runs each saved request once and returns a structured
  pass/fail matrix (2xx–3xx status + all tests passing = pass). Requests whose
  host can't be verified (e.g. unresolved `{{variables}}` with allow-all off) are
  skipped, not sent.
- **Cancellation:** each tool call's `AbortSignal` is threaded into the engine
  `fetch`, so a client cancelling an in-flight call actually aborts it.

## Resources

Read-only Vayu data an agent can attach as context (`resources.ts`):

| URI                         | Contents                         |
| --------------------------- | -------------------------------- |
| `vayu://runs`               | All runs, newest first.          |
| `vayu://collections`        | All request collections.         |
| `vayu://environments`       | All environments.                |
| `vayu://config`             | Engine configuration entries.    |
| `vayu://run/{runId}/report` | A run's full report (templated). |

The templated report resource has a **list** callback (enumerates recent runs so
each shows in `resources/list`) and a **completion** callback (autocompletes run
IDs).

## Prompts

Server-provided starting points a user picks in their client (`prompts.ts`):

| Prompt                 | Arguments                | Produces                                                    |
| ---------------------- | ------------------------ | ----------------------------------------------------------- |
| `summarize_run`        | `runId`                  | The run report + a "summarize p50/p95/p99, errors, health". |
| `compare_runs`         | `baseRunId, targetRunId` | The computed delta + "did this regress?".                   |
| `diagnose_errors`      | `runId`                  | The report + an error-focused diagnosis prompt.             |
| `suggest_load_profile` | `url, goal?`             | Guidance to design a `start_load_run` (no engine data).     |

## Safety model

Enforced entirely in the MCP layer (`safety.ts`, `config.ts`); the engine is
never modified. All configurable in **Settings → MCP** and persisted.

- **Target allowlist** (default empty ⇒ deny all). Network-touching tools refuse
  off-list hosts with an actionable error. An **"Allow all hosts"** opt-in
  bypasses the list (still rejects unresolved `{{variables}}`); off by default.
- **Hard caps** — max RPS / concurrency / duration on `start_load_run`; over-cap
  requests are rejected. With the allowlist, these are the real limits on load.
- **Load-run confirmation** — anti-accident, not anti-adversary: it stops a stray
  tool call from starting load, but on HTTP it is agent-side (the caps/allowlist
  are the enforcement). Elicitation upgrades it to a human prompt where supported.
- **Write toggle** (`allowWrites`, default off) — gates the data-mutating tools
  `create_request`, `update_environment`, `update_engine_config`. Does not gate
  `run_request` / `run_collection_smoke` / load runs (allowlist + caps).
- **Per-tool control** — any tool or whole read/write/load category can be
  switched off; a disabled tool is omitted from `tools/list` **and** rejected by
  `tools/call`.
- **Server on/off** — the whole server can be disabled; while off the endpoint
  does not accept connections. Persists across restarts.
- **Transport hardening** — loopback bind, Host-header (DNS-rebinding) validation,
  `POST`-only, 4 MB body cap.

**Why no auth token on the endpoint:** any local process could already reach the
engine's REST API on `:9876`; the MCP endpoint proxies the same capability behind
_more_ guards and adds DNS-rebinding protection. It grants no capability a local
process did not already have.

### Safety config

`McpSafetyConfig` (defaults in parentheses):

| Field                | Default | Meaning                                       |
| -------------------- | ------- | --------------------------------------------- |
| `allowlist`          | `[]`    | Permitted hostnames (empty = deny all).       |
| `allowAll`           | `false` | Bypass the allowlist for any resolvable host. |
| `maxRps`             | `1000`  | Cap on `targetRps`.                           |
| `maxConcurrency`     | `200`   | Cap on `concurrency`.                         |
| `maxDurationSeconds` | `300`   | Cap on load-run duration.                     |
| `allowWrites`        | `false` | Enable the data-mutating tools.               |
| `disabledTools`      | `[]`    | Tool names to hide/reject.                    |

The renderer never sets these directly: `main.ts` sanitizes every change
(`sanitizeSafetyInput` — normalizes/de-dupes hosts, clamps caps to positive
integers, validates `disabledTools` against the tool catalog) before applying it
live and writing it to disk.

## Architecture

Everything lives under `app/electron/mcp/` and is managed by `main.ts` alongside
`EngineSidecar`.

| File               | Responsibility                                                      |
| ------------------ | ------------------------------------------------------------------- |
| `config.ts`        | `McpSafetyConfig`, safe defaults, input sanitizer, host normalizer. |
| `safety.ts`        | Pure guards: allowlist, load caps, duration parsing.                |
| `engine-client.ts` | Thin `fetch` client to the engine REST API + SSE metrics snapshot.  |
| `compare.ts`       | Pure two-report diff for `compare_runs`.                            |
| `tools.ts`         | Tool registry (schemas, annotations, handlers) + `dispatchTool`.    |
| `resources.ts`     | Static + templated resource definitions.                            |
| `prompts.ts`       | Prompt definitions (build messages from engine data).               |
| `server.ts`        | Builds the SDK `McpServer`; registers tools/resources/prompts.      |
| `http.ts`          | Stateless Streamable HTTP host (DNS-rebinding on).                  |
| `cli.ts`           | Standalone stdio server (env-configured).                           |
| `connect.ts`       | One-click connect: shells out to `claude` / `code` CLIs.            |
| `store.ts`         | Persist safety config + enabled preference (`electron-store`).      |
| `index.ts`         | `VayuMcpService` facade consumed by `main.ts`.                      |

### Lifecycle & IPC

`main.ts` starts the server in `app.whenReady()` (skipped if disabled), stops it
on quit, and exposes IPC the Settings panel uses:

| IPC handler         | Purpose                                                     |
| ------------------- | ----------------------------------------------------------- |
| `mcp:status`        | `{ running, url, enabled }`.                                |
| `mcp:getSafety`     | Current `McpSafetyConfig`.                                  |
| `mcp:updateSafety`  | Sanitize, apply live, persist; returns the resolved config. |
| `mcp:setEnabled`    | Start/stop the server, persist the preference.              |
| `mcp:getTools`      | IPC-safe tool catalog (name/description/category/readOnly). |
| `mcp:connectClient` | Run a client's add-CLI (`claude` / `code`).                 |

The panel (`app/src/modules/settings/main/panels/McpSettingsPanel.tsx`) is a
registered app-settings panel; it talks to `window.electronAPI` directly since
MCP config is app-level, not engine-level.

## Configuration

The Electron-hosted server reads config from Settings. The **stdio CLI** reads it
from environment variables:

| Variable                        | Default                 | Meaning                                |
| ------------------------------- | ----------------------- | -------------------------------------- |
| `VAYU_ENGINE_URL`               | `http://127.0.0.1:9876` | Engine base URL.                       |
| `VAYU_VERSION`                  | `0.0.0`                 | Version reported to clients.           |
| `VAYU_MCP_ALLOWLIST`            | (empty)                 | Comma-separated hostnames.             |
| `VAYU_MCP_ALLOW_ALL`            | `false`                 | `true` bypasses the allowlist.         |
| `VAYU_MCP_MAX_RPS`              | `1000`                  | RPS cap.                               |
| `VAYU_MCP_MAX_CONCURRENCY`      | `200`                   | Concurrency cap.                       |
| `VAYU_MCP_MAX_DURATION_SECONDS` | `300`                   | Duration cap.                          |
| `VAYU_MCP_ALLOW_WRITES`         | `false`                 | `true` enables the data-write tools.   |
| `VAYU_MCP_DISABLED_TOOLS`       | (empty)                 | Comma-separated tool names to disable. |

## Design notes

Rationale behind the load-bearing decisions.

### TypeScript sidecar over in-engine C++

MCP could have been hosted inside the C++ engine (zero hop, single binary). The
deciding factor: **there is no official C++ SDK**, so in-engine would mean owning
the protocol in C++ or betting on a pre-1.0 community lib — right as the spec
churns (the
[2026-07-28 RC](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
removed the GET stream endpoint and protocol-level sessions). The official TS SDK
absorbs that churn, Node is already the Electron runtime, and the engine stays
untouched (keeping it AGPL-clean). The accepted tradeoff: MCP is up when the
**app** is open, not engine-only — covered later by the stdio CLI for headless use.

### Stateless HTTP, and the server→client push gap

The HTTP host is stateless (fresh server per request), which keeps Settings
changes live for free and aligns with the spec RC that removed protocol sessions
and the GET stream. The cost is that `tools/list_changed` and elicitation can't be
**pushed** over HTTP (no held-open stream), so they fall back as described in
[Transports](#what-is-live-on-each-transport). Making them live would require a
stateful server (real `sessionIdGenerator`, SSE responses, a GET stream per
session, persistent per-session servers mutated on toggle) — deferred, since it
builds on the mechanism the spec is deprecating and the payoff is client-dependent.

## Deferred

- **MCP-originated run tagging** — tag runs started via MCP so History shows
  provenance.
- **`vayu mcp` bin** — package the stdio CLI as a first-class command (backlog M1).
- **Live push over HTTP** — stateful sessions (see Design notes).
- **Hosted MCP for Vayu Cloud** — OAuth-gated, remote.

## References

- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) ·
  [Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- Client docs: [Claude Code](https://code.claude.com/docs/en/mcp) ·
  [Codex](https://developers.openai.com/codex/mcp) ·
  [Cursor](https://cursor.com/docs/mcp)
- Engine API surface: [`api-reference.md`](./api-reference.md) · Threat model:
  [`SECURITY.md`](../../SECURITY.md)
