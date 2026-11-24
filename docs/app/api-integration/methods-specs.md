---
description: >-
  The API service's methods for stored API specs: store, match, diff, bind, export and sync.
---

# API methods: specs

## Specs

```typescript
apiService.createSpec(data): Promise<SpecDocument>       // POST /specs
apiService.getSpec(id): Promise<SpecDocument>            // GET  /specs/:id
apiService.getSpecMeta(id): Promise<SpecDocumentMeta>    // GET  /specs/:id/meta
apiService.syncSpec(payload): Promise<SpecSyncResponse>  // POST /specs/sync
apiService.describeSpec(payload)                         // POST /specs/describe
apiService.matchSpecOperations(payload)                  // POST /specs/match
apiService.diffSpec(payload): Promise<SpecDiffResponse>  // POST /specs/diff
apiService.bindSpec(payload): Promise<SpecBindResponse>  // POST /specs/bind
apiService.exportSpec(payload): Promise<SpecExportResponse> // POST /specs/export
apiService.exportPostman(payload): Promise<PostmanExportResponse> // POST /export/postman
apiService.exportPostmanEnvironment(payload): Promise<PostmanEnvironmentExportResponse> // POST /export/postman-environment
apiService.exportRunReport(payload): Promise<RunReportExportResponse> // POST /export/run-report
```

