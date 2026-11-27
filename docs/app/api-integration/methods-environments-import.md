---
description: >-
  The API service's methods for environments, global variables and importing a document.
---

# API methods: environments, globals and import

## Environments

```typescript
apiService.listEnvironments(): Promise<Environment[]>
apiService.getEnvironment(id): Promise<Environment>
apiService.createEnvironment(data): Promise<Environment> // POST /environments
apiService.updateEnvironment(data): Promise<Environment> // PUT  /environments/:id
apiService.deleteEnvironment(id): Promise<void>         // DELETE /environments/:id
```

`deleteEnvironment` is a soft delete (#2970): the engine moves the environment to the Trash and clears its active flag in the same write, and every environment read stops returning it.
`restoreTrashEntry` (above) brings it back, inactive.

## Global Variables

```typescript
apiService.getGlobals(): Promise<GlobalVariables>
apiService.updateGlobals(variables): Promise<GlobalVariables>
```

## Import

```typescript
apiService.importFetch(url, maxBytes?, onProgress?, signal?, options?): Promise<ImportFetchResponse> // POST /import/fetch
apiService.applyImport(payload): Promise<ImportApplyResponse>      // POST /import/apply
apiService.importMcp(payload, { signal? }): Promise<ImportResult>  // POST /import/mcp
```

`importFetch`'s `maxBytes` is the largest response that fetch may read.
The engine has no format to derive one from - the route proxies Postman and Insomnia exports as well as OpenAPI documents - so the caller states it: the spec paths (`$ref` bundling, spec re-fetch, the Spec tab's URL box) pass the live `maxSpecDocumentBytes` from `useSpecDocumentLimit`, and the format-agnostic import URL box passes nothing, leaving the engine's transport ceiling.
Over the bound is a `413` whose message names it, raised while the body is arriving rather than after it has been buffered whole.

`importFetch`'s third argument is what asks the engine to **stream** the download (issue [#882](https://github.com/athrvk/vayu/issues/882)): with an `onProgress` callback the call goes through `httpClient.stream`, which sends `Accept: text/event-stream` and reports `{received, total}` as the bytes land - `total` being null whenever the upstream declared no `Content-Length`.
Without it this is the buffered POST it has always been, which is what `$ref` bundling and spec re-fetch want: they have nowhere to draw a bar and no reason to pay for a stream.

Two things `httpClient.stream` does that `request` cannot.
Its timeout is an **idle** one, so a 10 MB document arriving steadily is no longer racing the budget - what is bounded is the stall, not the transfer.
And a response that comes back as buffered JSON yields one `buffered` message instead of failing, because the app and the engine sidecar are not updated together and an older engine answers this request the way it always has.

`importFetch` takes a fourth argument, an `AbortSignal`, and it is what actually stops a download (issue [#893](https://github.com/athrvk/vayu/issues/893)).
Abandoning the iteration releases the stream, but a caller that is not itself iterating - a dialog closing while `importFetch` sits in the loop on its behalf - has no way to reach that, so 0.22.0 shipped a transport that could cancel and a dialog that never asked it to.
An abort raises an `AbortError`, deliberately distinct from the idle stall's `Request timeout`: both end in an `AbortController`, and a deliberate cancel reported as a timeout is an error banner about a failure nobody had.

Both forms of `importFetch` budget the call from the engine's fixed stall,
not from the `defaultTimeout` setting (issue [#2836](https://github.com/athrvk/vayu/issues/2836)): the engine abandons a fetch after `IMPORT_FETCH_STALL_TIMEOUT_MS` (30 s, mirrored from `constants::import_fetch::STALL_TIMEOUT_MS` and pinned by `import.engine-parity.test.ts`) of near-silence whatever the setting says, so the client arms that plus the 10 s grace (40 s).
The buffered form's 40 s is a total, so a steady download slower than that still aborts client-side while the engine keeps reading; closing that needs a progress-aware timer, which the buffered callers (`$ref` bundling, spec re-fetch) have no stream to feed.

`importFetch`'s fifth argument, `options: ImportFetchOptions`,
marks the fetch as a `$ref` a document asked for rather than a URL a person typed (issue [#2364](https://github.com/athrvk/vayu/issues/2364)):
`{ reference: true, sourceUrl? }` adds those two fields to the body of both the buffered and the streamed form, and the engine then follows no redirect and refuses a loopback or link-local peer other than the source's own host and port (see [POST /import/fetch](../../engine/api-reference/import.md#post-importfetch)).
Only `ref-bundler` sets it, with `sourceUrl` the URL of the document the ref was found in (the intermediate document for a nested ref) and absent for a picked or pasted document, whose references can then reach no local peer.
Without it the body is exactly `{url}` or `{url, maxBytes}`: the import dialog's URL box, the Spec tab's URL box and a spec re-fetch's own document are the user's URLs and stay that way.
Every layer between the bundler and `importFetch` (`ExternalRefIntake.fetchUrl`, `BatchIntake.fetchUrl`, `SpecRefetchIo.fetchUrl`) forwards the options as its second argument, and TypeScript will not flag a wrapper that drops it.

`applyImport` sends a whole parsed import - collections, requests, environments and **spec documents** - in one atomic call.
Items reference each other by opaque `tempId`s and the engine returns the temp-id -> real-id `idMap`; a rejected payload persisted nothing, so there is nothing to roll back.
An OpenAPI import puts the document in the `specs` section and binds its root collection with `openapi.specTempId`, so the spec, the binding and every request's `specOperation` land in the same transaction - `specs: []` is sent for every other format rather than omitted, so the payload is one shape.
Imported **globals** are not in this payload: they are a singleton written through `updateGlobals` after the apply succeeds.
`importMcp` asks a live MCP server what it offers and answers the tree `parseImport` answers, for the Import dialog's MCP server tab ([mcp-server.md](../import-collections/mcp-server.md)).
The engine makes several calls to the server, so the budget is the engine's 120 s whole-import bound (`IMPORT_MCP_TOTAL_TIMEOUT_MS`, mirrored from `constants::import_mcp::TOTAL_TIMEOUT_MS` and pinned by `import.engine-parity.test.ts`) plus the transport grace, not the `defaultTimeout` setting.
The optional `signal` cancels the wait and raises an `AbortError`; the engine keeps talking to the server until its own bound, but nothing acts on the answer.

See [import-collections/README.md](.././import-collections/README.md#3-persist---orchestratorts) for the pipeline and [engine/api-reference/import.md](../../engine/api-reference/import.md#post-importapply) for the contract.
