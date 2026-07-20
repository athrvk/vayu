# Vayu MCP Server — Design & Decisions

> **Status:** Implemented (V1 + V2 tools). A TypeScript MCP server is hosted in
> the Electron main process (`app/electron/mcp/`), exposing Vayu to agents like
> Claude Code, Codex, and Cursor over Streamable HTTP. This document captures the
> design and decisions behind it.

## Vision (locked)

**MCP is a capability Vayu hosts, not a separate product to run.** Once Vayu is
running, any agent (Claude Code, Cursor, Zed, Claude Desktop) opts in with **one
command** — no install, no extra process to spawn, no lifecycle to manage. If
Vayu is up, the tools are live; if not, the agent gets a clean "start Vayu"
error.

The deliverable is not "an MCP server" users run — it is an **MCP capability the
app already exposes**, that any agent opts into with a single command.

## Architecture decision (locked): TypeScript sidecar in the Electron main process

MCP is served by a **TypeScript server hosted inside the Electron main process**,
using the **official [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)**,
over **Streamable HTTP** on a fixed local port (`:9877/mcp`). It proxies to the
engine's existing REST API on `:9876`. The C++ engine is **not modified**.

| #   | Decision                                                                                                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Build MCP by exposing Vayu's existing engine capabilities as MCP tools.                                                                                                                                                                                                 |
| D2  | **TypeScript, official `@modelcontextprotocol/sdk`.** First-party and actively maintained — it tracks spec churn for us. No bet on a pre-1.0 community SDK.                                                                                                             |
| D3  | **Streamable HTTP transport at `/mcp` on a dedicated local port (`:9877`).** Keeps the one-command, connect-to-already-running-Vayu property.                                                                                                                           |
| D4  | **Hosted in the Electron main process**, managed like the existing `EngineSidecar` (see `app/electron/main.ts`). Node is already the Electron runtime — no new toolchain.                                                                                               |
| D5  | **Proxies the engine REST API** (`http://127.0.0.1:9876`) via `fetch`. Reuses the engine's REST contract; shares TS request/response types where the main/renderer build boundary allows (main cannot import renderer `@/services`), otherwise a thin main-side client. |
| D6  | **Local-only, `127.0.0.1`.**                                                                                                                                                                                                                                            |
| D7  | Safety rails are **MVP-gating, not polish** (an LLM driving a traffic generator is the one real risk). Enforced in the MCP layer.                                                                                                                                       |
| D8  | **Engine stays untouched** → the MCP layer is Apache-2.0, like the rest of the app. No changes to the AGPL engine surface.                                                                                                                                              |
| D9  | **Origin/Host header validation on `/mcp` is MVP-gating** — MCP spec-mandated, prevents DNS-rebinding from a browser tab hitting `127.0.0.1:9877`.                                                                                                                      |

### Why TS sidecar over in-engine C++