`describeSpec` is the read that replaced the last parse this app did of a spec document (issue #869).
It sends the picked bytes and gets back what they are - the dialect (`"OpenAPI 3.1"`, `"OpenAPI 3.0"`, `"OpenAPI 2.0 (Swagger)"`), `info.title`, and the identities the document declares, and the `basePaths` its server URLs name - and the Spec tab paints its card from that and hands the identities and the base paths to `matchSpecOperations`.
It parsed the file itself until then, with `services/openapi/spec-operations.ts`, while the bind derived the same identities engine-side from the same bytes: two readers of one document, which could preview one pairing and commit another.
A document that is not a contract, or that will not read at all, is a `400`, and the tab prints the engine's sentence.

`matchSpecOperations` is a **read** (issue #761): it pairs the requests in a collection's subtree with the operations a document declares and writes nothing, which is what lets the Spec tab show the counts before the user commits to a bind.
The pairing rule lives in the engine (`core/operation_match.hpp`) rather than in the renderer, so binding an existing collection is reachable from anything that is not the Spec tab - an agent over MCP first among them.
The payload names the collection and sends the operations and the `basePaths` `describeSpec` answered (issue #3030); it does **not** send the requests, because an OpenAPI import files them under tag sub-collections and the engine gathers the whole subtree itself.
The base paths are relayed rather than left for the engine to guess because they are what lets a request written as a literal URL (`https://h/v1/pets`) pair with the document's `/pets`: the bind derives them from the document it stores, so a preview that omitted them would show fewer matches than the bind stamps.

`exportSpec` is a read for the same reason and sends even less (issue #855): a collection id, a format, and - for a bound collection - the mode the user chose (`contract` or `full`).
The engine reads the subtree, each request's stored examples and the bound document - which is the point, since a bound export *patches* those stored bytes - and answers with the finished text, a file name and the notes the dialog prints.
A `409` there is a binding whose document is not stored, or stored bytes that will not read as OpenAPI; the renderer prints the engine's sentence rather than falling back to a skeleton.

`exportPostman` is the same kind of read for the other way out: a collection id and `includeSecrets` (default `false`, which writes auth secrets, secret variables and, by name, the credentials in headers, parameters, URLs, saved examples and cookie values empty, and counts them in `notes.secretsOmitted`; bodies and scripts are not judged).
The answer is the Postman Collection v2.1 text, a `<name>.postman_collection.json` file name, and notes with the request and folder counts plus `notCarried` - one entry per kind of thing Postman has no place for, each with a count and the engine's sentence, which the dialog prints as written.

`exportPostmanEnvironment` is the same read for one environment (issue #2253): an environment id and `includeSecrets` (default `false`, which keeps each secret variable's row and name and writes its value `""`, counted in `notes.secretsOmitted`).
The answer is the Postman environment text, a `<name>.postman_environment.json` file name and notes with `variablesExported` plus `notCarried`, whose one kind is `variable_types`: `json`-typed variables, which Postman has no type for, written as `default`, and typed secrets, whose type gives way to `secret` (#3252).
The renderer's only caller is the environment row's **Export as Postman environment** item, which sends the id alone, saves `text` as `fileName` and, once the file is written, puts `secretsOmitted` and the `variable_types` count in the toast (`modules/variables/sidebar/postman-environment-export.ts`).

`exportRunReport` is the same kind of read for a finished load run (issue #2127).
`RunReportExportRequest` is `{runId, format?, series?, baseRunId?}`: `format` is `"json"` (the default), `"markdown"` or `"html"`, `series` is `"full"` (the default, every tick of the time series) or `"none"` (which `html` ignores: its charts need the series), and `baseRunId` names a second finished load run, which fills the document's `comparison`.
The answer, `RunReportExportResponse`, is `{text, fileName, mimeType, notes}`:
the document (schema `docs/engine/run-export.schema.json`, built by allowlist so no trace, sample, header value or body is in it; for `"markdown"`, its plain GFM rendering; for `"html"`, one self-contained page with the charts),
`<title> <UTC start, YYYY-MM-DD HHmm>.run.json` (`.run.md`, `.run.html`), `application/json` (`text/markdown`, `text/html`), and `notes.urlCredentialsOmitted`, the count of values the URL lost.
A missing run or base is a `404`, a run still executing a `409 run_in_progress`, a design or collection-sequence run a `400 unsupported_run_type` ([API reference](../../engine/api-reference/export.md#post-exportrun-report)).
`useRunReportExport` (`queries/exports.ts`) is its mutation, and `EngineClient.exportRunReport` the MCP server's call.

**Neither index is sent on any write that stores a document** - not by `createSpec`, `syncSpec` or the `specs` section of `importCollection` below.
The engine reads the document it is storing and derives the `operations` index (#629, moved by #853) and the `responseSchemas` index (#628, moved by #860) from those very bytes, so sending either is a `400`, the way a supplied `hash` is; a sync that forgets one can no longer turn coverage or response validation off for a collection that had it.
The renderer stamps no identity of its own any more either (issue #877): an import is parsed by the same reader, so the identity on a request and the identity in the index come off one walk rather than two that had to be pinned to each other.

Create and read-by-id only, plus the two writes that move a binding.
`syncSpec` is one (issue #655): it stores the re-fetched document, points the collection at it and applies the created, updated and deleted requests in a single engine transaction, because a sync that stopped halfway would leave a collection bound to a document its requests do not reflect.
The renderer decides *what* to send (`services/openapi/spec-apply.ts`) and never sequences the writes itself.

`diffSpec` is the read that the Sync section's **Check** is (issue #854).
It sends the collection and the re-fetched bytes and nothing else: the engine walks the collection's subtree itself and reads the bound document from the binding, because the three-way `userTouched` flag - the request holds neither the new document's value nor the bound one's - is worth nothing if a caller can supply the previous side.
It writes nothing, and the answer carries, per entry, the draft an apply would write, so `spec-apply.ts` builds a `POST /specs/sync` payload out of it without reading a document at all.
The comparison is the engine's; the app has no `services/openapi/spec-diff.ts`.

Each entry also carries **what a sync with no ticks would do to it** - `safe`, and `safeFields` on a changed request (issue #871).
`defaultSelection` reads those rather than deriving them from `userTouched`, because the rules behind them are the ones whose silent failure destroys a person's work and they now have one author: `core::safe_spec_apply`, which `POST /specs/sync`'s `policy: "safe"` applies for a caller that states no rows at all.
`syncSpec` still sends explicit rows from here, since the ticks a person changed are not a policy.

The diff's **`declined`** bucket (issue #3031) lists operations whose request the user deleted: entries shaped like `added`'s, `safe` always `false`.
It is separate so nothing pre-ticks it.
`SpecApplySelection.declined` starts empty whatever `safe` says, and a tick goes out as an ordinary `create[]` item built by the same `draftOf` / `createItem` path as an added operation, carrying `specOperation`.
No flag marks it a revival: the engine sees a create naming a declined operation and clears the record in the same transaction.
A `policy: "safe"` response's `skipped` counts what it left as `declined`.

The one field of that draft `spec-apply.ts` does **not** send back is `examples` (issue #869): an update carries `examples: true` - refresh this request's imported examples - and the engine writes the responses the document it is storing documents.
A created request states none at all, for the same reason.
Echoing the rows back was a round trip through the client of an answer the engine had already given, and it let a payload state an example for a response no document describes.

`bindSpec` is the other (issue #862), and it decides even less: the payload is a collection and a document, with **no pairing in it**.
Three calls made in order from `useBindSpecMutation` - store the document, move the binding, then stamp the matched requests and clear the stale ones - would make both halves defects waiting to happen: three writes are three places to stop, and the clearing half is a list a caller can forget (issue #718).
`POST /specs/bind` commits all of it or none of it and works the pairing out from the bytes it stores.
`matchSpecOperations` above is still what the Spec tab previews with; it is not a payload for this call, and the bind matches again over the same rule.

A document is immutable - a changed spec is a new document and a moved binding, which is what keeps a run's `specHash` stamp meaningful - and the **hash is computed engine-side** on the bytes it stored, never here.
There is no delete call: unbinding is a `PUT /collections/:id`, and the document stays for whatever else binds it.
Both reads are cached with `staleTime: Infinity`, because the row behind a given id cannot change.

**Describing a document and reading one are two calls** (issue #712).
`getSpecMeta` answers `sourceUrl`, `fetchedAt`, `hash` and `contentBytes` and nothing else; `getSpec` sends `content` and both extracted indexes with it - up to `maxSpecDocumentBytes`, which is 12 MB for Stripe's published spec.
The rule for choosing is what the caller does with the answer:

| Caller | Read | Why |
|--------|------|-----|
| The Spec tab's card (`useSpecMetaQuery`) | meta | It paints a source, a date and a size; it never renders the document |
| The Sync section's Check (`useSpecMetaReader`) | meta, on the click | Since #854 it needs only `sourceUrl` - where to re-fetch from - because the engine compares its own stored bytes |
| The import dialog's bound-spec match (`useBoundSpecReader`) | full, on the action | It compares the document itself |

Export needs neither read any more (issue #855): `POST /specs/export` assembles the document engine-side from the bytes it already stores, so the renderer asks for the finished text and never for the spec.

Reading the full document *on tab open* is the thing this split removed: a first open of a bound tab transferred the whole spec to paint two fields, on a query that then sat in cache forever.
A reader that needs the text still asks for it - on the action that needs it, where the wait is something the user started.
