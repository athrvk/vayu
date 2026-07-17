# Vayu MCP Server — Design & Decisions

> **Status:** Planning (no code yet). This document captures the finalized
> direction for exposing Vayu as a Model Context Protocol (MCP) server, so agents
> like Claude Code can drive it.

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

| #   | Decision |
| --- | --- |
| D1  | Build MCP by exposing Vayu's existing engine capabilities as MCP tools. |
| D2  | **TypeScript, official `@modelcontextprotocol/sdk`.** First-party and actively maintained — it tracks spec churn for us. No bet on a pre-1.0 community SDK. |
| D3  | **Streamable HTTP transport at `/mcp` on a dedicated local port (`:9877`).** Keeps the one-command, connect-to-already-running-Vayu property. |
| D4  | **Hosted in the Electron main process**, managed like the existing `EngineSidecar` (see `app/electron/main.ts`). Node is already the Electron runtime — no new toolchain. |
| D5  | **Proxies the engine REST API** (`http://127.0.0.1:9876`) via `fetch`. Reuses the engine's REST contract; shares TS request/response types where the main/renderer build boundary allows (main cannot import renderer `@/services`), otherwise a thin main-side client. |
| D6  | **Local-only, `127.0.0.1`.** |
| D7  | Safety rails are **MVP-gating, not polish** (an LLM driving a traffic generator is the one real risk). Enforced in the MCP layer. |
| D8  | **Engine stays untouched** → the MCP layer is Apache-2.0, like the rest of the app. No changes to the AGPL engine surface. |
| D9  | **Origin/Host header validation on `/mcp` is MVP-gating** — MCP spec-mandated, prevents DNS-rebinding from a browser tab hitting `127.0.0.1:9877`. |

### Why TS sidecar over in-engine C++

