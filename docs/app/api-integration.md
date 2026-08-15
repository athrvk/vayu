# API Integration

This document describes how the Vayu Manager communicates with the Vayu Engine (C++ daemon) via HTTP.

## Overview

The app communicates with the engine through:
- **HTTP REST API**: For CRUD operations and request execution
- **Server-Sent Events (SSE)**: For real-time load test metrics

All communication happens on `localhost:9876` (configurable).

## API Client Architecture

```
┌─────────────────────────────────────────┐
│         React Components                │
│  (RequestBuilder, Dashboard, etc.)     │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│  Hooks + singletons                     │
│  (useEngine, queries/, loadTestService) │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│         Services Layer                  │
│  - api.ts (HTTP client)                │
│  - sse-client.ts (SSE client)          │
│  - http-client.ts (fetch wrapper)       │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│         Vayu Engine                     │
│  (localhost:9876)                      │
└─────────────────────────────────────────┘
```

## HTTP Client (`services/http-client.ts`)

Low-level fetch wrapper with error handling and timeout management.

### Features

- **Base URL Configuration**: `http://127.0.0.1:9876` (from `config/api-endpoints.ts`)
- **Request Timeout**: 30 seconds default
- **Error Transformation**: Converts HTTP errors to `ApiError` with user-friendly messages
- **Query Parameters**: Automatic URL encoding
- **JSON Serialization**: Automatic request/response JSON handling

### Error Handling

```typescript
class ApiError extends Error {
  statusCode: number
  errorCode: string
  userFriendlyMessage: string
  response?: any
}
```

