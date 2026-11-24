---
description: >-
  The query keys, how a write invalidates the cache and the cache policy in `config/cache.ts`.
---

# Query Keys & Cache Invalidation

Centralized in `app/src/queries/keys.ts`, using TanStack Query's hierarchical key factory pattern.
**Copy the shapes from that file rather than hand-writing a key** - a key that differs by one segment is not an error, it is a silent cache miss that presents as a data bug:

```typescript
// app/src/queries/keys.ts (abridged)
collections: {
  all: ["collections"],                                   // a constant, not a call
  lists: () => ["collections", "list"],
  list: () => ["collections", "list"],
  details: () => ["collections", "detail"],
  detail: (id) => ["collections", "detail", id],
},
requests: {
  all: ["requests"],
  lists: () => ["requests", "list"],
  listByCollection: (collectionId) => ["requests", "list", { collectionId }],  // RequestSummary[]
  fullListByCollection: (collectionId) => ["requests", "list", { collectionId }, "full"],  // Request[], the column audit's
  details: () => ["requests", "detail"],
  detail: (id) => ["requests", "detail", id],
  examples: (id) => ["requests", "detail", id, "examples"],  // saved example responses (#481)
},
trash: {
  all: ["trash"],
  list: () => ["trash", "list"],   // no per-entry detail cache - the list is the only read
},
runs: {
  all: ["runs"],
  lists: () => ["runs", "list"],
  list: (filters = {}) => ["runs", "list", filters],      // keyed by its server-side filters (q, baseline, origin, type, status)
  lastDesigns: () => ["runs", "lastDesign"],               // prefix: invalidate every request's last run
  lastDesign: (requestId) => ["runs", "lastDesign", requestId],
  recentDesigns: () => ["runs", "recentDesign"],           // prefix: invalidate every request's list
  recentDesign: (requestId) => ["runs", "recentDesign", requestId],
  lastCollectionRuns: () => ["runs", "lastCollectionRun"], // prefix: invalidate every collection's row
  lastCollectionRun: (collectionId) => ["runs", "lastCollectionRun", collectionId],
  baselines: () => ["runs", "baseline"],                  // prefix: invalidate every request's and collection's pin
  baseline: (requestId) => ["runs", "baseline", requestId],
  collectionBaseline: (collectionId) => ["runs", "baseline", "collection", collectionId],
  requestRuns: () => ["runs", "requestRun"],              // prefix: invalidate every request's and collection's compare picker
  requestRun: (requestId) => ["runs", "requestRun", requestId],
  collectionRun: (collectionId) => ["runs", "requestRun", "collection", collectionId],
  count: () => ["runs", "count"],                         // Settings' stored-run count, a bare number
  detail: (id) => ["runs", "detail", id],
  report: (id) => ["runs", "report", id],
  timeSeries: (id) => ["runs", "timeSeries", id],          // prefix: every read of the run's tick series
  timeSeriesDownsampled: (id, maxPoints) => ["runs", "timeSeries", id, { maxPoints }], // the History charts' one read
  monitorSeries: (id) => ["runs", "monitorSeries", id],   // prefix: scraped server vitals, when the run had a monitor
  monitorSeriesDownsampled: (id, maxPoints) => ["runs", "monitorSeries", id, { maxPoints }], // the History charts' one read
  samples: (id) => ["runs", "samples", id],               // captured response bodies, fetched lazily
},
// environments mirrors collections; globals / cookies / health / config /
// scriptCompletions / scriptTypes / oauth / prefetch each own a root.
```

The `lists()` / `details()` levels exist to be invalidated as prefixes; what a query is keyed on is `list()` / `detail(id)`.
`requests.examples(id)` sits *under* `detail(id)` rather than beside it, because examples are owned by the request: invalidating one request's subtree drops its examples with it, which is what a request delete needs, and what a restored example needs, since `requests.all` reaches it by prefix (#2971).
`runs.lastDesign`, `runs.recentDesign`, `runs.lastCollectionRun`, `runs.baseline` and `runs.requestRun` (and the `collectionBaseline` / `collectionRun` keys beside them) sit under `runs.all` but deliberately **not** under `runs.lists()` - see below.

