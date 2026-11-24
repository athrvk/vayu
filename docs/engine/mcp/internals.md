---
description: >-
  How the MCP server is built - lifecycle, IPC and the registry - and the design decisions behind it, for contributors.
---

# MCP internals

## Architecture

Everything lives under `app/electron/mcp/` and is managed by `main.ts` alongside `EngineSidecar`.

| File               | Responsibility                                                              |
| ------------------ | ---------------------------------------------------------------------------- |
| `config.ts`        | `McpSafetyConfig`, safe defaults, input sanitizer, host normalizer.          |
| `safety.ts`        | Pure guards: allowlist, load caps, duration parsing. Each takes the session's `host` so its refusal names that host's remedy. |
| `remedy.ts`        | What a refusal tells the user to do, per host (`app` or `cli`): `settingRemedy(key, host)` for every safety field, `engineDownRemedy`, `engineRestartRemedy`, and the tokens (`GUARDED_WRITE_SENTENCE`, `REVEAL_SETTING_TOKEN`, ...) plus `resolveRemedyTokens` that fill a description's tokens per host. The only place either wording lives; the CLI's is built from `SAFETY_ENV_VARS`. |
| `engine-client.ts` | Thin `fetch` client to the engine REST API + SSE metrics snapshot.          |
| `compare.ts`       | Pure two-report diff for `compare_runs`. Mirrored by the renderer's `src/lib/run-compare.ts` (neither process can import the other's source) and by the engine's run-report export (`engine/src/core/run_compare.cpp`); all three replay `engine/tests/fixtures/run-compare-conformance.json`, and `compare.conformance.test.ts` fails on any divergence, including the order and wording of the `comparability` list. Reads the status mix in **both** wire shapes: the renderer's transformed record and the engine's own array of `[code, count]` pairs (`std::map<int, size_t>` cannot serialize as a JSON object), which is what this path gets from a raw `GET /runs/:id/report`. Also diffs `summary.errorClasses` (#3828) per class, and only when both reports carry it, so a run stored before it never reads as zero failures; `protocolCodes` is not compared. |
| `variable-origins.ts` | The resolution model the `vayu://variables/resolution` resource serves, and the winner-plus-shadowed computation behind `resolve_variables`. Mirrors the renderer's `src/lib/variable-resolution.ts` and `useVariableResolver.ts` for the same reason `compare.ts` does; `variable-origins.conformance.test.ts` replays the engine's fixture through both and fails on divergence. Resolves no `{{tokens}}` - see [Variables](saved-data.md#variables). |
| `http-versions.ts` | The `httpVersion` value list the Zod schemas enumerate.                     |
| `tools.ts`         | Tool registry: `TOOLS`, spread from the `tools/*.tools.ts` files in registry order, + `dispatchTool`, the one dispatch path `server.ts` and the tests share. Re-exports what callers import from `tools/`, so `./tools.js` stays the registry's one public surface. |
| `tools/<domain>.tools.ts` | The tool definitions (schemas, annotations, handlers), each file one contiguous run of the registry exported as an `McpTool[]`: `reads`, `safety`, `graphql-schema`, `catalogue`, `run-request`, `engine-config`, `collections`, `spec`, `requests`, `trash`, `examples`, `move`, `environments`, `variables`, `cookies`, `collection-runs`, `load`, `runs`, `connection`, `oauth2`, `mock-issuer`, `mock-server`, `webhook-inbox`, in that order. The order is what `tools/list` and the Settings catalog show, so a new tool joins the file whose run it extends. |
| `tools/contract.ts` | The registry's types (`McpTool`, `ToolContext` with its required `host` and the optional `progress` a call gets only when the client sent a `progressToken`, `ToolResult`, `UserInput`) and `MCP_DATA_ENTITIES`. A tool's `description` is a string or a function of the session's safety config, and `resolveDescription` is the one place it is read (registration, the Settings catalog under the defaults, and the list-changed check). |
| `tools/kit.ts`     | Helpers every tool shares: the strict arguments object (`argumentsSchema`), result builders, argument coercion (`ToolArgError`), the write and confirmation gates, and the `NOTHING_CHANGED` / `STARTED_RUNS` / `INPUT_REQUIRED` marks dispatch and `server.ts` read. |
| `tools/<topic>.ts` | The helpers one family of tools draws on: `compose.ts` (request composition, the agent-script gate, load-run payloads), `input-schemas.ts`, `output-schemas.ts`, `inline-body-bounds.ts`, `run-housekeeping.ts`, `request-body.ts`, `variable-blobs.ts`, `redacted-input.ts` (the refusal of a credential slot written as `<redacted>`), `scenario-runs.ts`, `cascade.ts`, `trash.ts`, `oauth2.ts`, `mock-issuer.ts`, `mock-server.ts`, `webhook-inbox.ts`, `examples.ts`, `move.ts`, `sibling-order.ts` (a parent's sub-collections and requests as one list, the third copy of the sibling comparator; `sibling-order.conformance.test.ts` replays both order fixtures through it), `spec-bindings.ts`. Imports run `contract.ts` → `kit.ts` → topic files → `*.tools.ts` → `tools.ts`; nothing under `tools/` imports `tools.ts`. |
| `resources.ts`     | Static + templated resource definitions.                                    |
| `prompts.ts`       | Prompt definitions (build messages from engine data).                       |
| `server.ts`        | Builds the SDK `McpServer`; registers tools/resources/prompts; builds each call's context (`callContext`, including `progress` when the call carries a `progressToken`). |
| `server-icon.ts`   | The server's icon, `shared/icon_png`'s 48px rendering inlined as a data URI. |
| `http.ts`          | Streamable HTTP host over `createMcpHandler`, both eras (Host/Origin checks in front). |
| `client-sessions.ts` | The bounded `Mcp-Session-Id` → client-name record that carries the handshake's name across the HTTP host's requests. |
| `in-flight-calls.ts` | The bounded (`Mcp-Session-Id`, request id) → `AbortController` record of the 2025-era requests the HTTP host is serving, so the client's `notifications/cancelled` reaches the call it names. |
| `cli.ts`           | Standalone stdio server over `serveStdio` (env-configured).                 |
| `connect.ts`       | One-click connect: resolves and runs the `claude` / `code` CLIs.            |
| `store.ts`         | Persist safety config + enabled preference + port (`../json-store.ts`); `validateMcpPort` and `readMcpPort` judge the port. |
| `lifecycle.ts`     | The server's one state (`off`, `released`, `starting`, `listening`, `failed`) and the generation every start and stop takes; `main.ts` reads the listener, service and start error from it. Before an engine spawn that guards another port the listener is released (`releaseForSpawn`), and after the spawn it is bound on the port that engine guards (`followEndpoint`). |
| `index.ts`         | `VayuMcpService` facade consumed by `main.ts`, loaded on demand.            |

### Lifecycle & IPC

`main.ts` starts the server in `app.whenReady()` (skipped if disabled), stops it on quit, and exposes IPC the Settings panel uses.
Every one of those goes through `lifecycle.ts`, which owns the listener, the service and the last start error as one state; a safety change applies to the service it reports, or is persisted for the service the next first request builds.

**`main.ts` imports this directory by weight.**
`config.ts`, `store.ts` and `connect.ts` are self-contained (`node:fs` and `node:child_process` are their heaviest dependencies), so they are ordinary static imports.
Everything reachable from `index.ts` - the SDK, zod, the registry and its 84 schemas built at module scope - is loaded by a cached dynamic `import()` instead, inside the lifecycle's service factory (reached only by a listener's first request, after the enabled check) and inside the two IPC handlers that need the tool catalog.
The main process is unbundled, so a static import here is evaluated before `app.whenReady` and cost every launch ~250-300 ms ahead of the window, MCP switched off or not (#1145).
A disabled launch now evaluates none of it; opening the Settings tool list is what pays for the registry.
`graphql` is not part of that load: `get_graphql_schema` imports it on its first call.

The IPC surface:

| IPC handler         | Purpose                                                     |
| ------------------- | ----------------------------------------------------------- |
| `mcp:status`        | `{ running, url, enabled, port, restartRequired, starting, error?, corruptCopy?, storedPortError? }`; `starting` is true while enabled with no listener and no `error` (the start has not finished), and Settings polls until it clears; `error` is `{ code, message }` while enabled and the last start failed (`EADDRINUSE`, `EACCES`, `other`); `corruptCopy` is the path an unreadable `mcp-config.json` was kept at once a change has replaced it. `port` is the configured port; `restartRequired` is true while it is not yet the one in force, and `url` names the port in force; `storedPortError` says why a hand-edited port was set aside for the default. |
| `mcp:getSafety`     | Live `McpSafetyConfig`, or the persisted one when off.      |
| `mcp:updateSafety`  | Sanitize, apply live, persist; returns the resolved config. |
| `mcp:setEnabled`    | Start/stop the server, persist the preference; returns the status, and a retry (`true`) re-attempts a failed bind. |
| `mcp:setPort`       | Validate and persist the port; returns `{ ok: true, status }` (with `restartRequired`) or `{ ok: false, message }` naming why it was refused. The server does not move until the engine restarts. |
| `mcp:getTools`      | IPC-safe tool catalog (name/description/category).           |
| `mcp:connectClient` | Run a client's add-CLI (`claude` / `code`); for `claude`, a prior `mcp get vayu` makes it idempotent (`alreadyConnected: true`, or remove then add when the URL differs). Refuses with `reason: "not-running"` while no listener is up. |

One channel runs the other way, main → renderer:

| Channel            | Purpose                                                       |
| ------------------ | ------------------------------------------------------------- |
| `mcp:data-changed` | A successful call changed engine data; invalidate its queries. |

And two run renderer → main for MCP's sake:

| Channel              | Purpose                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------- |
| `dataFile:locations` | The whole map of bound data-file paths, on launch and on every change (see below). |
| `app:focus`          | The open tab (type, entity id, label) and active environment (id, name), whole, on launch and on every change; `get_app_focus` reads the copy `electron/app-focus.ts` rebuilds field by field. |

**The UI reflects MCP writes live.**
An MCP call mutates the engine from the main process, which no renderer query can observe (`refetchOnWindowFocus` is off app-wide), so a request an agent creates would stay invisible in the collection tree until some unrelated mutation happened to refetch the lists.
Each tool declares the data families it changes (`invalidates` in `tools/*.tools.ts`) and `dispatchTool` - the single dispatch path - sends one `mcp:data-changed` per family after a call that did **not** return an error.
(The rows the engine's change feed covers reach the renderer that way too, from any writer: see [the stdio CLI](transports.md#stdio-cli-zed--headless--ci). This channel is what carries the rest, and a write it and the feed both report is invalidated twice, which costs a refetch and nothing else.)
The event names a family (`collection`, `collectionRow`, `request`, `environment`, `run`, `cookie`, `config`, `service`, `oauth`, `clientCertificate`, `variables`) plus the `collectionId` / `requestId` / `runId` / `inboxId` / `mockId` the call itself named; it carries no engine data, so the renderer still reads every row through its query layer.
The five hints are read off the call's own arguments at the dispatch chokepoint, which is what keeps a new write tool from having to remember an emit of its own - every tool in the registry spells them the same way.
They are hints, not identity: `requestId` on a `run` event is the saved request a design run was linked to, while `runId` is the run itself, and only the tools that rewrite or remove an **existing** run (`stop_run`, `set_run_baseline`, `delete_run`) name one - a runner's new run has no per-run cache to drop yet.
`inboxId` and `mockId` are the same shape for the `service` family: the tools that act on an existing listener name one, and `start_webhook_inbox` / `start_mock_server` cannot, since the engine assigns the id.
Both exist because their per-id cache has to be **dropped** rather than refetched - a cleared capture list would union its destroyed rows straight back, and a stopped mock's route table has no live id left to refetch from.
`service` is deliberately one family covering inboxes, mock servers and issuers, because the surfaces that read them - the Services drawer and the Dock's running-services count - ask "what is listening" rather than "which kind".
`oauth` (issue #760) carries **no** hint of its own even though a cache key exists: an agent names the key it clears, but the key a `fetch_oauth2_token` writes under is derived engine-side and appears only in the answer, so a hint would be present for one tool and absent for the other - the shape that leaves a stale row exactly when it matters.
The family is invalidated at its prefix instead.
`variables` (issue #1916) is declared by the three design-mode runners - `run_request`, `run_collection_smoke` and `run_collection` - because a script or extractor that sets a variable has the engine write it back to the environment, globals or collection row once the send finishes.
It carries no hint: the event cannot say which of the three scopes moved.
`start_load_run` persists nothing and stays `run` alone.
`collectionRow` (issue #2546) is declared by `create_collection`, `update_collection` and `unbind_spec`, the writes that touch one collection row and nothing beneath it; the renderer refetches the collections and their compositions and no request list.
Every other collection write (`delete_collection`, `move_item`, `import_document`, `bind_spec`, `sync_spec`, the two trash tools) declares `collection`, which refetches every request list, because what it changes reaches past the collection it names.
The two trash tools also declare `environment` (issue #2970): its renderer invalidator takes the trash list beside the environments, the globals and every composition, so a `delete_environment` reaches an open Trash drawer and a restored environment reappears in the Variables view.
A saved example needs no family of its own (#2971): `delete_request_example` declares `request`, whose invalidator takes the trash list and the named request's detail key, under which the Examples list sits, so the drawer and an open Examples panel both refetch.
A restored example reaches the panel through the trash tools' `collection` family, whose invalidator takes `requests.all` (the Examples key sits under it); their `request` family names no row.
A client certificate does need one (#2973): the Settings card lists live entries only and nothing else a trash tool declares reaches `clientCertificates.all`, so the two trash tools also declare `clientCertificate`, whose renderer invalidator refetches the registry.
No tool writes that family on its own; it is not folded into `config`, whose invalidator would refetch every config and request-default read for it.

**One field on the event is not a hint at all.**
`startedRun` rides the `run` event of the two tools that *create* a run - `start_load_run` and `run_collection` - and says that the run is live, naming it and which of the renderer's two run services owns its stream (`{runId, kind: "load" | "collection"}`, issue #1419).
It is read from the engine's 202 answer rather than from the call's arguments, because a run has no id until the engine has given it one, and an answer carrying no `runId` announces no run.
Everything a run does in the background - the taskbar/Dock progress bar, the keep-awake hold and the finished notification - lives in those services and begins when one is told to watch a run, and before this field existed only a renderer surface ever told them: a run an agent started painted nothing and said nothing until its dashboard tab was opened.
`useRunWatchers` reads the field and enters the same `startMonitoring` path the dashboard does, so the main process still tracks no runs of its own.
Both kinds are the exception while another run is live in the app (#3351, #3381): the engine runs the agent's run as asked, the user's run keeps the dashboard and the stream, the app attaches no live view for the agent's run, and says so in one info toast whose View run opens the run.
Its History row updates as usual.
The tool's answer is the same either way.
`run_collection_smoke` sends its requests one at a time through `POST /execute` and has no run to watch, so its `run` event carries nothing extra.

The renderer side, including which query keys each family maps to, is in [`docs/app/state-management.md`](../../app/state-management.md).

Declaring the families per tool rather than deriving them from `category` is deliberate: an `execute` tool writes a run row and refills the cookie jar without being a "write", and the field is required, so a new tool cannot ship silently invisible to the UI.

The panel (`app/src/modules/settings/main/panels/McpSettingsPanel.tsx`) is a registered app-settings panel; it talks to `window.electronAPI` directly since MCP config is app-level, not engine-level.

`mcp:getSafety` answers from the persisted config whenever the server is not running (switched off, or a failed port bind) rather than from the defaults, and the panel shows an error with a Retry instead of substituting defaults when a call fails.
Both exist for the same reason: each control commits a whole field computed from what is displayed - adding a host persists the displayed allowlist plus the new entry - so a placeholder shown here would be written over the real config by the very next edit.

An unreadable `mcp-config.json` looks, on screen, like a config nobody ever set, so the panel says otherwise: once the first change has set the old file aside (`corruptCopy` in `mcp:status`, re-read by the panel after each change), a warning above the cards gives the copy's full path.

The Connection card's **Port** field (`McpPortSection.tsx`) commits on blur through `mcp:setPort`.
The renderer judges nothing: it sends what was typed and shows the refusal `validateMcpPort` answers with, stating the range and the reserved engine ports only as help text.
Those, and the default its Reset sends, are the renderer's copies in `mcp-port-copies.ts`, which `port-copies.conformance.test.ts` holds to the main process's constants.
The field shows the configured port from `mcp:status`, while the endpoint and every snippet keep the port in force until the engine restarts.
A `restartRequired` status adds a notice with the engine restart (`useEngineRestart`, the action the Dock and the engine settings banner use), after which the panel re-reads the status to show the new URL.
The notice names the address the server stays on only while it is running there; off, or with its port held by another program, it says the new port takes effect when the engine restarts.
`storedPortError` is shown as written.
The engine store's pending-restart flag is not set from here: `restartRequired` is derived in the main process and survives a reload, and that flag would add a second banner on the engine settings with no label for it.

## Design notes

Rationale behind the load-bearing decisions.

### TypeScript sidecar over in-engine C++

MCP could have been hosted inside the C++ engine (zero hop, single binary).
The deciding factor: **there is no official C++ SDK**, so in-engine would mean owning the protocol in C++ or betting on a pre-1.0 community lib - right as the spec churns (the [2026-07-28 RC](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/) removed the GET stream endpoint and protocol-level sessions).
The official TS SDK absorbs that churn, Node is already the Electron runtime, and the engine stays untouched (keeping it AGPL-clean).
The accepted tradeoff: MCP is up when the **app** is open, not engine-only - covered later by the stdio CLI for headless use.

### A fresh server per request, and how the push gap closed

The HTTP host builds a fresh server per request, which keeps Settings changes live for free.
Under the 2025-era protocol that cost the host its server→client channel: no held-open stream, so a confirmation question and `tools/list_changed` could not reach an HTTP client.
The 2026-07-28 revision is built for per-request serving and closes the gap without sessions: a question travels in-band as an `input_required` result that the client retries with the answer, and change notices travel on a `subscriptions/listen` stream the client opens.
`createMcpHandler` serves both eras from one factory, so a 2025-era client keeps what it had and a 2026-07-28 client gets both (see [What is live on each transport](transports.md#what-is-live-on-each-transport)).
A stateful 2025-era server - real sessions, a GET stream each, servers mutated on toggle - is not built: it would grow the mechanism the spec retired.
What the host does keep for that leg is an abort handle per request in flight, so a cancel reaches a call whose server it cannot reach, and nothing else.

### The size of `tools/list` is budgeted

Every session pays for the whole `tools/list` answer before it does anything, so its size is held by `tool-list-budget.test.ts`, which builds the real registry through the real server for each host (the app and the stdio CLI, whose remedy wording differs) and each writes-off/on and reveal-off/on pair.
There are two fixed ceilings, one for a session with writes off and one for writes on, each applied to every host and reveal setting: they are constants in the test, not measurements of the code, and a change that needs bytes removes bytes elsewhere; it never raises a ceiling (#3558).
They are interim values that only move down, and #3751 is where they reach their final ones.
A failing session prints its host, its measured size, the overshoot and the five largest tools.
The server instructions have a fixed ceiling of their own in the same file, 8,100 bytes for any one session, so text moved from the descriptions into them still counts.
It is frozen at the largest session today (the CLI host with writes and reveal off) and is lowered when the instructions are trimmed, never raised.

A tool's result fields are explained on its output schema, one clause per member, rather than narrated in its description (`get_run_report` and `run_request`, #3749).
The member descriptions and the schema's own structure are inside the measurement, so the move saves bytes only where the narration ran longer than that, and a member another argument already explains (the streamed read's `completed`, `capReached` and `events`, which `stream` states) is left undeclared.

The server strips the `$schema` key the SDK writes on every input and output schema when its value is the 2020-12 URI (#3748): the MCP specification ("JSON Schema Usage" > "Schema Dialect") makes 2020-12 the default for a schema with no `$schema`, so the key says nothing and costs about 57 bytes a schema.
A schema that names another dialect keeps it (`server.schema-dialect.test.ts`).

Two shapes keep the list small, and `tool-list-shape.test.ts` checks both.
A tool description fails on a sentence of 150 or more characters that more than three descriptions repeat: a rule that long belongs in the server instructions, with a one-line pointer in the tool (the withholding rules and the error definition moved that way, and `VARIABLE_PRECEDENCE_SENTENCE` stays under 150 so its deliberate repetition passes).
An argument description of 80 or more characters, anywhere in an input or output schema (nested properties, array items, record values and union branches included), is stated on one argument only.
Every other argument sharing it carries a pointer, `As on <tool>.` (`asOn` in `tools/input-schemas.ts`), to the tool whose same-named argument says it in full, plus at most what differs on its own tool; the test fails on a pointer whose tool is not listed in that session or does not state that argument.
A repetition kept on purpose is named in the test's `SHARED_ARGUMENT_DESCRIPTIONS` with its reason: today only `environmentId`, whose default is stated at the argument on every tool that takes it (#2480).
That file also fails on any `Withheld` or `<redacted>` in a description of a session with reveal on.

## Deferred

- **`vayu mcp` bin** - package the stdio CLI as a first-class command ([#693](https://github.com/athrvk/vayu/issues/693)).
- **Hosted MCP for Vayu Cloud** - OAuth-gated, remote.

## References

- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) · [Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- Client docs: [Claude Code](https://code.claude.com/docs/en/mcp) · [Codex](https://developers.openai.com/codex/mcp) · [Cursor](https://cursor.com/docs/mcp)
- Engine API surface: [`api-reference/index.md`](../api-reference/index.md) · Threat model: [`SECURITY.md`](https://github.com/athrvk/vayu/blob/master/SECURITY.md)