We seriously considered hosting MCP inside the C++ engine (zero hop, single
binary). The deciding factor: **there is no official C++ SDK**, so in-engine
means either owning the protocol in C++ or betting on a pre-1.0, single-org
community lib — right as the spec is churning fast (the
[2026-07-28 RC](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
removed the GET stream endpoint and protocol-level sessions and added
`Mcp-Method`/`Mcp-Name` routing headers). The official TS SDK absorbs that churn.

|                         | Electron TS sidecar (**chosen**)                | In-engine C++ (considered)                |
| ----------------------- | ----------------------------------------------- | ----------------------------------------- |
| Spec-churn maintenance  | Official SDK tracks it                          | We own it, or bet on a beta community lib |
| Dependency risk         | First-party, battle-tested                      | pre-1.0, single-org                       |
| Runtime                 | Node already in Electron                        | native                                    |
| Engine code changes     | **None**                                        | New routes in the AGPL engine             |
| Type reuse              | Shares app TS types (build boundary permitting) | Calls engine internals directly           |
| Latency                 | One local hop (same hop the UI makes)           | Zero hop — _marginal_ locally             |
| "Vayu is running" means | The **app** is open                             | The **engine** is up (works headless)     |

The one real tradeoff accepted: MCP is up when the **app** is open, not
engine-only. For the target user (desktop Vayu + Claude Code) that is no
different — the app is the thing they open. In-engine's only edge is a
headless/engine-only deployment, which is out of V1 scope and is better covered
later by a standalone `vayu mcp` Node CLI that reuses the _same_ TS server code
(see "Considered & deferred").

### SDK landscape (as of research)

**No official MCP C++ SDK exists.** Official SDKs: **TypeScript** (chosen),
Python, Go, C#/.NET, Kotlin, Java, Swift, Ruby, Rust. The C++ community options
below were surveyed while considering in-engine hosting and are **deferred**, not
adopted:

| Option                                                              | Transport fit                            | Notes                                                                                                                                                 |
| ------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`mcp-cpp`](https://github.com/Neumann-Labs/mcp-cpp) (Neumann-Labs) | Streamable HTTP + stdio                  | Best-fit C++ option: `cpp-httplib` + `nlohmann-json`, Apache-2.0, GTest, C++20. Beta, single-org — kept as the reference if in-engine is ever needed. |
| [`cpp-mcp`](https://github.com/hkr04/cpp-mcp) (hkr04)               | stdio + **old deprecated** HTTP+SSE only | No Streamable HTTP.                                                                                                                                   |
| [`gopher-mcp`](https://github.com/GopherSecurity/gopher-mcp)        | HTTP                                     | Own networking/event layer would fight engine internals. Rejected.                                                                                    |

## Onboarding (locked)

```bash
# one time, per machine
claude mcp add --transport http vayu http://127.0.0.1:9877/mcp
```

- Non-CLI: a **"Connect to Claude Code" button** in the app writes that config
  and prints the URL for other agents.
- The same URL works across all Streamable-HTTP clients (see compatibility below).
- Requires the Vayu app to be running when the client connects.

## Client compatibility & config (researched)

MCP defines three transports: **stdio**, **Streamable HTTP**, and the legacy
**HTTP+SSE** (deprecated in spec 2025-03-26 — we do **not** build for it).
Streamable HTTP is the modern remote/multi-client transport and is the right fit
for our always-running-app model. Support as of mid-2026:

| Client                                         | stdio | Streamable HTTP                      | Legacy SSE    | Config location                                        | `url`-based entry works? |
| ---------------------------------------------- | ----- | ------------------------------------ | ------------- | ------------------------------------------------------ | ------------------------ |
| **Claude Code**                                | ✅    | ✅ (`http`, alias `streamable-http`) | ⚠️ deprecated | `.mcp.json`, `~/.claude.json`, `claude mcp add(-json)` | ✅                       |
| **OpenAI Codex** (CLI / ChatGPT desktop / IDE) | ✅    | ✅                                   | ❌            | `~/.codex/config.toml`, `.codex/config.toml` (TOML)    | ✅                       |
| **Cursor**                                     | ✅    | ✅                                   | ⚠️            | `.cursor/mcp.json`, `~/.cursor/mcp.json`               | ✅                       |
| **Zed**                                        | ✅    | ❌ **not yet**                       | ⚠️            | `context_servers` in settings                          | ❌ — stdio only          |

**Takeaway:** our fixed-port Streamable HTTP endpoint covers Claude Code, Codex,
and Cursor with a single URL — no per-client server variants. **Zed is the lone
exception** (no Streamable HTTP yet); it needs a stdio entry, which the deferred
`vayu mcp` Node CLI (stdio mode) covers when we choose to support it.

Concrete entries for the same `:9877/mcp` endpoint:

```bash
# Claude Code
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

```toml
# Codex (~/.codex/config.toml) — presence of `url` selects Streamable HTTP
[mcp_servers.vayu]
url = "http://127.0.0.1:9877/mcp"
```

## Protocol surface

Built on the SDK's high-level **`McpServer`** (`server.ts`), so JSON-RPC framing,
the `initialize` handshake, and capability negotiation are handled for us. What
we use:

- **`tools/*`** — the tool set below, registered via `registerTool` with **Zod**
  input schemas (arguments validated by the SDK before the handler runs) and MCP
  **tool annotations** (`readOnlyHint` / `destructiveHint` / `idempotentHint` /
  `openWorldHint` + a display `title`) so clients can gate auto-approval.
- **Structured output** — tools with a natural shape (`get_engine_health`,
  `compare_runs`) declare an `outputSchema` and return validated
  `structuredContent` alongside the text rendering.
- **Elicitation** — `start_load_run` asks the human to confirm via the client
  (`server.elicitInput`) when the client negotiated the `elicitation` capability;
  otherwise it falls back to the `confirmed: true` flag. Elicitation needs a
  bidirectional channel, so it works on stdio and in-memory transports; on the
  stateless JSON HTTP host (no server→client push) the flag fallback is used.
- **`tools/list_changed`** — advertised by `McpServer` (the capability is on);
  effective for stdio, and a no-op push-wise on the stateless HTTP host.
- **Cancellation** — each tool call's `AbortSignal` (`extra.signal`) is threaded
  into the engine `fetch`, so a client cancelling an in-flight `run_request` /
  `start_load_run` actually aborts the underlying engine call (combined with the
  client's own per-request timeout via `AbortSignal.any`).
- **Server identity** — the server's `Implementation` carries `title` ("Vayu"),
  a one-paragraph `description` of what Vayu is, and `websiteUrl`, alongside the
  `instructions`, so a connecting agent knows what it's talking to.
- **Resources** (`resources/*`, `resources.ts`) — read-only Vayu data an agent
  can attach as context: static `vayu://runs`, `vayu://collections`,
  `vayu://environments`, `vayu://config`, and a templated
  `vayu://run/{runId}/report` with a `list` callback (enumerate recent runs) and
  a `complete` callback (autocomplete run IDs — MCP completions).
- **Prompts** (`prompts/*`, `prompts.ts`) — server-provided starting points the
  user picks from their client: `summarize_run`, `compare_runs`,
  `diagnose_errors` (each embeds the relevant report/comparison inline) and
  `suggest_load_profile` (guidance, no engine data).

Not used: sampling, roots, logging, sessions, OAuth (see "Considered & deferred").

## Safety model (locked approach)

Enforced in the TS MCP layer (configurable from app Settings):

- **Target allowlist** (default empty) — network-touching tools refuse off-list
  hosts with an actionable error. An **"Allow all hosts"** opt-in bypasses the
  list (still rejects unresolved `{{variables}}`); off by default. **Enforcement.**
- **Hard caps** — max RPS / concurrency / duration; over-cap requests rejected.
  **Enforcement** — with the allowlist these are the real limits on generated load.
- **Confirmation gate** on load-run start — prevents an _accidental_ start (a
  stray tool call), but it is agent-side (the same model can send the second
  call), so it is anti-accident, not anti-adversary. The caps/allowlist are the
  enforcement. A stronger version would use MCP elicitation to ask the human.
- **Config writes off by default** — `update_engine_config` is refused unless the
  user enables config writes. Does **not** gate `run_request` or load runs.
- **Per-tool control** — any tool or read/write/load category can be switched
  off; disabled tools are omitted from `tools/list` and rejected by `tools/call`.
- **Server on/off** — the MCP server can be disabled entirely from Settings; the
  preference persists, and while off the endpoint is unavailable.
- MCP-originated runs tagged so the History view shows "started via MCP."

The server toggle, allowlist (incl. allow-all), caps, config-write toggle, and
per-tool switches are editable in **Settings → MCP** and persisted across
restarts (see "Resolved: safety-config storage & UI").

**Fixed port, fail-soft.** The endpoint is a fixed `127.0.0.1:9877` so the
connect snippets/commands are stable across launches. A bind failure (port in
use) is logged and the app continues without MCP rather than failing startup;
Settings shows a "Stopped" state with a Retry. This fixed-port + fail-soft
tradeoff is accepted deliberately.

## Tool scope phasing

### V1 — wedge (validate demand): read + single-shot execute

| Tool                | Maps to                             |
| ------------------- | ----------------------------------- |
| `get_engine_health` | `GET /health`                       |
| `list_collections`  | `GET /collections`                  |
| `list_requests`     | `GET /requests?collectionId=`       |
| `list_environments` | `GET /environments`                 |
| `list_runs`         | `GET /runs`                         |
| `get_run_report`    | `GET /run/:runId/report`            |
| `get_engine_config` | `GET /config`                       |
| `run_request`       | `POST /request` (allowlist applies) |

### Configuration tools

- `get_engine_config` — `GET /config` (read; the engine's tunables with value /
  default / type / range).
- `update_engine_config` — `POST /config`, **gated by the write toggle**
  (`allowWrites`); the engine validates types/ranges and rejects the batch on any
  invalid value.

### Write tools

- `create_request` — `POST /requests` (**write-toggle gated**); saves a request
  into a collection. Not executed, so no allowlist check.
- `update_environment` — fetch `GET /environments/:id`, merge the supplied
  variables, `POST /environments` (**write-toggle gated**). The upsert replaces
  the variables blob, so the merge preserves untouched variables and the name.
- `run_collection_smoke` — `GET /requests?collectionId=` then one `POST /request`
  per saved request; **allowlist-gated per host** (unverifiable hosts, e.g.
  unresolved `{{variables}}` with allow-all off, are skipped). Returns a
  structured pass/fail matrix (2xx-3xx status + all tests passing = pass). Sends
  real traffic; does not modify Vayu data.

### Tool categories & per-tool control

Every tool carries a `category` (`read` / `write` / `load`). The Settings tool
list groups them by category and lets the user switch any tool (or a whole
category) off. A disabled tool is omitted from `tools/list` **and** rejected by
`tools/call`, so control does not rely on client good behavior. The disabled set
persists in `disabledTools`.

### V2 — load testing (the real value)

- `start_load_run` — `POST /run`, confirmation-gated, caps-enforced
- `stop_run` — `POST /run/:runId/stop`
- `get_live_metrics` — snapshot of last N ticks (not a stream; `tools/call` is
  request/response)
- `compare_runs` — server-side p50/p95/p99 / error-rate / status-mix diff
  ("did my PR regress?" — highest agentic value)

### V3 — ergonomics & reach

- ~~MCP `prompts/`~~ — **shipped** (`prompts.ts`): `summarize_run`,
  `compare_runs`, `diagnose_errors`, `suggest_load_profile`.
- ~~MCP `resources/`~~ — **shipped** (`resources.ts`): `vayu://run/{runId}/report`
  (templated, with list + completion) plus static `vayu://runs` /
  `collections` / `environments` / `config`.
- ~~`create_request` / `update_environment` (writes, behind settings flag)~~ —
  **shipped**: both gated by the write toggle (`allowWrites`);
  `update_environment` fetches + merges variables so partial updates don't wipe
  the rest.
- ~~`run_collection_smoke` (pass/fail matrix over a collection)~~ — **shipped**:
  executes each saved request once (allowlist-gated per host) and returns a
  structured pass/fail matrix (2xx-3xx + passing tests = pass).
- Hosted MCP for Vayu Cloud, OAuth-gated (someday).

## Implementation (as built)

Everything lives under `app/electron/mcp/` and is managed by `main.ts` alongside
`EngineSidecar` (started in `app.whenReady()` via `startMcp()`, stopped on quit,
with an `mcp:status` IPC handler mirroring `engine:status`). `MCP_HOST`/
`MCP_PORT` (`127.0.0.1:9877`) and `MCP_ENDPOINT_URL` live in
`app/electron/constants.ts`.

| File               | Responsibility                                                               |
| ------------------ | ---------------------------------------------------------------------------- |
| `config.ts`        | `McpSafetyConfig` + safe defaults (empty allowlist, caps, no writes)         |
| `safety.ts`        | Pure guards: allowlist, load caps, duration parsing (unit-tested)            |
| `engine-client.ts` | Thin `fetch` client to the engine REST API + SSE metrics snapshot            |
| `compare.ts`       | Pure two-report diff for `compare_runs` (unit-tested)                        |
| `tools.ts`         | Tool registry + dispatch; applies guards, maps to engine calls (unit-tested) |
| `server.ts`        | Builds the SDK `Server`, wires `tools/list` + `tools/call`                   |
| `http.ts`          | Streamable HTTP host (stateless per-request, DNS-rebinding protection on)    |
| `cli.ts`           | Standalone stdio server reusing the same registry (Zed / headless)           |
| `index.ts`         | `VayuMcpService` facade consumed by `main.ts`                                |

Notes:

- **Stateless transport:** each POST `/mcp` gets a fresh `Server` + transport;
  GET/DELETE return `405`. Suits a low-traffic local proxy, no session state.
- **Engine client:** the Electron main process cannot import the renderer's
  `@/services`, so `engine-client.ts` is a minimal standalone `fetch` wrapper.
- **Best-effort startup:** an MCP bind failure logs and continues — it never
  blocks the app or the engine.
- **License:** Apache-2.0 (app). Engine untouched.

## Setup

Ensure Vayu is running, then register the endpoint once per machine:

```bash
# Claude Code
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
  "servers": {
    "vayu": { "type": "http", "url": "http://127.0.0.1:9877/mcp" }
  }
}
```

```toml
# Codex (~/.codex/config.toml)
[mcp_servers.vayu]
url = "http://127.0.0.1:9877/mcp"
```

**Zed / headless / CI** (stdio, no Streamable HTTP): run the standalone server
`node dist-electron/mcp/cli.js`. It honours `VAYU_ENGINE_URL` and
`VAYU_MCP_ALLOWLIST` / `VAYU_MCP_ALLOW_ALL` / `VAYU_MCP_MAX_RPS` /
`VAYU_MCP_MAX_CONCURRENCY` / `VAYU_MCP_MAX_DURATION_SECONDS` /
`VAYU_MCP_ALLOW_WRITES` / `VAYU_MCP_DISABLED_TOOLS` (comma-separated tool names).

Safety defaults are conservative (empty allowlist ⇒ no outbound requests until a
host is added). See `SECURITY.md`.

## Considered & deferred

- **In-engine C++ over Streamable HTTP** (via `mcp-cpp`) — revisit only if an
  engine-only deployment (no app, no Node) becomes a hard requirement.
- **Stateful Streamable HTTP (server→client push over HTTP).** `list_changed`
  and elicitation only work where the server can push to the client. On stdio
  that channel exists, so both are live; on our **stateless** HTTP host it does
  not, so tool toggles apply on the client's next `tools/list` and load-run
  confirmation falls back to the `confirmed` flag. It is technically feasible to
  make them live over HTTP by running **stateful**: a real `sessionIdGenerator`,
  SSE responses, a held-open GET stream per session, persistent per-session
  `McpServer`s, and fanning `RegisteredTool.enable()/.disable()` out to every
  live session on a Settings toggle (plus making `ToolContext.config` a live
  reference instead of the current fresh-per-POST snapshot). **Deferred**, for
  two reasons: (1) the [2026-07-28 spec RC](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
  **removed the GET stream endpoint and protocol-level sessions** — so this
  builds on the exact mechanism the spec is deprecating, while our stateless
  request/response design is aligned with where it's heading; and (2) the payoff
  is client-dependent (only clients that open the GET stream benefit) and mostly
  cosmetic — the stateless fallbacks are already _safe_, just not _live_.
  Revisit once the spec's replacement for server→client messaging settles.

## Resolved

- **V1 + V2 shipped together** in one branch (read, single-request execute, and
  load tools) rather than a wedge-first split.
- **Live metrics = bounded snapshot** (last N ticks, SSE read with a time
  budget) — `tools/call` stays request/response.
- **Allowlist granularity = per-host** for now.
- **stdio CLI built** (`cli.ts`) to cover Zed and headless/CI.

## Open questions (still a call)

1. **MCP-originated run tagging** — tag runs started via MCP so History shows
   provenance (needs a small field on the run payload/metadata).
2. **Packaging the stdio CLI** — expose it as a `vayu mcp` bin / documented
   `node` entrypoint in the installer.

### Resolved: safety-config storage & UI

The server toggle, allowlist (incl. allow-all), caps, and write toggle are now
editable from **Settings → MCP** and persisted in the Electron main process
(`electron-store`, `mcp-config.json`), so they survive a restart. The panel is a
registered app-settings panel and also shows live connection status and the
connect snippets (Claude Code / VS Code / Cursor / Codex). Flow:

- `electron/mcp/store.ts` persists both the safety override and the
  enabled/disabled preference. On startup `main.ts` skips `startMcp()` when
  disabled, and otherwise merges the persisted override onto the safe defaults
  and passes it to `VayuMcpService`.
- `mcp:getSafety` / `mcp:updateSafety` read and apply safety changes;
  `mcp:setEnabled` starts/stops the server live and persists the preference;
  `mcp:status` reports `{ running, url, enabled }`. Renderer input is sanitized
  in `main.ts` via `sanitizeSafetyInput` (normalizes + de-dupes hosts, clamps
  caps, coerces the `allowAll` flag) before it is applied and written to disk.
- **One-click connect.** For clients with an add-CLI, a **Connect** button
  registers Vayu automatically: `mcp:connectClient` (`electron/mcp/connect.ts`)
  shells out to `claude mcp add --transport http --scope user vayu <url>`
  (Claude Code) or `code --add-mcp <json>` (VS Code). The binary is resolved
  through a login shell (`command -v`) to survive a GUI app's stripped PATH,
  then spawned with an argument array. If the CLI isn't installed it returns
  `cli-not-found` and the UI falls back to the copy snippet. Cursor / Codex have
  no add-CLI, so they stay copy-only.
- The panel (`app/src/modules/settings/main/panels/McpSettingsPanel.tsx`) is
  cards-only and auto-persisting, and talks to `window.electronAPI` directly
  rather than the engine config query, since MCP config is app-level.

## References

- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) · [MCP SDKs](https://modelcontextprotocol.io/docs/sdk)
- [Streamable HTTP transport spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) · [2026-07-28 RC](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
- Client MCP docs: [Claude Code](https://code.claude.com/docs/en/mcp) · [Codex](https://developers.openai.com/codex/mcp) · [Cursor](https://cursor.com/docs/mcp) · [Zed streamable-HTTP gap](https://github.com/zed-industries/zed/discussions/29370)
- C++ libs (deferred): [`mcp-cpp`](https://github.com/Neumann-Labs/mcp-cpp) · [`cpp-mcp`](https://github.com/hkr04/cpp-mcp) · [`gopher-mcp`](https://github.com/GopherSecurity/gopher-mcp)
- Engine API surface: [`docs/engine/api-reference.md`](./api-reference.md)