`runs.baseline(requestId)` caches the run pinned as that request's (or collection's) baseline (`GET /runs?baseline=true&requestId=&limit=1`), which the history report's vs-baseline strip reads.
A collection load run has no `requestId`, so its pin is cached under `runs.collectionBaseline(collectionId)` (`GET /runs?baseline=true&type=load&collectionId=&limit=1`), a segment of its own inside the same `baselines()` prefix, so no id can read as the other kind and every invalidation below reaches both.
Which key a run uses is `runIdentity(run)` (`lib/run-reference-input.ts`: `requestId`, else the scenario `collectionId`), and `usePinnedBaseline` and `RunComparisonView` look the pin up by the same identity.
Pinning, unpinning and deleting a run all **invalidate the `baselines()` prefix** rather than patching it: the pin moves, and a run id gives no way back to the request whose baseline it was - a run of an unsaved request has no `requestId` at all.
The pin *flag* on the loaded list rows is patched in place from the mutation's response, the same way a delete patches them, because the sidebar polls only its first page and a refetch would leave a pin invisible on any page the user had scrolled to.

`runs.requestRun(requestId)` caches the load runs of one request (`useRequestRunsQuery`: `GET /runs?requestId=&type=load&limit=50`, newest first), which the History compare view's run picker and the run trend read.
A collection load run's list is `runs.collectionRun(collectionId)` (`GET /runs?collectionId=&type=load&limit=50`), under the same `requestRuns()` prefix.
A plain `RunListResponse`, so its own family for the sixth time and the same shape reason as the five above it, and under the `requestRuns()` prefix that a delete, a pin, a cleared history (`useInvalidateRuns`) and an MCP `run` event all invalidate.
The query returns the rows whole: which are comparable (completed or stopped, never the open run) is `comparableRuns`'s rule, and the pinned baseline is added to the picker even when it is older than the page, because that is what a pin is for.