We seriously considered hosting MCP inside the C++ engine (zero hop, single
binary). The deciding factor: **there is no official C++ SDK**, so in-engine
means either owning the protocol in C++ or betting on a pre-1.0, single-org
community lib — right as the spec is churning fast (the
[2026-07-28 RC](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
removed the GET stream endpoint and protocol-level sessions and added
`Mcp-Method`/`Mcp-Name` routing headers). The official TS SDK absorbs that churn.

| | Electron TS sidecar (**chosen**) | In-engine C++ (considered) |
| --- | --- | --- |
| Spec-churn maintenance | Official SDK tracks it | We own it, or bet on a beta community lib |
| Dependency risk | First-party, battle-tested | pre-1.0, single-org |
| Runtime | Node already in Electron | native |
| Engine code changes | **None** | New routes in the AGPL engine |
| Type reuse | Shares app TS types (build boundary permitting) | Calls engine internals directly |
| Latency | One local hop (same hop the UI makes) | Zero hop — *marginal* locally |
| "Vayu is running" means | The **app** is open | The **engine** is up (works headless) |

The one real tradeoff accepted: MCP is up when the **app** is open, not
engine-only. For the target user (desktop Vayu + Claude Code) that is no
different — the app is the thing they open. In-engine's only edge is a
headless/engine-only deployment, which is out of V1 scope and is better covered
later by a standalone `vayu mcp` Node CLI that reuses the *same* TS server code
(see "Considered & deferred").

### SDK landscape (as of research)

**No official MCP C++ SDK exists.** Official SDKs: **TypeScript** (chosen),
Python, Go, C#/.NET, Kotlin, Java, Swift, Ruby, Rust. The C++ community options
below were surveyed while considering in-engine hosting and are **deferred**, not
adopted:

| Option | Transport fit | Notes |
| --- | --- | --- |
| [`mcp-cpp`](https://github.com/Neumann-Labs/mcp-cpp) (Neumann-Labs) | Streamable HTTP + stdio | Best-fit C++ option: `cpp-httplib` + `nlohmann-json`, Apache-2.0, GTest, C++20. Beta, single-org — kept as the reference if in-engine is ever needed. |
| [`cpp-mcp`](https://github.com/hkr04/cpp-mcp) (hkr04) | stdio + **old deprecated** HTTP+SSE only | No Streamable HTTP. |
| [`gopher-mcp`](https://github.com/GopherSecurity/gopher-mcp) | HTTP | Own networking/event layer would fight engine internals. Rejected. |

## Onboarding (locked)

```bash
# one time, per machine
claude mcp add --transport http vayu http://127.0.0.1:9877/mcp
```

- Non-CLI: a **"Connect to Claude Code" button** in the app writes that config
  and prints the URL for other agents.
- The same URL works across all Streamable-HTTP clients (Cursor, Zed, Desktop).
- Requires the Vayu app to be running when the client connects.

## Protocol surface (V1)

The official SDK handles JSON-RPC framing, the `initialize`/`initialized`
handshake, and capability negotiation. We register:

- `tools/*` — the tool set below.
- *(later, optional)* `resources/*`, `prompts/*`.

We do **not** implement client-side features (sampling, elicitation).

## Safety model (locked approach)

Enforced in the TS MCP layer (configurable from app Settings):

- **Target allowlist** (default empty) — network-touching tools refuse off-list
  hosts with an actionable error.
- **Hard caps** — max RPS / concurrency / duration; over-cap requests rejected.
- **Confirmation gate** on load-run start.
- **Read-only by default** — collection/environment writes behind a toggle.
- MCP-originated runs tagged so the History view shows "started via MCP."

## Tool scope phasing

### V1 — wedge (validate demand): read + single-shot execute

| Tool | Maps to |
| --- | --- |
| `get_engine_health` | `GET /health` |
| `list_collections` | `GET /collections` |
| `list_requests` | `GET /requests?collectionId=` |
| `list_environments` | `GET /environments` |
| `list_runs` | `GET /runs` |
| `get_run_report` | `GET /run/:runId/report` |
| `run_request` | `POST /request` (allowlist applies) |

No load runs. No collection/environment writes.

### V2 — load testing (the real value)

- `start_load_run` — `POST /run`, confirmation-gated, caps-enforced
- `stop_run` — `POST /run/:runId/stop`
- `get_live_metrics` — snapshot of last N ticks (not a stream; `tools/call` is
  request/response)
- `compare_runs` — server-side p50/p95/p99 / error-rate / status-mix diff
  ("did my PR regress?" — highest agentic value)

### V3 — ergonomics & reach

- MCP `prompts/` ("summarize this run", "suggest a load profile", "diagnose
  error spike")
- MCP `resources/` (`vayu://run/{id}/report` as attachable context)
- `create_request` / `update_environment` (writes, behind settings flag)
- `run_collection_smoke` (pass/fail matrix over a collection)
- Hosted MCP for Vayu Cloud, OAuth-gated (someday)

## Implementation notes

- **Location:** `app/electron/` (e.g. `mcp-server.ts`), a class managed by
  `main.ts` alongside `EngineSidecar` — started in `app.whenReady()`, stopped on
  quit, with an `ipcMain` status handler mirroring `engine:status`.
- **Port:** add `MCP_PORT = 9877` to `app/electron/constants.ts` (engine is
  `9876`).
- **Transport:** the SDK's Streamable HTTP server transport over a Node HTTP
  server bound to `127.0.0.1:9877`.
- **Engine client:** main-process `fetch` to `http://127.0.0.1:9876`; share
  request/response types from a location both the main and renderer tsconfigs can
  import, or keep a thin main-side client if extraction is heavier than warranted.
- **License:** Apache-2.0 (app). Engine untouched.

## Considered & deferred

- **In-engine C++ over Streamable HTTP** (via `mcp-cpp`) — revisit only if an
  engine-only/headless deployment becomes a hard requirement.
- **Standalone `vayu mcp` Node CLI** — reuse the same TS server module to serve
  MCP without the Electron app, covering headless/CI. Preferred over in-engine
  C++ for that case.

## Open questions (need a call)

1. **V1 wedge first**, or plan full V1+V2 as one push?
2. **Live metrics as snapshot** (last N ticks via `tools/call`) vs streaming —
   confirm snapshot is acceptable for V1.
3. **Allowlist granularity** — per-host (leaning) vs per-host+method.
4. **Safety-config storage** — app settings store vs engine `config_entries`
   (UI-visible) read by the MCP layer.
5. **Next artifact** — this design doc, or scaffold the `mcp-server.ts` skeleton
   (`initialize` + `tools/list` + `get_run_report` end-to-end).

## References

- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) · [MCP SDKs](https://modelcontextprotocol.io/docs/sdk)
- [Streamable HTTP transport spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) · [2026-07-28 RC](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
- C++ libs (deferred): [`mcp-cpp`](https://github.com/Neumann-Labs/mcp-cpp) · [`cpp-mcp`](https://github.com/hkr04/cpp-mcp) · [`gopher-mcp`](https://github.com/GopherSecurity/gopher-mcp)
- Engine API surface: [`docs/engine/api-reference.md`](./api-reference.md)