Every engine error body is `{"error": {"code", "message"}}`, so `message` is the
engine's own text (a validation reason, a not-found) and `errorCode` is its
`code` - per-status (`bad_request`, `not_found`, ...) unless the route names a
more specific one. Two fallbacks sit behind that, and both matter: a body in the
**legacy flat** shape (`{"error": "..."}`, which a pre-#173 engine sends and the
sidecar's version can lag the app's) still yields its string as the message, and
a body carrying neither falls back to `HTTP <status>: <statusText>`. `response`
keeps the raw body, which is where per-error detail lives - `error.item` on a
failed bulk import, the provider fields on `/oauth2`. See
[the engine's error contract](../engine/api-reference.md).

**Error Types:**
- `isTimeout`: Request timeout
- `isNetworkError`: Connection/DNS errors
- `isDatabaseError`: Engine database errors

## API Service (`services/api.ts`)

High-level service layer that wraps HTTP client with domain-specific methods.

### Data Transformation

The service handles transformation between frontend (snake_case) and backend (camelCase) formats:

**Frontend Format (snake_case):**
```typescript
{
  collection_id: "col_123"
  created_at: "2024-01-01T00:00:00Z"
  pre_request_script: "console.log('test')"
}
```

**Backend Format (camelCase):**
```typescript
{
  collectionId: "col_123"
  createdAt: 1704067200000
  preRequestScript: "console.log('test')"
}
```

#### Request bodies

`body` goes to the engine as the discriminated union `{ mode, content }` or -
for the two form modes - `{ mode, fields }`, built by `buildExecBody`
(`modules/request-builder/utils/execute-mapping.ts`) and passed through
untransformed. The mode strings are a contract: the engine matches
`"form-data"` and `"x-www-form-urlencoded"` exactly and reads the content out
of `fields`, so a renamed mode or a flattened `content` string sends an empty
body rather than failing. Disabled rows are sent and dropped engine-side, and the
engine writes the Content-Type each form mode implies. A `form-data` row may be
a **file part** (`{type: "file", src, fileName?, contentType?}`): the renderer
sends the path the user picked - never the bytes - and the engine opens the file
at send time. See [the engine's `body` union](../engine/api-reference.md#the-request-body-union)
for the full contract.

### API Methods

#### Health & Configuration

```typescript
apiService.getHealth(): Promise<EngineHealth>
apiService.getConfig(): Promise<EngineConfig>
apiService.updateConfig(config): Promise<EngineConfig>
```

#### Cookie jar

```typescript
apiService.getCookies(): Promise<GetCookiesResponse>
apiService.clearCookies(scope?: { environmentId: string | null }): Promise<ClearCookiesResponse>
```

The engine keeps one cookie jar per environment for design-mode requests
(issue #301); `CookiesCard` in Settings → General shows and clears them.

#### Request examples

```typescript
apiService.listRequestExamples(requestId): Promise<RequestExample[]>
apiService.createRequestExample(requestId, example): Promise<RequestExample>
apiService.deleteRequestExample(requestId, exampleId): Promise<void>
```

Saved example responses stored against a request (issue #481) - what an import
found next to it, and what a mock server will serve. **Not read-only any more**
(issue #588): the response viewer's *Save as example* keeps the response on
screen as one, and the Examples tab removes one. `PUT` still has no caller and
so no endpoint constant - the panel is a viewer, and editing a stored example is
its own change. The three consumers are in `queries/request-examples.ts`
(`useRequestExamplesQuery`, `useCreateRequestExampleMutation`,
`useDeleteRequestExampleMutation`); both writes settle by invalidating the one
list key rather than splicing a row in, since the engine decides the id, the
`order` an append lands on and the stored shape of the row.

A saved example is written with **`origin: "user"`**, and an imported one keeps
the engine's `"import"` default. That field is write-only from here - nothing in
the app reads it back and `RequestExample` does not claim it - because its
reader is the OpenAPI spec sync (#627), which may replace the examples a
document produced and must never touch one a person saved. The rest of the
payload is the importers' own mapping, `contentType` included (the response's
Content-Type header verbatim, `""` when it stated none), so an app-saved example
and an imported one are served identically. No `order` is ever sent: the engine
appends, which is what keeps a restarted mock answering with the same first
example.

No transformer, unlike a request row: an example carries no timestamp the app
renders and no column that predates a schema change, so the wire shape *is* the
domain shape - minus the `order`, `origin` and timestamps the `RequestExample`
type deliberately does not claim, since the list arrives already ordered and no
surface displays any of them. The stored order is the contract, not a suggestion: a mock
server answers with the first example of a matched request, so the panel renders
the list as received rather than re-sorting it.

Imported examples take a different route entirely: they ride **nested on their
request item** in `POST /import/apply` (`ImportApplyRequestItem.examples`), not
through this endpoint, so the whole tree still lands in one engine transaction.

#### Webhook inbox

```typescript
apiService.listInboxes(): Promise<Inbox[]>
apiService.startInbox(request?: StartInboxRequest): Promise<Inbox>
apiService.stopInbox(inboxId): Promise<Inbox>
apiService.deleteInbox(inboxId): Promise<DeleteInboxResponse>
apiService.updateInboxResponse(inboxId, response: Partial<InboxCannedResponse>): Promise<Inbox>
apiService.listInboxCaptures(inboxId, limit?, offset?): Promise<InboxCapturesResponse>
apiService.clearInboxCaptures(inboxId): Promise<ClearInboxCapturesResponse>
```

An inbox records the requests sent to it and answers a canned response
(issue #480); `modules/inbox/` is the surface. `updateInboxResponse` is a
merge-patch - an omitted field keeps what the inbox is serving - and the live
capture stream (`INBOX_LIVE`) is a plain `EventSource` rather than `SSEClient`,
which maps load-test metrics specifically. Captures arriving on that stream are
merged into the `listInboxCaptures` cache, so there is one list.
`deleteInbox` is the stronger of the two lifecycle calls: `stopInbox` frees the
listener and leaves the record and its captures readable for the life of the
engine process, while a delete takes both (issue #553). Its mutation *removes*
the captures cache entry rather than invalidating it - an invalidation would
refetch an id the engine now `404`s. `Inbox.captureCount` is what a delete would
destroy, and is what the confirmation is worded from.
`clearCookies` distinguishes three cases the way the engine does, and they are
not interchangeable: **omitted** clears every jar, `{ environmentId: null }`
clears only the jar used when no environment is selected, and an id clears that
environment's. It reaches `DELETE /cookies` with the parameter absent, present
and empty, or present with the id, respectively.

#### OAuth 2.0 mock issuer

```typescript
apiService.listMockIssuers(): Promise<MockIssuer[]>
apiService.startMockIssuer(request?: StartMockIssuerRequest): Promise<StartMockIssuerResponse>
apiService.updateMockIssuer(issuerId, update: UpdateMockIssuerRequest): Promise<MockIssuer>
apiService.stopMockIssuer(issuerId): Promise<StopMockIssuerResponse>
```

A local issuer that mints HS256 tokens on demand (issue #479); the Services
drawer (`modules/services/`) is the surface, added in #502 - before it these
routes had no client but curl and the MCP tools. Two asymmetries the surface has
to respect: `startMockIssuer` answers with the URLs and the signing key **only**,
not the full record, so the list is refetched rather than patched; and a stopped
issuer leaves the list altogether, unlike an inbox, which stays listed with
`running: false`. `updateMockIssuer` accepts only `expiresInSeconds`,
`failureMode` and `slowMs` - a port, client list or claim set cannot move under a
bound listener and the engine refuses one with a `400` rather than half-applying
it.

#### Collection mock server

```typescript
apiService.listMockServers(): Promise<MockServer[]>
apiService.startMockServer(request: StartMockServerRequest): Promise<MockServer>
apiService.stopMockServer(mockId): Promise<StopMockServerResponse>
apiService.listMockServerRoutes(mockId): Promise<MockServerRoute[]>
```

A loopback listener answering a collection's saved example responses on the
paths its requests describe (issue #481 phase 2). `collectionId` is the only
required field; `latencyMs` and `errorRatePct` are the injection knobs, and an
out-of-range value is a `400` rather than a clamp.

Two surfaces, deliberately split. `CollectionDetail/MockServerControl` is the
only one that can **start** one, because a mock needs a collection and the
Services drawer has none selected; the drawer's Mock servers group lists and
stops whatever is running, wherever it came from. Both read the same polled
list, so a mock started in one is visible in the other within a poll.

The knobs are sent from that control's options dialog and nowhere else
(`StartMockServerDialog`, issue #570), bounds-checked against
`mock-server-options.ts` before the request leaves - the engine's `400` names
the field but not the range. There is no update verb: `latencyMs` and
`errorRatePct` are read per response and so *could* change under a running
mock, but a run pointed at one has to be able to say which configuration
produced its numbers, so they are frozen at start like the route table.

`listMockServerRoutes` is **not** polled: the route table is a snapshot taken
when the mock started and a running mock does not reload the collection, so it is
fetched once per expanded row (`staleTime: Infinity`). Stopping drops the record
engine-side - unlike an inbox, which stays listed with `running: false` - so the
mutation *removes* the routes cache entry instead of invalidating it, which would
refetch an id the engine now answers `404` for.

#### Create vs update

For collections, requests and environments the engine splits the write verbs:
`POST /<resource>` creates and never updates; `PUT /<resource>/:id` updates and
answers an unknown `id` with `404`. They are not interchangeable, so `apiService`
keeps one method per verb:

- `createX(data)` posts the object to the collection path **with `id` stripped**
  (`withoutId` in `api.ts`). The engine assigns every id and answers a create
  carrying one with a `400`, and the `Create*Request` types declare `id?: never` -
  but TypeScript only excess-property-checks object literals, so a call site that
  spreads a whole record (a duplicate flow, a restored tab) would slip one
  through. The strip is what actually holds. (Import used to be the exception,
  pre-assigning ids to wire `parentId` / `collectionId` across a tree before
  anything was persisted; it sends one `applyImport` call now, see below.)
- `updateX(data)` takes `data.id`, puts it in the **path**, and sends the rest
  of the object as a merge-patch body - an omitted field keeps its stored value,
  an explicit `null` resets it to the default. The `id` is not repeated in the
  body; a body `id` disagreeing with the path is a `400`.

The full contract, including the null-vs-absent table and which fields have no
default, is in [engine/api-reference.md](../engine/api-reference.md) under
"Resource writes". `src/services/api.write-verbs.test.ts` pins the method and
path of every one of these calls - a regression here is invisible at every other
layer, because the payload shape does not change.

#### Collections

```typescript
apiService.listCollections(): Promise<Collection[]>
apiService.createCollection(data): Promise<Collection>   // POST /collections
apiService.updateCollection(data): Promise<Collection>   // PUT  /collections/:id
apiService.deleteCollection(id): Promise<void>
```

A collection carries **`dataSchema`** - the data contract it declares (issue
#599): `{columns?: string[], declaredAt?: number, fileName?: string}`, where
`{}` means it declares none. `CollectionTransformer` normalizes it field by
field rather than casting, because a row can come from an engine that predates
the column and every reader treats `columns` as a string array; use
`hasDataContract(schema)` instead of hand-rolling the check, since a cleared
contract is `{}` and not `undefined`.

On `updateCollection` the field is `CollectionDataSchema | null`, like
`parentId`: the engine reads absent as "keep the declared contract" and an
explicit `null` as "reset to none", so the Data tab's **Clear** is only
expressible as a null that survives to the wire. The rows behind the schema are
never sent by these calls at all - they ride only the `POST /runs` payload, and
are persisted by neither side.

A collection also carries **`openapi`** - the spec document it is bound to
(issue #637): `{specId?, specHash?, syncedAt?}`, where `{}` means bound to
nothing. It is normalized field by field for the same reason `dataSchema` is,
and `hasSpecBinding(binding)` is the check to use - a collection that was bound
and then unbound holds `{}`. On `updateCollection` the field is
`CollectionOpenApiBinding | null`, and the Spec tab's **Unbind** is that null.

#### Specs

```typescript
apiService.createSpec(data): Promise<SpecDocument>       // POST /specs
apiService.getSpec(id): Promise<SpecDocument>            // GET  /specs/:id
```

Create and read-by-id only. A document is immutable - a changed spec is a new
document and a moved binding, which is what keeps a run's `specHash` stamp
meaningful - and the **hash is computed engine-side** on the bytes it stored,
never here. There is no delete call: unbinding is a `PUT /collections/:id`, and
the document stays for whatever else binds it. `getSpec` returns `content` too
(the engine has no metadata-only read), so `useSpecQuery` caches it with
`staleTime: Infinity` rather than refetching a whole document to redraw a tab.

#### Requests

```typescript
apiService.listRequests(params?): Promise<Request[]>
apiService.getRequest(id): Promise<Request>
apiService.createRequest(data): Promise<Request>         // POST /requests
apiService.updateRequest(data): Promise<Request>         // PUT  /requests/:id
apiService.deleteRequest(id): Promise<void>
```

A request carries **`specOperation`** - which operation of the bound spec it is
(issue #637): `{operationId?, method, path}`, where `path` is the document's
**templated** path and not the URL the request sends. The engine serializes
`null` for a request that names none, and `RequestTransformer` turns that into an
absent key; on `updateRequest` the field is `SpecOperation | null`, so stamping
and clearing an identity are the same verb.

#### Reorder

```typescript
apiService.reorder(data: ReorderRequest): Promise<ReorderResponse>  // POST /reorder
```

The write path behind a drop. One call repositions any number of collections and
requests, and the engine applies the whole batch in one transaction - so a drop
that displaces N siblings is one round trip, not N `updateRequest` calls that can
half-land and race a concurrent create into the middle of their range.

The payload carries `moves` (each row's new `order`, plus `parentId` /
`collectionId` when it changes owner) and `normalize` (scopes to renumber dense
`0..n-1` in display order first, for a collection whose rows all predate explicit
orders). `modules/collections/reorder-math.ts` computes both from the sibling
lists the tree is already showing; the full contract is in
[engine/api-reference.md](../engine/api-reference.md) under `POST /reorder`.

Unlike the other writes, the response is **read**: it is the rows as written, and
`useReorderMutation` settles its caches on them so a normalization the engine
performed shows up without waiting for the refetch.

#### Environments

```typescript
apiService.listEnvironments(): Promise<Environment[]>
apiService.getEnvironment(id): Promise<Environment>
apiService.createEnvironment(data): Promise<Environment> // POST /environments
apiService.updateEnvironment(data): Promise<Environment> // PUT  /environments/:id
apiService.deleteEnvironment(id): Promise<void>
```

#### Global Variables

```typescript
apiService.getGlobals(): Promise<GlobalVariables>
apiService.updateGlobals(variables): Promise<GlobalVariables>
```

#### Import

```typescript
apiService.importFetch(url): Promise<ImportFetchResponse>          // POST /import/fetch
apiService.applyImport(payload): Promise<ImportApplyResponse>      // POST /import/apply
```

`applyImport` sends a whole parsed import - collections, requests, environments
and **spec documents** - in one atomic call. Items reference each other by
opaque `tempId`s and the engine
returns the temp-id -> real-id `idMap`; a rejected payload persisted nothing, so
there is nothing to roll back. An OpenAPI import puts the document in the
`specs` section and binds its root collection with `openapi.specTempId`, so the
spec, the binding and every request's `specOperation` land in the same
transaction - `specs: []` is sent for every other format rather than omitted, so
the payload is one shape. Imported **globals** are not in this payload: they
are a singleton written through `updateGlobals` after the apply succeeds. See
[import-collections/README.md](./import-collections/README.md#3-persist---orchestratorts)
for the pipeline and
[engine/api-reference.md](../engine/api-reference.md#post-importapply) for the
contract.

#### Execution

```typescript
apiService.composeRequest(data): Promise<ComposedRequest>
apiService.executeRequest(data): Promise<SanityResult>
apiService.startLoadTest(data): Promise<StartLoadTestResponse>
apiService.startScenarioRun(data): Promise<StartLoadTestResponse>
```

`startLoadTest` and `startScenarioRun` are the **same `POST /runs` endpoint and
the same `202 {runId}` answer** - the payload is what selects the executor. A
scenario states its work as an ordered collection
(`{scenario: {source: "collection", collectionId, recursive?, iterations?, data?}}`),
so it carries no `method`/`url`, and its iteration count lives
inside the block rather than beside a load-test mode. `data` is the parsed rows
of a data file (`services/data-files/`), sent inline because the engine never
opens a file; `iterations` is **omitted** when the user left it blank, so the
engine's "absent means one pass per row" rule stays in one place. Both send `allowScriptRequests`,
for the same reason: every step runs the scripts a Send of that request would
run. The engine resolves the whole plan before answering, so an empty
collection, a step that will not compose, or a plan over `maxScenarioSteps` is a
`400` with **no run row created** - a failed start leaves nothing to clean up.

Adding a load `mode` beside the block makes it a **scenario load run** (issue
#357): the same plan, driven by `concurrency` virtual users on the event loop.
The *presence* of `mode` is the whole discriminator, so a design-mode payload
must carry none at all - not a falsy one - and `RunCollectionDialog` therefore
spreads the load fields in rather than always sending them. `constant_rps`, and
any non-zero `rps`/`targetRps` on any mode, is a `400`: an open-loop arrival
rate over a multi-step sequence is an arrival-rate executor the engine does not
implement, and it is refused rather than quietly run closed-loop. Such a run's
`type` is `load`, so it streams `metrics` ticks and **not** `step` events - the
caller must attach `loadTestService`, not `scenarioRunService`.

What comes back for one differs in two places worth knowing. `GET /runs/:id`
returns the **resolved manifest** in place of the block that was sent
(`{source, collectionId, recursive, iterations, dataRowCount, steps[]}`, each
step `{index, requestId, name, method, url}` with the *stored* url, never a
composed one) - that is what the run tab's context bar reads, through
`run-scenario.ts`. The paginated `GET /runs` list row cannot carry the manifest
and instead carries `summary.scenario`
(`{collectionId, iterations, recursive, stepCount}`), present on any row whose
snapshot carries a scenario block - so a scenario *load* run gets it too. The
history row reads it because a run whose work is a sequence has no `url` or
`method` for the ordinary row to show, and that is true of both executors.

A scenario load run's **report** carries the per-step breakdown the design-mode
runner has no need for: `scenario.steps[]`
(`{index, name, requestId, method, executed, errors, latency:{min,p50,p95,p99,max}}`)
plus `virtualUsers` and `iterationsAbandoned`. It stores no per-step `results`
rows, so that array is the only per-step record such a run keeps.

A step also carries `tests` (`{sampled, passed, failed}`) when its own
post-request script was replayed against that step's sampled responses - the
deferred per-step validation. The key is **absent** for a step that asserted
nothing or whose script drew no sample, which is not the same claim as zero
failures, so the table shows a dash there rather than a `0`.

A **design run's** list row carries one thing the detail route says at greater
length: `resultSummary` (`{statusCode, latencyMs}`), the outcome of its single
exchange. `GET /runs/:id` attaches the whole `result` instead, trace and bodies
included, which is why the list carries the two numbers rather than that - and
why the context bar's Recent sends section is one list call and no report fetch.
Load and collection runs carry no `resultSummary`: their results are unbounded.

`composeRequest` (`POST /compose`, issue #226) resolves `{{variables}}` and
`inherit` auth engine-side and returns the payload the other two accept
unchanged - every send site composes first, so nothing is interpolated twice.

**GraphQL schema introspection is a send site too** (`lib/graphql/introspect.ts`,
issue #228): it composes the endpoint, overlays the introspection query onto the
composed `url` / `headers` / `auth`, and executes that - which is how an
endpoint whose credentials live in the Auth panel gets introspected at all. It
sends the composed request's auth but neither its body nor its script parts.

**A Send-with-row carries one extra field** (issue #601): `data`, the row the
UrlBar's caret picked, added *beside* the composed payload rather than passed
through `POST /compose`. `{{data.*}}` survives composition by design, so the
tokens are still written when `/execute` binds them against the row; composing
the row in would be composing twice. Both send handlers take it - buffered and
streaming - because the engine binds a row on either path, and a row silently
dropped on one of them is the written-but-never-read defect. An ordinary Send
passes no argument at all, so its payload is byte-identical to what it was.

It is the **only** send site that sets `transient: true` (issue #382), because
it is the only one the user did not initiate. The engine then runs it in full
and records nothing: no History entry, no result trace holding the credentials
composition resolved, and no retention prune evicting a real run. It also
carries the target's `environmentId` onto the execute payload, which is what
scopes the engine's cookie jar - without it a cookie-session endpoint answered
real requests and failed introspection alone. Every other send site omits the
flag and is recorded as usual; see
[api-reference.md](../engine/api-reference.md#post-execute).

#### Run Management

```typescript
// Paginated, filtered history (newest first). Rows carry a compact `summary`
// (url/method/mode/duration/concurrency/comment), not the full configSnapshot.
apiService.listRuns(params?: RunListParams): Promise<RunListResponse>
// Every page as a flat list (Settings' count + clear).
apiService.listAllRuns(params?): Promise<Run[]>
apiService.getRun(id): Promise<Run>            // full configSnapshot
apiService.getRunReport(id): Promise<RunReport>
// Response headers/bodies captured for a run's samples. Its own request, not
// fields on the report - see below.
apiService.getRunSamples(id, { limit?, offset? }): Promise<RunSamplesResponse>
apiService.stopRun(id): Promise<StopRunResponse>
apiService.deleteRun(id): Promise<void>
```

`deleteRun` on a run that is still in progress stops it engine-side first, so it
takes as long as the stop does, and it **rejects with a 409** if the run's worker
has not finished writing in time - nothing is deleted in that case. Callers must
handle that rejection: `HistoryList` turns it into a toast telling the user to
retry, and Settings' *Clear run history* already counts per-run failures through
`Promise.allSettled`. The wording of that toast is the caller's, keyed off
`statusCode`, rather than the engine's message - which is a caller's choice now
that `httpClient` reads the message on every error shape (issue #173), not a
constraint.

**Captured response bodies are fetched separately, and lazily.** A load run
stores the response headers and body for its failures, its slow outliers and a
few exemplars of each status code; `GET /runs/:id/report` deliberately does not
carry them, because that endpoint loads and JSON-parses every result row for the
run on each fetch and the dashboard polls it. `useRunSamplesQuery(runId, enabled)`
(`queries/runs.ts`) wraps `getRunSamples` and is enabled **only once a reader
expands a sample** - passing `true` unconditionally would reintroduce exactly the
cost the split exists to avoid. It returns a `Map` keyed by `resultId`, joined
against `report.results[].id`.

Two surfaces consume it - the dashboard's Sampled Requests
(`RequestResponseView`) and the history Samples tab - and both render
`CapturedResponseNotice` (truncated / dropped for budget / binary) and
`CapturedDataWarning` (the run stored responses verbatim, including anything
credential-shaped). Both notices live in `components/shared`, so the wording
exists once rather than twice.

#### Scripting

```typescript
apiService.getScriptCompletions(): Promise<ScriptCompletionsResponse>
```

#### OAuth 2.0

```typescript
apiService.fetchOAuth2Token(data): Promise<OAuth2TokenResponse>        // POST   /oauth2/token
apiService.getOAuth2TokenStatus(cacheKey): Promise<OAuth2StatusResponse> // GET  /oauth2/token?key=
apiService.clearOAuth2Token(cacheKey): Promise<void>                   // DELETE /oauth2/token?key=

// Interactive Authorization Code flow (engine-hosted loopback + PKCE)
apiService.startOAuth2Authorize(data): Promise<OAuth2AuthorizeStart>
apiService.getOAuth2AuthorizeStatus(attemptId): Promise<OAuth2AuthorizeStatus>
apiService.completeOAuth2Authorize(attemptId, callbackUrl): Promise<OAuth2AuthorizeStatus>
```

These back the OAuth 2.0 auth editor. TanStack Query wraps the non-interactive
ones in `queries/oauth.ts` (`useOAuth2TokenStatusQuery` - polls status ~30s;
`useFetchOAuth2TokenMutation`, `useClearOAuth2TokenMutation`). The token
`cacheKey` is computed client-side by `services/oauth/cache-key.ts`, byte-identical
to the engine so the app and engine agree on cache slots without a round-trip.
The interactive flow is orchestrated in `services/oauth/authorize.ts` (opens the
system browser or an embedded Electron window, then polls the engine).

> **`HttpClient.delete`** takes an optional `params` argument so the token-clear
> call can pass `?key=`.

## SSE Client (`services/sse-client.ts`)

Server-Sent Events client for a run's live stream - load-test metrics, and a
collection run's per-step progress.

### Features

- **Single endpoint**: Connects to `/runs/:runId/live`. The engine retains a replayable tick
  topic, so the client connects immediately after `POST /runs` with no attach race - it replays
  from offset 0 and tails to the `complete` event (even for sub-second runs).
- **No custom reconnect loop**: The engine sends an explicit `complete` event at normal run end,
  so a `CLOSED` readyState is treated as terminal. Transient `CONNECTING` errors are left to the
  browser's built-in `EventSource` retry. At run end the app converges on the stored report
  (`GET /runs/:id/report`) rather than reconnecting to the stream.
- **Event Handling**: `metrics` events, `step` events, `monitor` events, `complete` event,
  `error` handling
- **Metrics Parsing**: `mapSseMetrics()` transforms the engine's camelCase blob to the frontend
  `LoadTestMetrics` shape (includes drops, queue-wait, percentiles, bytes, status-code map)
- **Step Parsing**: `parseStepEvent()` narrows a scenario run's `step` payload and returns `null`
  for one it cannot read. A malformed event is **dropped, never defaulted** - the step list keys
  on `(iteration, stepIndex)`, so a defaulted `0:0` would collide with the real first step's row
  rather than merely say nothing.
- **Monitor Parsing**: `parseMonitorEvent()` narrows a `monitor` frame the same way and returns
  `null` for one it cannot read. A sample defaulted to `timestamp: 0` would join onto the very
  start of the run's timeline and draw a reading at a moment it was never taken; individual
  non-numeric entries are dropped, because the rest of the scrape is still real data.

### Usage

```typescript
sseClient.connect(
  runId: string,
  onMessage: (metrics: LoadTestMetrics) => void,
  onError: (error: Error) => void,
  onClose: () => void,
  onStep?: (step: ScenarioStepEvent) => void,     // scenario runs only
  onMonitor?: (sample: MonitorSample) => void     // runs with a `monitor` block only
);

sseClient.disconnect();
sseClient.isConnected(): boolean
```

### Event Types

- **`metrics`**: Real-time metrics update (JSON payload). Load runs only - a scenario run's work
  is sequential, so a per-tick aggregate would describe one request at a time.
- **`step`**: One step execution of a scenario run - `{iteration, stepIndex, name, outcome,
  statusCode, latencyMs}`. Listened for only when `onStep` is passed, since a load run never
  emits one.
- **`monitor`**: One scrape of the run's monitored endpoint - `{timestamp, series}`. Listened
  for only when `onMonitor` is passed. Interleaved with `metrics` ticks on one id space, so
  `Last-Event-ID` resume replays both in the order they happened.
- **`complete`**: The run reached a terminal status
- **`error`**: Connection error (triggers reconnection)
- **`open`**: Connection established

## API Endpoints (`config/api-endpoints.ts`)

Centralized endpoint configuration:

```typescript
export const API_ENDPOINTS = {
  BASE_URL: "http://127.0.0.1:9876",
  
  // Health & Config
  HEALTH: "/health",
  CONFIG: "/config",
  
  // Collections
  COLLECTIONS: "/collections",
  COLLECTION_BY_ID: (id: string) => `/collections/${id}`,
  
  // Requests
  REQUESTS: "/requests",
  REQUEST_BY_ID: (id: string) => `/requests/${id}`,

  // Batch reorder for both entity kinds - one drop, one call, one transaction
  REORDER: "/reorder",
  
  // Cookie jar - GET reads every scope, DELETE clears one or all
  COOKIES: "/cookies",

  // Execution
  EXECUTE_REQUEST: "/execute",
  START_LOAD_TEST: "/runs",

  // OAuth 2.0
  OAUTH2_TOKEN: "/oauth2/token",
  OAUTH2_AUTHORIZE_START: "/oauth2/authorize/start",
  OAUTH2_AUTHORIZE_COMPLETE: "/oauth2/authorize/complete",
  OAUTH2_AUTHORIZE_STATUS: (id: string) => `/oauth2/authorize/${id}`,
  
  // Runs
  RUNS: "/runs",
  RUN_BY_ID: (id: string) => `/runs/${id}`,
  RUN_REPORT: (id: string) => `/runs/${id}/report`,
  RUN_STOP: (id: string) => `/runs/${id}/stop`,
  // Captured response headers/bodies, fetched only when a sample is expanded
  RUN_SAMPLES: (id: string, limit: number, offset: number) =>
    `/runs/${id}/samples?limit=${limit}&offset=${offset}`,
  
  // Webhook inbox - engine-hosted listener that records what is sent to it.
  // START is a verb path: an inbox lives for the engine process, so the
  // POST-creates/PUT-updates split does not apply to it.
  INBOX: "/inbox",
  INBOX_START: "/inbox/start",
  INBOX_STOP: (inboxId: string) => `/inbox/${inboxId}/stop`,
  // PUT patches the canned response; DELETE removes the inbox and its captures.
  INBOX_BY_ID: (inboxId: string) => `/inbox/${inboxId}`,
  INBOX_CAPTURES: (inboxId: string, limit: number, offset: number) =>
    `/inbox/${inboxId}/requests?limit=${limit}&offset=${offset}`,
  INBOX_CAPTURES_CLEAR: (inboxId: string) => `/inbox/${inboxId}/requests`,
  INBOX_LIVE: (inboxId: string) => `/inbox/${inboxId}/live`,

  // Collection mock server - a loopback listener answering the collection's
  // saved examples. Verb paths for the same reason the inbox uses them. No PUT
  // and no DELETE: the route table is a start-time snapshot, so changing what a
  // mock serves means starting another one, and stopping is what ends it.
  MOCK_SERVER: "/mock",
  MOCK_SERVER_START: "/mock/start",
  MOCK_SERVER_STOP: (mockId: string) => `/mock/${mockId}/stop`,
  MOCK_SERVER_ROUTES: (mockId: string) => `/mock/${mockId}/routes`,

  // Real-time stats (SSE)
  METRICS_LIVE: (runId: string) => `/runs/${runId}/live`,

  // Time-series metrics (JSON, paginated) - used to hydrate history
  STATS_TIME_SERIES: (runId: string, limit = 5000, offset = 0) =>
    `/runs/${runId}/metrics?limit=${limit}&offset=${offset}`,

  // Server vitals scraped during the run (JSON, paginated, same envelope).
  // Fetched by the history view only when the report says the run recorded some.
  RUN_MONITOR: (runId: string, limit = 5000, offset = 0) =>
    `/runs/${runId}/monitor?limit=${limit}&offset=${offset}`,
};
```

> Note: the old `STATS_STREAM` SSE constant was removed - live metrics go through
> `METRICS_LIVE` only; `/stats` is now used solely for paginated historical reads.

## Request Execution Flow

### Single Request Execution

1. **User Action**: Clicks "Send" in RequestBuilder
2. **Request Transformation**: Frontend format → backend format (raw - no
   client-side `{{variable}}` resolution)
3. **Composition**: `apiService.composeRequest()` → `POST /compose` - the
   engine resolves `{{variables}}` and `inherit` auth against the request's
   `collectionId` chain and the active `environmentId`, and returns the
   execute-ready payload (issue #226)
4. **API Call**: `apiService.executeRequest()` with the composed payload,
   unchanged → `POST /execute`, carrying `stream: false` explicitly
5. **Response Transformation**: Backend format → frontend format
6. **Display**: Response shown in ResponseViewer

**`stream` is sent on every execute, never elided.** It follows the same
never-elide rule as `httpVersion` and the redirect policy, for a sharper
reason: the endpoint's two answers are different *shapes*, so a caller that let
an engine-side default decide would not know which one it was about to parse.

### Streaming Request Execution (issue #574)

A request whose **Event stream** setting is on takes the same composition and a
different answer. `composeForSend` is shared with the buffered path - the two
must put the identical request on the wire, or a stream would measure something
Send does not - and only the last two steps differ:

4. **API Call**: `apiService.executeStreamRequest()` → `POST /execute` with
   `stream: true`, answered `202 {runId, eventsUrl, status}` at once. There is
   no exchange yet: the engine has created the run row and handed the transfer
   to a managed consumer worker.
5. **Tail**: `useExecutionEvents` opens an `EventSource` on the answer's
   `eventsUrl` **as given** - the engine names where its own events are, and a
   second spelling of that path in `api-endpoints.ts` would be a copy that can
   disagree with the answer. Frames land in `execution-events-store`; the
   Events tab renders them live.
6. **Swap to stored truth**: on the relay's `complete` frame the provider
   fetches `GET /runs/:id/report` and `restore-response.ts` maps the trace's
   `events` node onto the response, which is the record from then on.

**A different `EventSource` from the `SSEClient` singleton below.** That client
belongs to load and scenario runs, is a single connection whose lifetime is the
dashboard's, and deliberately never reconnects. This one owns its retry, for
the reason `useInboxLive` does (issue #506): `EventSource` treats any non-200
as fatal, and a reconnect landing inside the engine's stale-claim window meets
a `409 run_events_in_use` from the claim the previous socket still holds - so a
single unlucky disconnect would otherwise end the stream for the life of the
tab, silently. Resume travels as `?lastEventId=`, which picks up at the frame
*after* the one named, so a dropped consumer re-renders nothing.

An answer missing `runId` or `eventsUrl` is a malformed answer and throws,
rather than leaving the pane on "streaming" with no run to stop. Refusals -
`stream` with `transient`, or with a pre-/post-request script - come back as a
`400` the user has to read, so they are rendered as the response *and* raised
as a toast.

The renderer sends the **inline** compose shape (`{ request, collectionId,
environmentId }`) rather than compose-by-id, because Send executes the *editor
state* - possibly unsaved, or a detached History replay copy that has no saved
row at all. `requestId` is attached to the execute payload afterwards purely to
link the run to the saved request in History; `environmentId` scopes both
composition and the engine's script context / variable persistence.
`useVariableResolver()` still exists but is **preview-only** (tab titles,
previews, unresolved-token painting) - see
[variable-resolution](./variable-resolution.md).

Auth (bearer/basic/api-key/oauth2) is resolved **engine-side** from the request's
`auth` object - the app no longer builds `Authorization` headers itself. When a
non-interactive OAuth 2.0 token can't be obtained, the response carries an
`errorCode` of `AUTH_REQUIRED` (interactive sign-in needed) or `AUTH_FAILED`, and
the request builder surfaces a toast pointing the user at the Auth tab.

**Example Request:**
```typescript
await apiService.executeRequest({
  method: "GET",
  url: "https://api.example.com/users",
  headers: { "Authorization": "Bearer {{token}}" },
  preRequestScripts: [
    { origin: "request", id: "req_123", script: "console.log('Pre-request');" }
  ],
  postRequestScripts: [
    {
      origin: "request",
      id: "req_123",
      script: "pm.test('Status 200', () => pm.expect(pm.response.code).to.equal(200));"
    }
  ],
  followRedirects: true,
  maxRedirects: 10,
  httpVersion: "auto",
  requestId: "req_123",
  environmentId: "env_456"
});
```

`preRequestScripts` / `postRequestScripts` are an ordered list of `ScriptPart`s
(`{ origin: "collection" | "request", id?, name?, script }`), not a single
string: the collection chain's scripts (root→leaf), then the request's own.
The renderer builds the list from its editor state (`scriptParts()` in
`request-builder/utils/script-parts.ts`) and it rides through `POST /compose`
untouched - script text is never interpolated; the by-id compose path (used by
MCP) builds the same list engine-side. The **engine** joins the parts and runs
the result - see `docs/engine/architecture.md` → *Request composition boundary*.

**Redirect policy and protocol are always sent, never elided.**
`followRedirects`, `maxRedirects` and `httpVersion` all come from the request's
**Settings** tab and are included on every execute even when they equal the
defaults. The engine defaults `follow_redirects` to `true`, so omitting a
`false` would follow the 3xx the user asked to inspect - a bug the app shipped
with for a long time, when nothing in the renderer sent these fields at all.
The same three fields go out with `startLoadTest()`, so a load test exercises
the same policy and protocol the request was configured with - there is no
separate, load-test-only protocol control; the Settings tab's picker is the
only one, and it governs Send and load test alike. `httpVersion` is
`"auto" | "http1.1" | "http2"`: `"auto"` lets ALPN negotiate, `"http1.1"`
forces HTTP/1.1, and `"http2"` attempts h2 over TLS with a silent fallback to
1.1 over plain `http://` (curl's `CURL_HTTP_VERSION_2TLS` semantics).

**Example Response:**
```typescript
{
  status: 200,
  statusText: "OK",
  headers: { "content-type": "application/json" },
  body: { users: [...] },
  bodyRaw: '{"users":[...]}',
  httpVersion: "HTTP/1.1",
  httpVersionDowngraded: false,
  timing: { total: 150, dns: 10, connect: 20, ... },
  testResults: [
    { name: "Status 200", passed: true }
  ],
  consoleLogs: [
    { source: "pre", level: "log", message: "Pre-request" },
    { source: "test", level: "warn", message: "slow response" }
  ]
}
```

`consoleLogs` entries name the script that wrote them and the `console.*` level
that was called. A bare `string` is the pre-structured shape an older engine
sidecar sends; `console/parse-logs.ts` decodes both and is the only place that
knows the difference (see
[the engine API reference](../engine/api-reference.md#post-execute)).

`httpVersion` here is the **negotiated** protocol (`"HTTP/1.1"` / `"HTTP/2"` /
`""` when nothing was negotiated) - an outcome, not an echo of the request's
own `httpVersion`. The Raw tab in the response viewer prints it on the
request/status line instead of a hardcoded `HTTP/1.1`.

`httpVersionDowngraded` says the request asked for `http2` and the connection
negotiated something older - the one thing neither `httpVersion` can say alone,
since neither knows about the other. The engine computes it, and the renderer
carries it as-is rather than comparing the negotiated protocol against the
tab's current setting: a restored or replayed response sits beside request
state that may have changed since, and the answer belongs to the exchange.
`ResponseStatusBar` draws it as a warning beside the status chip, and only when
it is true. Load runs carry the whole-run count as
`report.summary.httpVersionDowngraded`, which `LoadTestDetail` shows next to
the requested protocol - without it a run measured entirely over HTTP/1.1 still
read "HTTP/2" there
([#215](https://github.com/athrvk/vayu/issues/215)).

`report.sampling` carries what each of the run's bounded stores thinned away -
`successTracesDropped` / `slowTracesDropped` for the trace records behind
`report.results`, and `responseSamplesDropped` for the buffer post-run test
scripts are graded on. The renderer treats a non-zero count as "this list is a
*sample* of a larger set": `SampleRetentionNote` (shared) renders under the
dashboard's Sampled Requests, the history Samples tab and the Test Validation
card, and the sample-count badges say **shown** rather than *captured*, since
`results` is capped at 100 by the report route irrespective of retention.

An **absent** `sampling` is a run whose stored summary predates the counts, not
a run that dropped nothing, so the note stays out rather than asserting a
completeness it cannot verify - the same absent-vs-zero rule
`httpVersionDowngraded` follows above.

`report.auth` follows that rule too. The engine refreshes a header-placed
OAuth 2.0 token *while a load run is going*, and this section is what it did:
`refreshes[].atSeconds` per renewal, plus `refreshFailures` and a `lastError`
when one was refused. `LoadTestDetail` renders it as a one-line note in the
header (`authRefreshNote`), a warning when a refresh failed - that failure is
what explains 401s appearing partway through an otherwise healthy run. Absent
means the run could never refresh (no OAuth 2.0 auth, a non-expiring or
query-placed token, `autoRefreshToken: false`, or an older sidecar); present
with an empty `refreshes` means it was watched and never needed to. The same
eligibility rule decides whether `OAuth2LoadTestGuard` still blocks a run
longer than its token - `isMidRunRefreshable` mirrors the engine's
`plan_auth_refresh`, and the two must change together.

### Load Test Execution

1. **User Action**: Configures and starts load test
2. **Composition**: the request half (method/url/headers/body/auth/`tests`
   script parts) goes raw through `apiService.composeRequest()` → `POST
   /compose`, same as Send - so a load test measures the same composed request
   Send sends
3. **Request Transformation**: composed request half + frontend
   `LoadTestConfig` → backend format
4. **API Call**: `apiService.startLoadTest()` → `POST /runs`
4. **Response**: `{ runId: "run_123", status: "running" }`
5. **Dashboard Initialization**: `useDashboardStore().startRun(runId)`
6. **SSE Connection**: `loadTestService.startMonitoring(runId)` connects to `/runs/:runId/live` (a module singleton, so the stream outlives the view)
7. **Metrics Streaming**: Real-time metrics update dashboard
8. **Completion**: When test completes, fetch final report via `GET /runs/:id/report`

**Example Load Test Request:**
```typescript
await apiService.startLoadTest({
  request: {
    method: "POST",
    url: "https://api.example.com/data",
    headers: { "Content-Type": "application/json" },
    body: { mode: "json", content: '{"key": "value"}' }
  },
  followRedirects: true,
  maxRedirects: 10,
  httpVersion: "auto",
  mode: "constant_rps",
  duration: "30s",
  targetRps: 100,
  concurrency: 50,
  requestId: "req_123",
  environmentId: "env_456",
  comment: "Stress test",
  // Optional pass/fail budgets. Omitted entirely when none were declared - the
  // engine rejects an empty object rather than starting an unjudged run.
  thresholds: { latencyP99Ms: 50, maxErrorRatePct: 0.1 }
});
```

**Budgets and the verdict.** `LoadTestConfig.thresholds` (`RunThresholds`) rides
through to `POST /runs` under the engine's own camelCase metric names, and the
report comes back with `thresholdValidation` - one check per budget plus a
`verdict` of `"passed"` / `"failed"` - which `ThresholdVerdict`
(`components/shared`) renders on the dashboard report and the history Overview.
It is the aggregate counterpart to `testValidation`: a `pm.test` script sees one
response at a time and cannot assert a p99 or an error rate, so a run whose
every assertion passed can still have missed its budget. `undefined` is a run
that declared none - not a run that passed nothing - so a report without the
section renders exactly as it did before budgets existed. The dialog seeds its
p99 field from the client `sloThresholdMs` setting, which until then only
annotated a chart.

The engine range-checks this payload before it creates the run row and answers a
violation with `400 invalid_run_config` (accepted ranges are tabulated under
[POST /runs](../engine/api-reference.md#post-runs)). The renderer's own limits
live in `LOAD_TEST_LIMITS` (`src/constants/load-test.ts`) and must stay at or
inside the engine's.

#### `success_sample_rate` is a period, not a percentage

The engine keeps a success trace when `counter % success_sample_rate == 0` - one
in every N. The dialog's control is a percentage, and the renderer converts
between them with `successSamplePeriod` (`constants/load-test.ts`): 100% becomes
a period of `1`, 1% becomes `100`, and the default 10% is the fixed point where
the two units coincide. Sending the percentage straight through, as the renderer
did before, inverts the slider - "100% - everything" kept 1%.

A `0` is a division by zero engine-side, so the control's floor is 1%. "Keep no
success traces" is the **Save timing breakdown** toggle, which gates storage
outright.

#### Dialog ceilings are a user setting

`LOAD_TEST_LIMITS` (`constants/load-test.ts`) holds the ranges the load dialog
offers, and four of its ceilings are user-adjustable in **Settings → Load
testing** (`loadTestCeilings` on `client-settings-store`). The dialog reads them
through `resolveLoadTestLimits`, never off the constant.

These are the app's policy and sit inside the engine's own bounds, which are
crash guards rather than throttles: a run's `concurrency` becomes an *eager*
per-worker curl-handle pre-allocation, so the engine caps it at 10x
`event_loop::MAX_CONCURRENT`. `LOAD_TEST_CEILING_BOUNDS` pins each settable
ceiling at that guard, so no value on the settings screen can compose a run the
engine rejects. The floors are not settable at all - below them the values are
not "small", they are unusable (a `concurrency` of 0, a sample period of 0).

## Error Handling

### HTTP Errors

All HTTP errors are transformed to `ApiError`:

```typescript
try {
  await apiService.executeRequest(...);
} catch (error) {
  if (error instanceof ApiError) {
    console.error(error.userFriendlyMessage);
    console.error(error.statusCode);
    console.error(error.errorCode);
  }
}
```

### Network Errors

Network errors (timeout, connection failed) are caught and displayed:

```typescript
if (error.isTimeout) {
  // Show timeout message
} else if (error.isNetworkError) {
  // Show network error message
}
```

### SSE Errors

The SSE client does **not** reconnect. `EventSource` cannot set `Last-Event-ID`
on a fresh connection, so a manual reconnect would re-request the topic from
offset 0 and duplicate every tick already plotted.

- Transient errors (`CONNECTING`): left to the browser's own retry, which does
  carry `Last-Event-ID`
- Terminal errors (`CLOSED`): connection disposed and the close handler runs,
  which converges on `GET /runs/:id/report`

## Connection Management

### Health Checking

The app polls `/health` endpoint to verify engine connectivity:

```typescript
useHealthQuery() // Polls every TIMING.HEALTH_CHECK_INTERVAL_MS (30s)
```

**Health Response:**
```typescript
{
  status: "ok",
  version: "0.3.0",
  workers: 8
}
```

### Engine Startup

The Electron main process (`electron/sidecar.ts`) manages engine lifecycle:
- Spawns engine process on app start
- Monitors health via `/health` endpoint
- Handles graceful shutdown on app quit

## Best Practices

1. **Always use `apiService`**: Don't call `httpClient` directly
2. **Handle errors**: Always wrap API calls in try/catch
3. **Use user-friendly messages**: Display `error.userFriendlyMessage` to users
4. **Transform data**: Use service layer for format transformation
5. **Cache queries**: Use TanStack Query for automatic caching
6. **Disconnect SSE**: Always disconnect SSE when component unmounts

## Testing

### Mocking API Calls

Use TanStack Query's query client for testing:

```typescript
import { QueryClient } from '@tanstack/react-query';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } }
});
```

### Mocking Services

Mock `apiService` methods:

```typescript
jest.spyOn(apiService, 'executeRequest').mockResolvedValue(mockResponse);
```

## Troubleshooting

### Engine Not Responding

1. Check if engine is running: `curl http://127.0.0.1:9876/health`
2. Check engine logs in Electron console
3. Verify port 9876 is not blocked

### SSE Not Connecting

1. Verify load test is running (`status: "running"`)
2. Check browser console for SSE errors
3. Verify endpoint: `/runs/:runId/live` or `/runs/:runId/metrics`

### CORS Errors

Should not occur (same-origin: localhost), but if they do:
- Verify engine CORS settings
- Check if request is going to correct origin