`specs.detail(id)` and `specs.meta(id)` are the same document under two keys (issue #712): the full read carries `content` and both extracted indexes, the meta read describes the row and nothing else.
They are kept apart rather than merged so a cached description can never satisfy a reader that needs the text - and holding one row twice is safe here precisely because a document is immutable, which is also why both carry `staleTime: Infinity`.
The Spec tab's card reads meta; the import dialog's bound-spec match and the Sync section's Check read the full document, each on the action that needs it.
Export reads neither since it moved engine-side (issue #855) - `specs.export(collectionId, format, opened)` holds the finished document instead, keyed by format because the dialog toggles between two serializations of one answer, and by the moment the dialog mounted because a *collection* changes under its id in a way a document never does:
that is what makes it fresh on every open and cached across a toggle, which neither `staleTime` alone can say.
A key per format also means a switch is a cache miss, so this read carries `placeholderData: keepPreviousData` (issue #1311): the counts the dialog prints belong to the collection rather than to the serialization, and are the same either way, so the previous answer is the honest thing to hold while the next one assembles.
The dialog gates Copy and Download on `isFetching` for that window - the text under them is still the previous format's - and shows a placeholder shaped like its summary card on the first read, when there is nothing to keep.

`exports.postman(collectionId, includeSecrets, opened)` is the same read for the Postman Collection v2.1 export (`usePostmanExportQuery` in `queries/exports.ts`), on the same terms: keyed by the dialog's one toggle and by the moment it mounted, with `placeholderData: keepPreviousData` so the summary stays while the other answer assembles.
It is not under `specs` because a Postman document reads no binding.

The run report export (`useRunReportExport` in `queries/exports.ts`, issue #2127) is a **mutation** and has no key: a click asks again, the answer is downloaded the moment it arrives, and its `generatedAt` makes every document a new one, so there is nothing a cache could serve.

`specs.match(collectionId, fingerprint)` is the third of that family and the one that names no document (issue #761): the pairing of a collection's requests against a picked document's operations, answered by `POST /specs/match` since the matcher moved engine-side.
There is no id to key it by - the document has not been stored, because the tab asks before the user commits to the bind - so the key carries a fingerprint of **both** inputs, exactly the fields the matcher reads off them (a request's id, method and URL; an operation's identity; the document's server base paths, issue #3030).
That is what makes its `staleTime: Infinity` honest: an answer cannot go stale while both inputs are pinned in its key, and either of them changing is a different key rather than a stale entry under this one.

**Automatic Invalidation:**
- Mutations automatically invalidate related queries (e.g., creating a request invalidates the collection's request list)
- Some mutations use optimistic updates and cache updates for instant UI feedback
- **A cascade delete invalidates coarsely, on purpose.**
  Deleting a collection deletes its descendant collections and all their requests *engine-side*, and which rows those are is engine-side knowledge - a client that re-derives the subtree to patch caches surgically will drift from the engine's definition of "descendant".
  So `useDeleteCollectionMutation` invalidates `collections.all` + `requests.all` wholesale.
  `requests.detail` entries carry `staleTime: Infinity`, so without this a deleted request stays fresh forever and keeps feeding restored tabs.
  `useRestoreTrashMutation` invalidates the same two families for the same reason, in the other direction: which rows a restore brought back is just as much engine-side knowledge - the cohort is defined by a timestamp the client never sees - so it takes the same wholesale invalidation rather than a client guess at which requests came back with a restored collection.
- **A single-request update invalidates narrowly, for the same reason.**
  Which lists a request write can affect *is* client-side knowledge: the request's own collection, plus the one it left if the write was a move.
  So `useUpdateRequestMutation` invalidates `requests.listByCollection(id)` per affected collection rather than `requests.lists()`.
  It used to refetch every collection's list on any rename, which a reorder (a run of sibling PUTs) turns into one full-tree refetch per row.
  The source collection of a move is read from the `requests.detail` cache, which still holds the pre-update row at that point - the response carries only the new owner.
- **The warm-cache prefetch is a query too.**
  `usePrefetchCollectionsAndRequests` is keyed as `queryKeys.prefetch.allRequests()` rather than an inline key, so a write that can change any collection's requests re-runs it as one call (`invalidateAllRequestLists`).
  Creating a collection does not: a new collection holds no requests, so its list is seeded empty instead (#2546).
- **...but warming a *polled* list must not be a query.**
  `usePrefetchRuns` is a one-shot `prefetchInfiniteQuery` on mount, not an observer, because `useRunsQuery` carries a `refetchInterval` and observing it from the root bought the warm cache at the price of a poll that never stopped (#1150).
  An invalidation of `runs.lists()` then marks the warm entry stale without refetching it, which is the wanted behaviour: nothing is displaying it.

**Writes from outside the renderer: `mcp:data-changed`.**
An MCP tool call mutates the engine from the Electron **main** process, so no mutation runs here and no query notices - and with `refetchOnWindowFocus: false` (below) nothing ever catches up on its own.
A request an agent created stayed invisible in the collection tree until some unrelated renderer mutation happened to invalidate the lists.
The main process now sends one event per data family a successful call touched; `useMcpDataInvalidation()` (registered once, in `App.tsx`) maps it to keys through `lib/mcp-invalidation.ts`:

| Entity | Invalidates | Why that key |
|--------|-------------|--------------|
| `collection` | `collections.all`, `requests.all`, `trash.all`, `mockServer.list()`, `compose.all`, `prefetch.allRequests()` | Declared by the writes that can reach any collection's requests: `delete_collection`, `move_item`, `import_document`, `bind_spec`, `sync_spec`, `restore_trash_entry` and `purge_trash_entry` (the two trash tools declare `request`, `environment` and `clientCertificate` too). A `delete_collection` cascades through descendants and their requests, and which rows those were is engine-side knowledge - the same reason `useDeleteCollectionMutation` invalidates coarsely. The event's `collectionId` is not read: each tool names a different collection by it (the one deleted, a move's destination, a spec's binder), and none changes that collection's list alone. `trash.all` because a delete is what *adds* a row the drawer lists and a restore or purge is what takes one away; `mockServer.list()` because the engine stops the mocks of a deleted collection and its descendants as part of the delete (#3449), so the Dock's and the Services drawer's running-mock list must refetch rather than show a mock that is gone; `compose.all` because a collection write moves the chain every descendant inherits auth, headers and scripts from, and this event carries no way to name them; `prefetch.allRequests()` ahead of `requests.all` (`invalidateAllRequestLists`), so the mounted lists join one `GET /requests` rather than each fetching (#1438) |
| `collectionRow` | `collections.all`, `compose.all` | Declared by `create_collection`, `update_collection` and `unbind_spec`, which write one collection row and nothing beneath it: a new collection holds no requests, an update cannot reach a trashed row, and an unbind leaves the requests' operation stamps in place. So no request list, trash row or warm-cache pass is read - an agent renaming 50 collections refetches the collections 50 times and the workspace's request lists not at all. The two reads are the ones `useUpdateCollectionMutation` refreshes (#2546) |
| `request` | `requests.listByCollection(collectionId)`, or `requests.lists()` when the call named no collection, `trash.all`, plus `requests.detail(requestId)` and `compose.allForRequest(requestId)` when the call named one row | The same narrowing `useUpdateRequestMutation` does; without a named owner the owner is unknowable here. The detail key is for `update_request` / `delete_request`: it is `staleTime: Infinity`, so a restored tab would otherwise keep serving the copy it read on open, and it is also the prefix the request's examples list sits under, so `delete_request_example` reaches an open Examples panel through it. `trash.all` because `delete_request` and `delete_request_example` (a saved example goes to the Trash since #2971) declare this family alone and stamp a row the drawer lists. The compose key is the per-request prefix, not `compose.all`: every tool that can change a composition either names the row it wrote or declares `collection` too, `create_request` composes nothing yet, and `invalidateQueries` refetches a *mounted* observer whatever its `staleTime` - so the wide key would re-compose an open snippet once per write in an agent's loop over rows it never touched. Every compose cell in this table is `invalidateCompositions`, the helper the renderer's own PUTs call. `prefetch.allRequests()` is deliberately **not** here for the same reason: it is one workspace-wide `GET /requests?fields=summary`, too costly to repeat per row, and this is the family an agent loops over row by row (#1438) |
| `environment` | `environments.all`, `globals.all`, `trash.all`, `compose.all` | Variables are read through the detail cache as well as the list; `POST /compose` substitutes those same variables, and a composition refetches only when told to, so `invalidateCompositions` is what `useUpdateEnvironmentMutation` and `useUpdateGlobalsMutation` call too (#1877). `globals.all` rides along because `update_globals` (#758) declares this family - same resolution order, same blob shape, and an entity of its own would have had exactly one reader. `trash.all` because `delete_environment` declares this family alone and, since #2970, stamps a row the drawer lists; `restore_trash_entry` and `purge_trash_entry` declare it beside `collection` and `request`, so a restored environment reappears in the Variables tree. An `update_environment` pays a refetch of the trash list while the drawer is open - the trade the `request` family takes |
| `run` | `runs.lists()`, `runs.count()`, `runs.baselines()`, `runs.requestRuns()`, `runs.recentDesigns()`, `runs.lastCollectionRuns()`, `runs.lastDesigns()` - and a **removal** of `runs.detail/report/samples/timeSeries/monitorSeries` for a named `runId` | The history list polls, but Settings' count, the vs-baseline strip, Recent sends, Last run and every open tab's last design run do not. The five prefixes rather than per-row keys because a run id gives no way back to the request or collection it belonged to - the same trade `useDeleteRunMutation` makes |
| `cookie` | `cookies.all` | One key for every jar - the engine reports them together |
| `config` | `config.all`, `requestDefaults.all` | `requestDefaults` is a second endpoint over the same entries rather than a slice of the first: five of them (`negotiateCompression`, `loadNegotiateCompression`, `sendExpectContinue`, `correlationIdEnabled`, `correlationIdHeader`) decide what a send adds on its own and the engine resolves the answer, so the declared set is re-read rather than derived here - which is why `useUpdateConfigMutation` drops both keys. At the root, because design and load are separate cache entries and one write can move both (#1438) |
| `service` | `inbox.list()`, `mockServer.list()`, `mockIssuer.list()`, plus a **removal** of `inbox.captures(inboxId)` for a named inbox and of `mockServer.routes(mockId)` for a named mock | The drawer and the Dock's count poll, so the lists are about immediacy; the captures cannot be invalidated, because `useInboxCapturesQuery` merges its fetched page into the cache and would union back the rows a `clear_inbox_captures` just destroyed, and a stopped mock's route table has no id left to refetch from |
| `clientCertificate` | `clientCertificates.all` | The registry the Settings card lists, which reads live entries only. No MCP tool writes it - an entry is added and removed by the user - so the only declarers are `restore_trash_entry` and `purge_trash_entry`: a restored certificate must reappear in an open card. Its own family rather than a fold into `config` (whose invalidator also refetches every config and request-default read) or `environment`; `trash.all` is not repeated because `collection`, declared beside it, already takes it (#2973) |
| `oauth` | `oauth.all` | The whole prefix, not the one key: `useOAuth2TokenStatusQuery` is keyed per cache key, and the key a `fetch_oauth2_token` writes under is derived engine-side and appears only in the answer, so the event carries no hint to narrow by. The query polls at 30s on its own, so this is immediacy - an agent that clears a token must not leave the row saying it is valid |
| `variables` | `environments.all`, `globals.all`, `collections.all`, `compose.all` | The design-mode runners (`run_request`, `run_collection_smoke`, `run_collection`) persist variables a script or extractor set, and the event cannot say which of environment, globals or collection moved. The first three are the reads the renderer's own Send invalidates after the same write; `compose.all` for the reason `environment` gives. Not the coarse `collection` family: a variable write changes no request row and adds nothing to Trash, so `requests.all`, `trash.all` and `prefetch.allRequests()` would only cost a refetch per send in an agent's loop (#1916) |

The event carries no engine data, only which family went stale, so a row still reaches the UI by exactly one path: the query layer.
Per-run reports and time series are still never invalidated *wholesale* - a new run cannot have changed an existing run's report, and those are the expensive fetches in the family.
They are dropped only for the one run a call named: `stop_run`, `set_run_baseline` and `delete_run` each take a `runId`, and the event carries it as a third scope hint.
Removal rather than invalidation, because `samples` and both series are `staleTime: Infinity` - a deleted run would otherwise go on rendering under an open History tab until its entry was garbage collected.
`runs.detail` goes with them so the pane refetches, takes its 404 and shows `HistoryDetail`'s "This run no longer exists" state instead of a run the sidebar no longer lists.
The hint says *which* run changed, not *how*, so a `set_run_baseline` costs an open detail pane one refetch of data it already had; a stale answer is a lie and a refetch is a wait.
`runs.lastDesigns()` is taken at its prefix and never per request (#776): `delete_run` and `set_run_baseline` name a `runId` and no request, so the narrow key could not reach the tab whose run went away, and the cost of the prefix is that a `run_request` refetches one filtered row per *mounted* tab instead of one.
The `service` family (issues #756, #757) takes the same shape one level down, with two scope hints instead of one.
`inboxId`: a named inbox has its capture list *removed* rather than invalidated for a reason the run family does not have - three writers share that one cache entry (the fetch, the load-more pages and the live SSE stream), so every write to it is a union by capture id, and a refetch into a cache still holding cleared rows puts them straight back.
The app's own clear mutation writes an empty page first for exactly this; from the main process the equivalent is to drop the entry.
`mockId`: a named mock has its route table removed for the mirror reason - the table is a start-time snapshot held at `staleTime: Infinity`, so an invalidation would not refetch it, and after a `stop_mock_server` there is nothing to refetch from, since a mock's record dies with its listener.
Both are what `useDeleteInboxMutation` and `useStopMockServerMutation` already do app-side.
All three lists are invalidated on every `service` event rather than one per kind, because the entity is deliberately one family: the drawer and the Dock's count ask "what is listening", not "which kind".
**One field on that event is not about the cache at all.**
`startedRun` rides the `run` event of `start_load_run` and `run_collection` and names the run those tools just created, plus which of the two run services owns its stream (`{runId, kind}`, issue #1419).
`useRunWatchers()` - registered once in `App.tsx`, beside `useMcpDataInvalidation()` - reads it and calls `loadTestService.startMonitoring` or `scenarioRunService.startMonitoring`, which is the same path the dashboard and the Run Collection dialog take, so the wake lock, the OS progress bar and the finished notification all begin when an agent's run does rather than when someone opens its tab.
A load run is adopted only while `canStartLoadRun()` allows a run to start (#3351, #3381), and so is a collection run.
While another run holds the stream the hook attaches nothing for either kind, leaving the dashboard, the stream and the user's run alone, and shows an info toast ("An agent started a run in the background and it will be in History when it finishes.") whose View run opens the agent's run; the run executes unwatched and its row converges on the runs poll.
Once adopted, it points `dashboard-store` at the run first, exactly as those surfaces do: `startMonitoring` states that its caller has registered the run, and a store left unpointed would collect the ticks of a run it does not name.
The event carries no config, so the hook then reads the run's row (`GET /runs/:id`) and hands its `configSnapshot` to `setRunConfig` (issue #1935): the mode, duration, rate, concurrency and ramp the dashboard's cards and the keep-awake prompt read, and the method and URL it shows, mapped by `lib/run-config-snapshot.ts`.
`setRunConfig` sets those two fields and nothing else - `startRun` would clear the ticks already gathered - and, being addressed to the run like every writer but `startRun`, it is dropped if another run has taken the dashboard by the time the row arrives.
A row that cannot be read is swallowed, never `streamLost`, which would raise the lost-stream callout over a stream that is fine; the dashboard then keeps its config-less look.
Every other `run` event names a run that already exists (a stop, a baseline change, a delete) and starts no watcher; `run_collection_smoke` sends its requests one at a time and has no run to watch at all.

The entity list is duplicated across the process boundary (`MCP_DATA_ENTITIES` in `electron/mcp/tools/contract.ts`, `McpDataEntity` in `types/domain.ts`) because production code under `electron/` cannot import from `app/src`; `data-changed.conformance.test.ts` is what keeps the copies equal, and the map above is a `Record` over the union so a new family fails to compile until it names a reader.
The emitting side is documented in [`docs/engine/mcp/`](../../engine/mcp/index.md).

**Writes from any client: the engine's change feed.**
`mcp:data-changed` covers only the MCP server the app itself hosts.
The stdio MCP CLI, `vayu-cli`, a script against the engine API and a second window write the same rows with no channel to this renderer, so an open request kept the version it had read until a reload, and Send sent it (#3420).
The engine publishes one event per committed write of a collection, a request, an example, an environment,
the globals or a trash entry on `GET /changes` (see [the API reference](../../engine/api-reference/changes.md#change-feed)), and `services/change-feed-service.ts` holds that stream for the app's life; `useChangeFeed()`, beside `useMcpDataInvalidation()` in `App.tsx`, opens it while the engine store says `connected` and closes it otherwise.
`lib/change-feed-invalidation.ts` maps each event onto the families in the table above, so there is one key table for both producers:

| Kind | Families | Why |
|------|----------|-----|
| `collection` | `collectionRow` for a `create` or `update`; `collection` for every other op, one this build does not know included | A delete, restore or purge is one event on the root for the whole subtree, which is the cascade `collection` takes coarsely |
| `request` | `request`, with the event's `collectionId` and the request's id, once more with the collection the cache still holds it in when that differs | A move's event names only the destination; the source is read from the request's detail entry, then the tree's lists, when the event arrives (`ownerOfRequest`). An owner the cache never saw is in no list on screen |
| `example` | `request` named by the example's `requestId`, narrowed the same way | What the MCP example tools declare: the Examples list sits under the request's detail key, and the family takes the Trash list |
| `environment`, `globals` | `environment` | Globals ride on the environment family (#758) |
| `clientCertificate` | `clientCertificate`, and `trash.all` | The feed carries only a certificate's delete, restore and purge, and no MCP tool declares this family alone, so its invalidator leaves the Trash list to `collection`; here nothing else would refetch it |

A kind this build does not know is passed over (its id still moves the resume point), and so is a frame that does not parse.
A `reset` (a resume the engine's ring no longer covers, an id from an engine process that has since restarted, or a reader that fell a whole ring behind) invalidates `collection`, `environment` and `clientCertificate` together, which between them reach every read a single event can.
A resume's `ready` invalidates nothing, because the missed events follow it.
A fresh subscription's `ready` (the first stream of the app's life, opened with no resume point) follows the launch's reads, so a write another client committed between the two is never reported;
it re-reads what the open tabs show instead (`invalidateOpenRows`): `requests.details()` and `compose.all`, the two `staleTime: Infinity` reads a restored tab and Send depend on, and `collections.lists()`, `environments.all` and `globals.all`, what an open collection or environment tab reads.
Each is one call, and only an observed entry is refetched; the rest are marked stale for their next mount.
The request lists are left alone: the workspace-wide `GET /requests` is the launch's heaviest call, and the tree reads a name and a method from it, never what Send sends.

**The feed reports the app's own writes too, so invalidations are coalesced and held.**
`FeedInvalidationBatch` collects a burst into one invalidation per family and collection over `CHANGE_FEED_COALESCE_MS` (200ms), fixed from the first event rather than restarted by each.
A request event contributes a collection-scoped `request` family, which carries no row id and so dedupes (one list read and one Trash read per collection however many rows a reorder wrote, #3448), plus the row's own detail and compositions, which are never coalesced away.
So a bulk import is one flush and a client writing without pause is still shown every 200ms.
A flush waits while `queryClient.isMutating()` is above zero: the autosave PUT's echo then refetches after the PUT's own answer is in the detail cache, where structural sharing makes the refetch a no-op for the open tab, and an event arriving while a reorder is in flight cannot refetch the lists from under the drop's optimistic draw.
The wait is bounded by `CHANGE_FEED_MUTATION_HOLD_MAX_MS` (5s): those two writes are one local round trip, so a mutation still pending past it is a hung or long one (an import, a spec sync, an OAuth sign-in), and the batch, a `reset` included, lands anyway rather than waiting for it.
The in-app MCP channel stays a second producer for the in-app server's writes, so those are invalidated twice; an invalidation twice over is a refetch, never a wrong answer.

The stream is the inbox stream's shape: every drop is closed and reconnected on the service's own backoff (`CHANGE_FEED_RETRY_BASE_MS` doubling to `CHANGE_FEED_RETRY_MAX_MS`, 15s, which is the `Retry-After` the engine sends with `503 change_feed_full`; an `EventSource` cannot read the status or the header), resuming by `?lastEventId=` from the last id seen.
Each connection, a reconnect included, first asks `POST /changes/subscriptions` for a single-use id and opens `GET /changes?subscription=<id>`: the engine takes a stream slot only on such an id, so a web page cannot hold every slot and leave the app's stream refused; a failed request for the id is retried on the same backoff, and a `stop()` while one is in flight drops it on arrival.
It never gives up, since nothing renders a stopped feed; the engine-status gate is what stops it asking a downed engine.

An open request reaches the merge (#1436) through its detail key: a refetch delivers a new `fetchedRequest`, and the builder adopts the fields the user has not touched and keeps a touched one, with the incoming value in `fieldConflicts` (`RequestBuilder.change-feed.test.tsx`).

**Retry policy:** the shared default is `shouldRetryQuery` (`lib/query-client.ts`), not a bare count.
A 4xx from the engine is a verdict, not a hiccup - a 404 for a deleted row answers identically every time, so retrying it only delays the error the caller is waiting on. 4xx is never retried; everything else (5xx, timeout, unreachable engine - which `http-client.ts` throws as an `EngineUnreachableError`, not an `ApiError`) keeps the `DEFAULT_QUERY_RETRY` budget.
The one exception is an engine that is still starting: while `engineStartWindow` is open, an `EngineUnreachableError` is retried without counting against the budget, every `ENGINE_START_RETRY_DELAY_MS` (`queryRetryDelay`), so a launch shows loading rather than error panes until the engine answers or the window expires (`docs/app/api-integration.md`, Health Checking).

**Cache policy lives in `config/cache.ts` (`QUERY_CACHE`), not in the call sites.**
Name the constant when you need a duration; restating the number here is how this section drifted before.
The current shape:

| Query | Policy |
|-------|--------|
| Collections, requests lists, environments, globals, runs list | `DEFAULT_STALE_TIME_MS` (30s) via the shared client |
| Request detail (`requestDetailOptions`) | `staleTime: Infinity` - a restored tab reads it once; its own mutations and the change feed (a write by any other client) invalidate it |
| Run detail, run report | `RUNS_STALE_TIME_MS` (5m); completed runs are immutable. While the run's status is `running` or `pending` the detail polls every 3s, and a report given that status is `staleTime: 0` and polls too (#1934) |
| Run time series (downsampled, one request) | `staleTime: Infinity`, `RUN_SERIES_GC_TIME_MS` (1m); `staleTime: 0` when given an in-progress status. Invalidated by `LoadTestService` when the run ends |
| Run monitor series (downsampled, one request) | `staleTime: Infinity`, `RUN_SERIES_GC_TIME_MS` (1m); `staleTime: 0` when given an in-progress status. Invalidated by `LoadTestService` when the run ends |
| Engine config | `CONFIG_STALE_TIME_MS` (1m) |
| Script completions | `SCRIPT_COMPLETIONS_STALE_TIME_MS` (1h), same gc time |
| Health | `staleTime: 0`, refetched every `TIMING.HEALTH_CHECK_INTERVAL_MS` (30s) |

Polling intervals are separate from staleness: the runs list polls every 5s **only while unpaged** (`runsPollInterval`), health polls on `TIMING.HEALTH_CHECK_INTERVAL_MS`, and the shared client sets `refetchOnWindowFocus: false` - a desktop app that refetched everything on focus would fight the editor the user just came back to.
