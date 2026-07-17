# Vayu MCP Server — Design & Decisions

> **Status:** Planning (no code yet). This document captures what has been
> finalized so far for exposing Vayu's engine as a Model Context Protocol (MCP)
> server, so agents like Claude Code can drive it.

## Vision (locked)

**MCP is a capability the engine hosts, not a separate product to run.** Once
Vayu is running, any agent (Claude Code, Cursor, Zed, Claude Desktop) opts in
with **one command** — no install, no extra process, no lifecycle to manage. If
Vayu is up, the tools are live; if not, the agent gets a clean "start Vayu"
error.

The deliverable is not "an MCP server" users run — it is an **MCP capability the
engine already has**, that any agent opts into with a single command. The
roadmap is therefore about engine routes + config toggles, not a shipped binary.

## Architecture decisions (locked)

| #   | Decision |
| --- | --- |
| D1  | Build MCP by exposing the engine's existing capabilities as MCP tools. |
| D2″ | **C++, in the engine.** Prototype on [`mcp-cpp` (Neumann-Labs)](https://github.com/Neumann-Labs/mcp-cpp), kept behind a thin internal tool-registration interface so swapping to a hand-rolled layer (or another lib) stays localized. No official C++ SDK exists; `mcp-cpp` is the best-fit community option (see SDK landscape below). Hand-rolling remains the cheap fallback. |
| D3′ | **Streamable HTTP transport at `/mcp`** on the existing `:9876`. Reuses `cpp-httplib` + `sse.cpp` + `nlohmann-json`. |
| D4′ | Tools call engine internals directly (`run_manager`, DB, etc.) — **no type duplication**, no network hop. |
| D5  | **Zero lifecycle code** — MCP is just a route in the already-running engine. No spawning, no double-instance. |
| D6  | **Local-only, `127.0.0.1`.** |
| D7  | Safety rails are **MVP-gating, not polish** (an LLM driving a traffic generator is the one real risk). |
| D9  | **Origin/Host header validation on `/mcp` is MVP-gating** — MCP spec-mandated, prevents DNS-rebinding from a browser tab hitting `127.0.0.1:9876`. |

### Why in-engine beats a separate process

| | In-engine `/mcp` (chosen) | Separate stdio/TS server |
| --- | --- | --- |
| Load-test tools | Zero hop — tools call `run_manager` directly | Proxies engine HTTP; re-duplicates types across the boundary |
| Stack fit | Reuses `cpp-httplib` + SSE + json already present | New Node process, new dep tree |
| Process model | Single binary, matches sidecar philosophy | Extra process to spawn/manage |
| Setup | `claude mcp add --transport http vayu <url>` | Install pkg + configure spawn command + keep in sync |
| Safety rails | Become engine `config_entries` — enforced at source, UI-visible | MCP-local config, enforced in adapter |
| Protocol maintenance | Ride a maintained lib; hand-roll fallback | Rides official TS SDK updates for free |

### SDK landscape (as of research)

**No official MCP C++ SDK exists.** Official SDKs: TypeScript, Python, Go,
C#/.NET, Kotlin, Java, Swift, Ruby, Rust. C++ is an open community discussion
only. The decisive filter for our in-engine plan is **Streamable HTTP support**
(many community libs are stdio / old-SSE only).

| Option | Transport fit | Stack fit | License | Maturity | Verdict |
| --- | --- | --- | --- | --- | --- |
| [`mcp-cpp`](https://github.com/Neumann-Labs/mcp-cpp) (Neumann-Labs) | Streamable HTTP + stdio | `cpp-httplib` + `nlohmann-json` (our exact deps) | Apache-2.0 | Beta; GTest suite + examples; C++20; server+client; sanitizer-clean, thread-safe; targets spec 2025-11-25 | **Chosen (prototype behind thin interface)** |
| Hand-roll on `sse.cpp` | We build it | native | n/a | We own it | **Fallback** |
| [`cpp-mcp`](https://github.com/hkr04/cpp-mcp) (hkr04) | stdio + **old deprecated** HTTP+SSE only — no Streamable HTTP | same deps | MIT | Single-maintainer | Types reference only |
| [`gopher-mcp`](https://github.com/GopherSecurity/gopher-mcp) | HTTP | Own networking/event layer fights engine `event_loop`/`thread_pool` | — | Heavy | **Rejected** |
| Sidecar + official SDK (TS/Go/Rust) proxying engine | any | Separate process | — | Rides official SDK | Violates D5 — escape hatch only |
| Rust `rmcp` + C++ FFI | Streamable HTTP | Adds Rust toolchain | — | Official-ish | Overkill |

Also surveyed and set aside as younger / less aligned: `umesoft/mcp-cpp`,
`peppemas/mcp_server`, `cppmcp` (nlpresearchai).

**Why ride a lib rather than pure hand-roll:** the spec is moving fast — the
[2026-07-28 RC](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
removed the GET stream endpoint and protocol-level sessions and added
`Mcp-Method`/`Mcp-Name` routing headers. Tracking that churn ourselves is the
real cost hand-rolling would incur. Riding `mcp-cpp` offloads it — hedged by
keeping tool registration behind our own interface so a swap stays localized.
Accepted risks: `mcp-cpp` is pre-1.0 (API may churn) and single-org.

## Onboarding (locked)

```bash
# one time, per machine
claude mcp add --transport http vayu http://127.0.0.1:9876/mcp
```

- Non-CLI: a **"Connect to Claude Code" button** in the app writes that config
  and prints the URL for other agents.
- The same URL works across all Streamable-HTTP clients (Cursor, Zed, Desktop).
- Requires Vayu to be running when the client connects — simpler than
  double-spawning, aligns with D5.

## Minimum protocol surface (locked scope)

Server-side, tools-only slice:

- JSON-RPC 2.0 framing
- `initialize` / `initialized` + capabilities
- `tools/list`, `tools/call`
- *(later, optional)* `resources/*`, `prompts/*`

We do **not** implement client-side features (sampling, elicitation). This is
why "no official SDK" is a small liability — the server surface we need is tiny.

## Safety model (locked approach)

- Backed by engine **`config_entries`** (UI-visible, enforced at source — not a
  separate MCP config file).
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

## License note

MCP lives in the engine → **AGPL-3.0** (not Apache-2.0 like the app).

## Open questions (need a call)

1. **V1 wedge first**, or plan full V1+V2 as one push?
2. **Live metrics as snapshot** (last N ticks via `tools/call`) vs streaming
   over SSE — confirm snapshot is acceptable for V1.
3. **Allowlist granularity** — per-host (leaning) vs per-host+method.
4. **Next artifact** — this design doc, or prototype the `/mcp` route skeleton
   (`initialize` + `tools/list` + one real tool such as `get_run_report`).

## References

- [MCP SDKs](https://modelcontextprotocol.io/docs/sdk) · [MCP C++ SDK discussion](https://github.com/orgs/modelcontextprotocol/discussions/316)
- [Streamable HTTP transport spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) · [2026-07-28 RC](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
- C++ libs: [`mcp-cpp`](https://github.com/Neumann-Labs/mcp-cpp) · [`cpp-mcp`](https://github.com/hkr04/cpp-mcp) · [`gopher-mcp`](https://github.com/GopherSecurity/gopher-mcp)
- Engine API surface: [`docs/engine/api-reference.md`](./api-reference.md)
