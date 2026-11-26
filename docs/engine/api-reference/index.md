---
description: >-
  Every HTTP endpoint the Vayu engine exposes - paths, payload shapes, status codes, and the shared error format.
---

# Vayu Engine API Reference

**Base URL:** `http://127.0.0.1:9876` (default, configurable via `--port`)

All endpoints return JSON.
Every response also carries `Cache-Control: no-store` (#1507) - see [Listeners](../architecture.md#listeners) for why.
**Every** error response has one shape - an `error` object carrying a machine-readable `code` and a human-readable `message`:

```json
{
  "error": {
    "code": "bad_request",
    "message": "Missing required field: name"
  }
}
```

`code` is per-status unless the route names a more specific one: `bad_request` (400), `unauthorized` (401), `forbidden` (403), `not_found` (404), `conflict` (409), `bad_gateway` (502), `unavailable` (503), `insufficient_storage` (507), `internal_error` (any other 5xx).
Routes with their own vocabulary pass it instead - `invalid_config` (`POST /config`), `invalid_run_config` (`POST /runs`), `precondition_failed` and `invalid_if_match` (the `If-Match` of a whole-record `PUT` or of `POST /globals`), and the `oauth2_*` family.

Any per-error detail sits **inside** the same object, so a client reads one place for the whole failure - `item` on `POST /import/apply`, the provider's reply on `/oauth2/*`:

```json
{
  "error": {
    "code": "oauth2_provider_error",
    "message": "Token endpoint refused the request (HTTP 401): invalid_client",
    "providerStatus": 401,
    "providerError": "invalid_client"
  }
}
```

No route emits a flat `{"error": "message"}`, which the app's http-client cannot read - every validation message would surface as a bare `HTTP 400` (issue #173).
The client still accepts the flat shape so a newer app can read an older engine.

## Pages

Each page holds the routes of one group of route files.

| Page | Routes | Route files |
|---|---|---|
| [Resource writes: create vs update](resource-writes.md) | Every create and update | `routes/collections.cpp`, `requests.cpp`, `environments.cpp` |
| [The request `body` union](request-body.md) | `body` of a request | `routes/requests.cpp`, `execution.cpp` |
| [Health, configuration and workspace](health-config.md) | `/health`, `/shutdown`, `/config`, `/request-defaults`, `/workspace/backup` | `routes/health.cpp`, `config.cpp`, `workspace.cpp` |
| [Collections and reorder](collections.md) | `/collections`, `/reorder` | `routes/collections.cpp`, `reorder.cpp` |
| [Requests and elements](requests.md) | `/requests`, `/elements/kinds` | `routes/requests.cpp`, `elements.cpp` |
| [Trash](trash.md) | `/trash` | `routes/trash.cpp` |
| [Request examples](examples.md) | `/requests/:id/examples` | `routes/examples.cpp` |
| [Specs](specs.md) | `/specs`, `/specs/*` | `routes/specs.cpp`, `spec_*.cpp` |
| [Import](import.md) | `/import`, `/import/*` | `routes/import.cpp`, `routes/import_mcp.cpp` |
| [Export](export.md) | `/export/*` | `routes/postman_export.cpp`, `run_export.cpp` |
| [Environments and global variables](environments.md) | `/environments`, `/globals` | `routes/environments.cpp`, `globals.cpp` |
| [Change feed](changes.md) | `/changes`, `/changes/subscriptions` | `routes/changes.cpp` |
| [Cookies, client certificates and transport diagnostics](cookies-and-certificates.md) | `/cookies`, `/client-certificates`, `/diagnostics/connection` | `routes/cookies.cpp`, `client_certificates.cpp`, `diagnostics.cpp` |
| [Allowed folders and picked files](file-access.md) | `/file-roots`, `/file-grants` | `routes/file_roots.cpp`, `file_grants.cpp` |
| [Webhook Inbox](inbox.md) | `/inbox/*` | `routes/inbox.cpp` |
| [Mock Server](mock-server.md) | `/mock/*` | `routes/mock_server.cpp` |
| [Authentication](authentication.md) | `/oauth2/*`, `/mock-issuer/*` | `routes/oauth.cpp`, `oauth_authorize.cpp`, `mock_issuer.cpp` |
| [POST /compose](compose.md) | `/compose` | `routes/compose.cpp` |
| [Execution](execute.md) | `/execute` | `routes/execution.cpp` |
| [POST /runs](load-runs.md) | `/runs` (start) | `routes/execution.cpp` |
| [Scenario runs](scenario-runs.md) | `/runs` (collection runs) | `routes/execution.cpp` |
| [Scenario load runs](scenario-load.md) | `/runs` (scenario load) | `routes/execution.cpp` |
| [Metrics & Statistics](metrics.md) | `/runs/:runId/metrics`, `/runs/:runId/monitor` | `routes/metrics.cpp` |
| [Live metrics and events](live-metrics.md) | `/runs/:runId/live`, `/runs/:runId/events` | `routes/metrics.cpp`, `events.cpp` |
| [Runs](runs.md) | `/runs`, `/runs/:runId`, `.../stop`, `.../report`, `.../samples`, `.../results/:resultId`, `.../baseline` | `routes/runs.cpp` |
| [Per-step verdicts in a collection run](collection-runs.md) | `/runs/:runId/report` (sections) | `routes/runs.cpp` |
| [Scripting](scripting.md) | `/scripting/*` | `routes/scripting.cpp`, `script_types.cpp` |

## Who may call the API

The engine serves no browser.
No response carries a CORS header, and the request gate in `server.cpp` refuses, before any route runs, for every route:

- a request whose `Host` is not exactly `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>` (the port this engine bound) - `403`, message naming the Host check.
  This is what defeats DNS rebinding, where a page reaches the listener under a name it controls and is same-origin with it;
- any request carrying an `Origin` header, whatever its value (`null` included) - `403`, message saying the engine does not serve browser origins.

A request cpp-httplib refuses to parse never reaches that gate: an HTTP/1.1 request with no `Host`, any request with more than one, or a `Host` holding a byte outside `uri-host [ ":" port ]` (RFC 9112 §3.2) is answered `400` with an empty body and the connection closed.
An HTTP/1.0 request with no `Host` still reaches the gate, and is refused there with the `403` above.

An `OPTIONS` request that passes the Host check is answered `204` with no body and no CORS header, whatever its `Origin`: a preflight that grants nothing leaks nothing.
Local tools (the CLI, curl, the MCP server's fetch) send no `Origin` and are unaffected.
The Electron shell is the one browser-context client: it strips `Origin` from the renderer's requests and supplies the CORS response headers the renderer needs itself (`app/electron/engine-origin.ts`).

What a browser page can still send is a request with no `Origin`: a scriptless `GET` (`<img>`, `<script>`, `<link>`, a `no-cors` `fetch`, a top-level navigation) to the loopback name it dialled.
That passes the gate and reaches a `GET` route.
It is harmless because two things hold together: the response is opaque to the page (no CORS header, and the browser's CORB/ORB keeps a JSON body out of a `<script>`), and **no `GET` route has a side effect**.
A page can therefore neither read the engine nor change it, though it can make the engine run any `GET` handler.

**Writes to file trust need one more thing: the grant secret.**
Host and Origin decide who reaches the API at all; they cannot tell the Vayu app from any other local caller (a script, the CLI, the MCP server, another process).
What a request body may send from disk is decided by the allowed folders and the picked files, so the four routes that change those -
[`POST`/`DELETE /file-roots`](file-access.md#allowed-folders-file-roots) and [`POST`/`DELETE /file-grants`](file-access.md#picked-files-file-grants) - also require the header `X-Vayu-Grant-Secret` to carry the engine's per-start secret, and answer `403` with code `grant_secret_required` otherwise:

- The app's main process generates the secret and passes it in the engine's environment as `VAYU_GRANT_SECRET`.
  The engine reads it once at start, before any thread exists, and removes it from its own environment, so nothing it later reads or starts sees it.
  On Linux and macOS it also overwrites the bytes the kernel passed (what `/proc/<pid>/environ` shows on Linux), which `unsetenv` alone leaves readable; on Windows the environment block is private to the process.
  A value shorter than 32 characters is ignored with a warning that does not print it.
- The header is compared in constant time (both sides hashed with SHA-256, the digests compared with `sodium_memcmp`).
  A missing header, an empty one and a wrong one are the same `403`.
  The secret is never logged (the request log records method, path, status, time and size, never a header) and no response carries it, a refusal included.
- **An engine started without a secret refuses all four writes**, whatever the header says.
  That is every engine the app did not start: `vayu-engine` run by hand, or one the CLI or a CI job starts.
  Folders allowed and files picked before then still apply to every send, and `GET /file-roots` and `GET /file-grants` answer as usual.

The engine's own outbound client sends exactly what this gate admits, a loopback `Host` and no `Origin`, so the engine never sends a request to its own port or the MCP server's - not from a script, a redirect or a name that resolves to loopback.
See [Reserved local ports](compose.md#reserved-local-ports).

## Request bodies

Every request body is judged from its headers, on the same pre-routing handler as the gate above, before any route runs and before a byte of the body is read (issue [#1824](https://github.com/athrvk/vayu/issues/1824)):

- A body sent with `Transfer-Encoding: chunked` answers `411` `Refused: the engine reads a request body only when its length is declared up front - send Content-Length, not Transfer-Encoding: chunked`, on every route.
  A chunked body's size is known only once it has been read, and cpp-httplib's read bound is fixed for the listener's life, so it could not follow a body-size setting changed while the engine runs.
  The app, `vayu-cli` and the MCP server all send `Content-Length`.
- A `Content-Length` over **151 MiB** (158334976 bytes) answers `413` `Request body is N bytes, over the limit of M the engine reads for any request`, on every route.
  The ceiling is fixed and derived from the largest values the two body-size settings accept: `maxSpecDocumentBytes` at its 100 MiB maximum under the import rule below, which also covers `maxScenarioDataBytes` at its own 100 MiB maximum.
  Raising either setting never meets this ceiling first.
- `POST /import`, `/import/parse` and `/import/document` carry a whole document and are held to a tighter bound that follows the live `maxSpecDocumentBytes`, checked first because its message names the setting; see the body cap under [POST /import/parse](import.md#post-importparse).
  `POST /import/mcp` carries no document and is held to the same bound.

Both refusals are the shared error shape, with code `error`.
Because the body is not read, the engine answers and closes the connection: a client that is still writing a large body may see the connection reset rather than the response.

Once read, every route that reads a JSON body holds it to a depth bound: one nested deeper than 128 levels answers `400` `request body is nested deeper than 128 levels` before the route reads a field, and text that does not parse answers `400` `Invalid JSON: <parser message>` (issues [#2417](https://github.com/athrvk/vayu/issues/2417), [#2671](https://github.com/athrvk/vayu/issues/2671)).
Both carry code `bad_request` unless the route has one of its own for a malformed body, which the depth refusal then shares: `invalid_compose_request` on `POST /compose`, `oauth2_invalid_config` on the `/oauth2/*` routes, `mock_issuer_invalid_config` on `/mock-issuer`, `invalid_config` on `POST /config`.
`POST /execute` and `POST /runs` hold the same bound; see their sections.
A route that accepts an empty body (`POST /mock/start`, `POST /mock-issuer/start`, the `/inbox` writes) reads it as no body at all rather than as a parse failure.
The import routes are held to the same 128 levels: their documents travel as a string (`content`) or as flat lists linked by temp ids, so a legitimate body is far shallower.
A document's own nesting is bounded separately, where the engine reads it.

The bound reads the body's own tree, so JSON carried inside a string field is not covered by it.
The engine parses three such fields again and holds each to the same 128 levels itself (issue [#2672](https://github.com/athrvk/vayu/issues/2672)):
a request's `postmanProtocolBehavior` string ([POST /requests](requests.md#post-requests)), and a `graphql` or `jsonrpc` body's `content` ([the `graphql` envelope](request-body.md#the-graphql-envelope), [the `jsonrpc` envelope](request-body.md#the-jsonrpc-envelope)).

## Removed route aliases

The execution and run/metrics routes were consolidated behind a `/runs` family, `/execute`, and `/runs/:id/metrics` (#83).
The pre-consolidation paths served as deprecated aliases for a release cycle and are now gone; each answers `404`.

| Removed | Use |
|---------|-----|
| `POST /request` | `POST /execute` |
| `POST /run` | `POST /runs` |
| `GET /run/:id` | `GET /runs/:id` |
| `DELETE /run/:id` | `DELETE /runs/:id` |
| `POST /run/:id/stop` | `POST /runs/:id/stop` |
| `GET /run/:id/report` | `GET /runs/:id/report` |
| `GET /metrics/live/:id` | `GET /runs/:id/live` |
| `GET /stats/:id?format=json` | `GET /runs/:id/metrics` |
| `GET /stats/:id` (SSE) | `GET /runs/:id/live` while the run is retained, then `GET /runs/:id/report` |

`GET /runs` with no query parameters no longer returns the pre-pagination bare array: it answers the `{data, pagination}` envelope at the default page size, the same as any other call (see [GET /runs](runs.md#get-runs)).

## HTTP Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 400 | Bad request (invalid JSON, missing required fields, invalid OAuth 2.0 config) |
| 401 | OAuth 2.0 provider rejected the token request |
| 404 | Resource not found |
| 409 | OAuth 2.0 interactive authorization required (`/run` pre-flight, `/oauth2/token`) |
| 412 | A whole-record `PUT` or a `POST /globals` whose `If-Match` no longer names the stored row (`precondition_failed`, [Conditional updates](resource-writes.md#conditional-updates-with-if-match)) |
| 429 | A start refused at its cap: `oauth2_authorize_limit_reached` (16 unsettled sign-in attempts), `mock_issuer_limit_reached` (8 mock issuers) |
| 500 | Internal server error, including a storage failure that is neither a full disk nor a lock ([resource writes](resource-writes.md#a-storage-failure-is-not-a-400)) |
| 502 | Upstream network error (OAuth 2.0 token endpoint, `/import/fetch` proxy, an MCP server `/import/mcp` read) |
| 503 | Engine is shutting down (`POST /runs`, [Shutdown](scenario-load.md#scenario-load-runs)), or the database stayed locked past its busy timeout (a resource write; carries `Retry-After: 1`) |
| 504 | OAuth 2.0 token endpoint did not answer within the `defaultTimeout` setting (`/oauth2/token`, `oauth2_timeout`) |
| 507 | The disk holding the data is full (a resource write, `insufficient_storage`) |

## Notes

- All timestamps are Unix milliseconds (since epoch)
- Variable substitution uses `{{variableName}}` syntax
- Environment variables are resolved in order: environment → collection → global
- Load test metrics are collected every 100ms
- SSE connections timeout after 30 seconds of inactivity
