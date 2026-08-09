# Engine (C++20 daemon)

The load-testing and request-execution engine. AGPL-3.0. See the repo root
`CLAUDE.md` for build commands, commit rules and repo-wide conventions.

```
engine/
├── src/core/      # load_strategy, metrics_collector, run_manager
├── src/http/      # HTTP server, SSE, routes, thread_pool, rate_limiter
├── src/db/        # SQLite persistence
├── src/runtime/   # QuickJS scripting engine
├── include/vayu/  # Public headers
├── tests/         # Google Test suite
└── vendor/        # quickjs-ng, hdrhistogram
```

## Conventions

- Standard: C++20, `-Wall -Wextra -Wpedantic`
- Formatter: clang-format (`.clang-format` at repo root)
- Linter: clang-tidy (`.clang-tidy` configs in `engine/`, `engine/src/runtime/`,
  `engine/tests/`)
- Install the git pre-commit hook: `bash scripts/install-git-hooks.sh`
- vcpkg manages all C++ dependencies - do not add one without updating
  `engine/vcpkg.json`
- A fixture that opens a scratch `Database` cleans up with
  `vayu::tests::remove_database_files` (`engine/tests/temp_database.hpp`) - never
  a hand-written suffix list. An opened database writes six files, not the four
  the old copies listed, and eight of those twenty-two copies were wrong (#413).

## HTTP API

The daemon listens on `http://127.0.0.1:9876`. Key endpoints:

| Method | Path | Description |
|--------|------|-------------|
| POST | `/compose` | Resolve `{{vars}}` + `inherit` auth; returns an execute-ready payload (sends nothing) |
| POST | `/execute` | Send a single request (auth resolved engine-side) |
| POST | `/runs` | Start a load test run |
| GET | `/runs/:runId/live` | SSE stream of live metrics |
| GET | `/runs/:runId/metrics` | Historical time-series (JSON) for a run |
| POST | `/oauth2/token` | Acquire/return a cached OAuth 2.0 token (auth resolved engine-side) |
| GET | `/health` | Health check |
| POST | `/import/apply` | Persist a whole parsed import atomically; returns a temp-id -> real-id map |
| POST | `/collections`, `/requests`, `/environments` | **Create only** - 409 on an existing id |
| PUT | `/collections/:id`, `/requests/:id`, `/environments/:id` | **Update only** (merge-patch) - 404 on a missing id |

The pre-consolidation paths (`POST /request`, `POST /run`, `GET /run/:id[/report|/stop]`,
`DELETE /run/:id`, `GET /metrics/live/:runId`, `GET /stats/:runId?format=json`) still
work as **deprecated aliases** and will be removed in a future minor release; `GET
/stats/:runId` in its SSE mode is retained wholesale. See `docs/engine/api-reference.md`
(Deprecated aliases) for full reference.

Three things worth knowing before you design around them:

- **POST creates, PUT updates - they are not interchangeable.** `POST
  /<resource>` never updates and `PUT /<resource>/:id` on an id that does not
  exist is a `404`; POST-as-upsert is gone (issue #95). One null-vs-absent rule
  covers all three resources: on create
  absent and `null` both mean "use the default", on update absent means "keep"
  and `null` means "reset to the default", and a field with no default (a
  collection's / environment's `name`, a request's `collectionId` / `name` /
  `method` / `url`) rejects `null` with a `400` instead of ignoring the write.
  The rule lives in one place per side - `apply_*_field` in
  `engine/include/vayu/http/routes.hpp`, and `apiService.updateX` in
  `app/src/services/api.ts` - so add fields there rather than re-deriving the
  rule per handler. **The engine owns every id** (#97): a create carrying an `id`
  is a `400` (presence alone, `null` included - `id` is outside the null rule),
  and a `PUT` whose body `id` disagrees with the path is a `400` too, so the 409
  on an existing id now only guards a `generate_id` collision.
  `reject_client_supplied_id` / `reject_mismatched_body_id` in `routes.hpp` are
  the one copy of that; `apiService.createX` strips `id` on the renderer side
  because TypeScript only excess-property-checks object literals. Bulk import
  goes through **`POST /import/apply`** (#96), which takes opaque `tempId`s,
  generates every real id engine-side, returns the `idMap`, and writes the whole
  tree in one transaction (a rejected payload persists nothing, so the old
  client-side rollback is gone). The same per-resource field appliers back both
  paths - `apply_collection_fields` / `apply_request_fields` /
  `apply_environment_fields`, declared in `routes.hpp` - so add a field there and
  bulk import gets it too.
- **`GET /requests/:id` is a single-request lookup.** `useRequestQuery` uses it
  to load a restored request tab or a design-run copy on cold start - one round
  trip, not the old scan of every collection's list. A `404` means the request
  was genuinely deleted; anything else (a `5xx`, an unreachable engine) is a
  transport failure, and callers (`DesignRunView`) must keep those apart - only
  a real 404 becomes `RequestNotFoundError`. `GET /requests?collectionId=` still
  lists a collection's requests.
- **`followRedirects` / `maxRedirects` are per-request and stored** (request
  builder → **Settings** tab, `requests.follow_redirects` / `max_redirects`).
  Both clients send them on *every* execute and load test rather than eliding
  the defaults, because the engine's `follow_redirects` defaults to **true** -
  an omitted `false` would silently follow the 3xx the user asked to see.
  **`verifySSL` is still engine-only**; it was deliberately not exposed.

## Request composition (engine-owned - POST /compose)

The **engine owns** request composition (issue #226, backlog A1 shipped):
`POST /compose` (`engine/src/http/request_composer.cpp`) resolves
`{{variables}}` and `inherit` auth (collection-chain walk, `noauth`
terminates, `none` steps over) and returns the execute-ready payload that
`POST /execute` / `POST /runs` accept unchanged. Compose is **pure** (sends
nothing, no run row) and the execution endpoints **never interpolate**, so a
payload is resolved exactly once - that split is load-bearing, do not "merge"
compose into execute. Two entry shapes: `requestId` (stored request; MCP uses
this, and gates its allowlist on the *composed* URL) and an inline `request`
(+ `collectionId` scope; the renderer uses this because Send/replay execute
*editor state*, which may be unsaved or detached). Inline over stored = the
overlay MCP's `start_load_run` overrides ride on.

**The renderer's resolver is preview-only.** `useVariableResolver` /
`app/src/lib/variable-resolution.ts` back tab titles, previews, the
unresolved-token painting and the OAuth-guard preview - never a payload. The
preview must show what the engine will substitute, so its rules are pinned to
the engine's by the **cross-language conformance fixture**
(`engine/tests/fixtures/variable-resolution-conformance.json`), read by both
`request_composer_test.cpp` (gtest) and
`variable-resolution.conformance.test.ts` (vitest). Change resolution
semantics → change engine + renderer lib + fixture together; a case added to
the fixture fails whichever side forgot. The dynamic-variable name set
(`$guid`, `$timestamp`, …) is part of that fixture-pinned contract (C++ table
in `request_composer.cpp`, renderer table in `lib/dynamic-variables.ts`).
The D17 malformed-data rules (absent/non-boolean `enabled` = enabled;
non-string `value` = "") live engine-side in `parse_variables` and
renderer-side in `lib/variable-resolution.ts`. Interpolation happens strictly
**before** the pre-request script (D1 - deliberate Postman divergence), and
script text is never interpolated (D16). **MCP has no composition copy
anymore** (`resolve.ts` deleted) - a new engine client should call
`POST /compose`, never re-implement resolution client-side.

Script parts: clients on the inline path still build the ordered `ScriptPart`
list themselves (`scriptParts` in
`app/src/modules/request-builder/utils/script-parts.ts` - now the only
client-side copy); the by-id path builds it engine-side
(`compose_script_parts`). The **engine** joins parts with `"\n\n"` and runs
the result. **Both names reach the same script**: `read_post_request_script`
(`engine/src/http/script_parts.cpp`) owns every spelling the post-request
script answers to - stored as `postRequestScript`, `postRequestScript(s)` on
`/execute`, `tests` on `/runs` - and both routes read through it, so a payload
composed for one endpoint can start the other kind of run unchanged. Add a
spelling to that table, never to a route.

The endpoint names above are the canonical ones (`POST /compose`,
`POST /execute`, `POST /runs`); the old `POST /request` / `POST /run` still
work as deprecated aliases. An unresolved `{"mode":"inherit"}` reaching an
execution endpoint is treated as no auth and logged as a **warning** - it
means a client skipped composition.

## Docs to keep in step

| Doc | Update it when you change… |
|-----|----------------------------|
| `docs/engine/api-reference.md` | **Any** endpoint, payload, or status code |
| `docs/engine/architecture.md` | Core engine structure, auth resolution |
| `docs/engine/db-schema.md` | Schema, migrations, stored JSON |
| `docs/engine/scripting.md` | Script globals, hooks, sandbox limits |
| `docs/engine/mcp.md` | MCP tools or their schemas |
| `docs/engine/cli.md` | Flags or subcommands |
| `docs/engine/benchmarks.md` | Load generation or measurement |
| `docs/engine/building.md` | CMake presets, vcpkg deps |
