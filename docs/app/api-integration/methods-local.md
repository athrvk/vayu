---
description: >-
  The API service's methods for health and configuration, the cookie jar, allowed folders, the webhook inbox, the mock issuer and the collection mock server.
---

# API methods: configuration and local services

## API Methods

### Health & Configuration

```typescript
apiService.getHealth(): Promise<EngineHealth>
apiService.getConfig(): Promise<EngineConfig>
apiService.updateConfig(config): Promise<EngineConfig>
apiService.getRequestDefaults(scope?: RequestDefaultsScope): Promise<RequestDefaults>
```

`getRequestDefaults` reads what the engine will add to a request that names none of it (issue #1229) - a `User-Agent`, a negotiated `Accept-Encoding`, an opt-in correlation id, and an `Expect: 100-continue` row while `sendExpectContinue` is on (issue #2468) - as `{headers: [{name, value?, generated, configKey?}]}`.
A row with `generated: true` carries no `value`: it is made fresh per transfer.
The set is **read, never derived**: the engine resolves it (its libcurl decides which encodings can even be asked for), so a renderer working it out from the config entries would be a second definition of the same rule.
The Headers tab renders it as the read-only "Added by Vayu" group, and a row ticked off there rides the send as `disabledDefaultHeaders`, which `POST /execute` and `POST /runs` both take.
None of it is persisted on the request.
The engine also leaves libcurl no default of its own to fill (issue #2464).

What the transport adds on its own (`Host`, `Accept`, `Content-Length`, the `Cookie` the jar matched) is not part of that set and not part of `requestHeaders`: it exists only on the wire.
The response's Headers tab lists the request as it was sent, taken from the engine's recorded raw request when it has one: one read-only, collapsed "Request headers" table holding every line of the `rawRequest` header block in wire order, the author's rows and the transport's alike, and a repeated name as separate rows.
The renderer reads it off that block and carries it as `ResponseState.wireRequestHeaders`, set by `responseFromExecuteResult` and `responseFromRunResult` alike.
It is a display of what went out: nothing in it is sent, stored on the request or visible to `pm.request.headers`.
A restored row with no recorded frame lists `requestHeaderLines` instead, because the Raw tab's fallback frame is fabricated from the composed request, and so does a send that failed, whose frame the engine may have synthesized because nothing was sent.
`requestHeaderLines` is the request's own lines as the transfer sent them (issue #2466): the answer's `requestHeaderLines`, or a stored trace's `request.sentHeaderLines`, in wire order, a repeated name repeated and each in the spelling typed.
`requestHeaders` beside it is the same set folded to one value per name (a repeat joined with `", "`, `Cookie` with `"; "`) and is what the section falls back to only for an answer from before the lines existed.
Both funnels set it, an empty list reading as absent in each.

The *stored* counterpart is a different field (issue #1765): `disabledSystemHeaders`, Postman's per-request list, kept on the request as lowercased names and edited in the **Settings** tab's "Don't send automatic headers" list.
The engine unions the two at send time, so the Headers tab shows a name stored there as off (disabled, "off for this request in Settings") rather than offering a tick that could not turn it back on.

`scope` (issue #1338) selects which send is being asked about: `"design"` (the default, and the Headers tab's own answer) or `"load"`.
The two can disagree - `negotiateCompression` governs a design send's `Accept-Encoding` and `loadNegotiateCompression` governs a load run's - so the load-test dialog reads both and names the difference rather than starting a run whose headers silently do not match what the tab just showed.
`sendExpectContinue` is one key for both scopes, so it never makes them disagree.

### Cookie jar

```typescript
apiService.getCookies(): Promise<GetCookiesResponse>
apiService.clearCookies(scope?: { environmentId: string | null }): Promise<ClearCookiesResponse>
```

The engine keeps one cookie jar per environment for design-mode requests (issue #301); `CookiesCard` in Settings → General shows and clears them.

### Allowed folders

```typescript
apiService.getFileRoots(): Promise<FileRoot[]>                 // GET /file-roots, a bare array
apiService.allowChosenFolder(): Promise<AllowFolderReply>     // picker in main, then POST /file-roots
apiService.deleteFileRoot(id: string): Promise<void>           // main's DELETE /file-roots/:id
```

The folders a request-body file may be sent from without a per-file pick - the second half of the trust rule under [Request bodies](http-client-and-service.md#request-bodies).
Only the list is an engine call from the renderer.
Both writes need the engine's grant secret ([who may call the API](../../engine/api-reference/index.md#who-may-call-the-api)), which only the main process holds, so they cross the Electron bridge (#2356):

| `electronAPI` method | Channel | What main does |
|---|---|---|
| `allowFolder(key)` | `file:allowFolder` | Opens the system folder picker, then `POST /file-roots` with the folder the user chose and the secret. The renderer names the dialog by key (`"allow-folder"`, `FOLDER_DIALOG_TITLES` in `electron/file-ipc.ts`) and nothing else: the title is main's, the picker opens where the last one ended in this process (the first call, none), and an unknown or non-string key rejects (#2378). |
| `removeAllowedFolder(id)` | `file:removeAllowedFolder` | `DELETE /file-roots/:id` with the secret, for an id shaped like one the engine mints. |

Both answer only the app window's main frame (`electron/ipc-sender.ts`) and resolve with the engine's answer rather than throwing it away at the process boundary: `{outcome: "done", value}`, `{outcome: "refused", status, code, message}` or `{outcome: "unreachable", message}`, and for `allowFolder` also `{outcome: "cancelled"}`, with the chosen folder as `path` on every other outcome.
The row is stored canonical, so it can differ from the folder picked.
`useAllowFolder` (`hooks/useAllowFolder.ts`) is the one caller that interprets an add, for Settings > Files (`FilesPanel`), the binary body editor and the import preview, and it treats a `409` (already allowed) as success; `deleteFileRoot` turns a refusal back into an `ApiError`.
Outside Electron neither write exists, and the surfaces offer no way to add one.

**A picked file is recorded by main, not sent by the renderer.**
When the preload's `getFilePath(file)` gets a path from `webUtils.getPathForFile`, it also reports it on an internal channel, `file:picked`, that no `electronAPI` method exposes; main checks the sender is the app window's main frame and the value an absolute path, then records it with `POST /file-grants` and the secret (`electron/file-grants.ts`).
A document the OS hands the app (`open-intent.ts`) is recorded the same way.
The report is one-way, so the renderer cannot wait for it: a pick followed by a send within the same few milliseconds can reach the engine first.

### Webhook inbox

```typescript
apiService.listInboxes(): Promise<Inbox[]>
apiService.startInbox(request?: StartInboxRequest): Promise<Inbox>
apiService.stopInbox(inboxId): Promise<Inbox>
apiService.deleteInbox(inboxId): Promise<DeleteInboxResponse>
apiService.updateInboxResponse(inboxId, response: Partial<InboxCannedResponse>): Promise<Inbox>
apiService.listInboxCaptures(inboxId, limit?, offset?): Promise<InboxCapturesResponse>
apiService.clearInboxCaptures(inboxId): Promise<ClearInboxCapturesResponse>
```

An inbox records the requests sent to it and answers a canned response (issue #480); `modules/inbox/` is the surface.
`updateInboxResponse` is a merge-patch - an omitted field keeps what the inbox is serving - and the live capture stream (`INBOX_LIVE`) is a plain `EventSource` rather than `SSEClient`, which maps load-test metrics specifically.
Captures arriving on that stream are merged into the `listInboxCaptures` cache, so there is one list.
`InboxCapture.bodyEncoding` is `"base64"` when the stored bytes are not valid UTF-8 (issue #3109): `body` is then the base64 of the stored prefix, and `bodyBytes` is the size as received.
`parseCaptureEvent` reads the marker off the stream the same way the list route carries it, because a payload that dropped it would show the base64 as the body's text.
`deleteInbox` is the stronger of the two lifecycle calls: `stopInbox` frees the listener and leaves the record and its captures readable for the life of the engine process, while a delete takes both (issue #553).
Its mutation *removes* the captures cache entry rather than invalidating it - an invalidation would refetch an id the engine now `404`s.
`Inbox.captureCount` is what a delete would destroy, and is what the confirmation is worded from.
`StartInboxRequest.allowedOrigins` (issue #2367) is the optional CORS policy: absent is the any-origin default, and the one-click start still sends `{}`.
Only the options dialog beside Start (`modules/inbox/InboxStartOptions`) sends a list, parsed and checked by the same `lib/allowed-origins.ts` the mock's form uses; the engine echoes the canonical list as `Inbox.allowedOrigins`, which the inbox tab's header and the Services drawer row read.
It is fixed for the inbox's life.
`clearCookies` distinguishes three cases the way the engine does, and they are not interchangeable: **omitted** clears every jar, `{ environmentId: null }` clears only the jar used when no environment is selected, and an id clears that environment's.
It reaches `DELETE /cookies` with the parameter absent, present and empty, or present with the id, respectively.

### OAuth 2.0 mock issuer

```typescript
apiService.listMockIssuers(): Promise<MockIssuer[]>
apiService.startMockIssuer(request?: StartMockIssuerRequest): Promise<StartMockIssuerResponse>
apiService.updateMockIssuer(issuerId, update: UpdateMockIssuerRequest): Promise<MockIssuer>
apiService.stopMockIssuer(issuerId): Promise<StopMockIssuerResponse>
```

A local issuer that mints HS256 tokens on demand (issue #479); the Services drawer (`modules/services/`) is the surface, added in #502 - before it these routes had no client but curl and the MCP tools.
Two asymmetries the surface has to respect: `startMockIssuer` answers with the URLs and the signing key **only**, not the full record, so the list is refetched rather than patched; and a stopped issuer leaves the list altogether, unlike an inbox, which stays listed with `running: false`.
`updateMockIssuer` accepts only `expiresInSeconds`, `failureMode` and `slowMs` - a port, client list, claim set or `resourceScope` cannot move under a bound listener and the engine refuses one with a `400` rather than half-applying it.

The start answer and each list entry carry `metadataUrl` (the RFC 8414 document) and `discoverUrl` (`<issuerUrl>/resource`, a protected resource whose `401` leads to that metadata).
**`discoverUrl` is what to paste into an OAuth config's "Discover from the server URL" field**: sign-in then finds the authorize, token and registration endpoints itself, so no endpoint is typed.
The Services drawer's expanded issuer row shows it (Discover) beside the metadata URL, each with its own copy button.
`failureMode` is `none`, `slow`, `server_error`, `invalid_client` (all `/token` only), `metadata_not_found` (the RFC 8414 document answers `404`), `registration_refused` (`/register` answers `400`) or `wrong_iss` (the authorize redirect carries a wrong `iss`, which a discovered sign-in refuses).
`StartMockIssuerRequest.resourceScope` is the space-separated scope `/resource` requires of a token; the start dialog sends it only when filled in and shows the engine's `400` when the scope is not valid.

### Collection mock server

```typescript
apiService.listMockServers(): Promise<MockServer[]>
apiService.startMockServer(request: StartMockServerRequest): Promise<MockServer>
apiService.stopMockServer(mockId): Promise<StopMockServerResponse>
apiService.listMockServerRoutes(mockId): Promise<MockServerRoute[]>
```

A loopback listener answering a collection's saved example responses on the paths its requests describe (issue #481 phase 2).
`collectionId` is the only required field; `latencyMs` and `errorRatePct` are the injection knobs, and an out-of-range value is a `400` rather than a clamp.

The mock is literal: it resolves no variables, so a `{{variable}}` in an example body is served as written, and it drops a leading `{{baseUrl}}` whole, so a path inside the variable's value is not part of any route ([the engine's Mock Server section](../../engine/api-reference/mock-server.md#mock-server)).

Two surfaces, deliberately split.
`CollectionDetail/MockServerControl` is the only one that can **start** one, because a mock needs a collection and the Services drawer has none selected; the drawer's Mock servers group lists and stops whatever is running, wherever it came from.
Both read the same polled list, so a mock started in one is visible in the other within a poll.

The knobs are sent from that control's options dialog and nowhere else (`StartMockServerDialog`, issue #570), bounds-checked against `mock-server-options.ts` before the request leaves - the engine's `400` names the field but not the range.
There is no update verb: `latencyMs` and `errorRatePct` are read per response and so *could* change under a running mock, but a run pointed at one has to be able to say which configuration produced its numbers, so they are frozen at start like the route table.

The same dialog takes `allowedOrigins` (issue #2367), one origin per line.
The key is sent **only when non-empty**: an empty box leaves the payload what it was, so the engine's any-origin default is its own and not restated here.
The lines are parsed and checked by `lib/allowed-origins.ts` (the engine's rules, in words, sent in the engine's canonical spelling), and the echoed `MockServer.allowedOrigins` is shown on the mock-server tab as `Origins: any` or the list.
Frozen at start like the knobs.

`listMockServerRoutes` **is** polled, at `MOCK_ACTIVITY_POLL_INTERVAL_MS`, even though it carries `staleTime: Infinity`: the route table's *shape* is a snapshot taken when the mock started and a running mock does not reload the collection, but each route's `hits` changes live as traffic arrives, so the poll is what keeps that count current.
`staleTime: Infinity` only means mounting a second reader of the same query does not force a redundant fetch - it does not stop the interval firing.
Stopping drops the record engine-side - unlike an inbox, which stays listed with `running: false` - so the mutation *removes* the routes cache entry instead of invalidating it, which would refetch an id the engine now answers `404` for.

Requests that share a method and path are one route, because the mock drops the query (#3115).
`MockServer.duplicateRoutes` counts the ones that never answer (optional in the type: an engine older than the fix omits it), and each such `MockServerRoute` carries `shadowed: true` and `shadowedBy: { requestId, requestName }`; both keys are absent, never `false`, on every other row.
The route table marks the row and names the request that answers, and `MockServerControl`'s chip counts them beside the routes without an example.
