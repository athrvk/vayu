---
description: >-
  What `RequestBuilderContext` holds besides the request: variable members, body drafts, the GraphQL Variables draft, bulk edit drafts and the headers a setting added.
---

# RequestBuilderContext

## `RequestBuilderContext` - variable members

The request builder re-exposes the resolver plus two things only it can derive:

```typescript
getVariableOrigins: (name: string) => VariableOrigin[]
updateVariable: (name: string, value: string, scope: VariableScope, sourceId?: string) => void
writableScopes: VariableScope[]
```

`writableScopes` lists the scopes `updateVariable` would actually write to.
It opens by resolving a target (`variableTargetOf`), and a missing target or a source that is gone ends the call, so a write to a scope with no active target is a **silent no-op** - the variable popover uses this list so its "create in" picker cannot offer one.

An **edit** passes the `sourceId` of the `ResolvedVariable` the popover showed and `updateVariable` writes to the collection or environment with that id - in a collection chain, often an ancestor of the request's own collection - spreading the existing definition so its `secret`, `type` and `createdAt` survive.
A `sourceId` naming a source that no longer exists is a no-op, not a fall back to the request's collection.
A **create** passes none and lands in the hook's own `collectionId` or the active environment (#3683; the target naming is `lib/variable-target.ts`, shared with the context bar's `useVariableCommit`).

A write through `updateVariable` always sets `enabled: true`.
Setting a value means "make this value apply"; enabling and disabling belongs to the variables editor.
Without it, creating a value for a name that was disabled everywhere preserved `enabled: false` and the token stayed unresolved.

**Usage:**
```typescript
const { resolveString } = useVariableResolver({ collectionId });
const resolvedUrl = resolveString("https://{{baseUrl}}/api/users");
```

## `RequestBuilderContext` - body drafts

```typescript
bodyDrafts: React.MutableRefObject<BodyDrafts>
```

What the body modes you are not looking at were holding.
A request stores **one** body - the shape is a discriminated union, `{"mode":"json","content": "..."}` - so JSON, text and GraphQL share `request.body`, and switching mode handed the same string to a different reader.
Switching from JSON to GraphQL therefore read the payload as a raw query string and destroyed it.

Two buckets, not eight: `json`, `text`, `jsonrpc`, `mcp` and `xml` are one raw string differing only in highlighting, so text carries between them deliberately; `graphql` is an envelope this side parses into two panes and keeps its own; the two form modes use `formData` / `urlEncoded` and `binary` uses `binaryFile`, and none of the three touches `body`.
`jsonrpc`, `mcp` and `xml` sit in the raw bucket because nothing here reads their text as a structure - JSON-RPC's and MCP's frames are completed engine-side at wire time and an XML document is sent byte for byte, so each pane holds one plain document.
An `mcp` body's tool is not a draft: `RequestState.mcpTool` is its own mergeable field (`MERGEABLE_FIELDS`, the Body group of `ExternalChangeNotice`), kept across a mode switch like `binaryFile`.
The rule lives in `modules/request-builder/utils/body-drafts.ts`.

Two things about it are deliberate and easy to undo by accident:

- **It lives in the provider, not in `BodyPanel`.**
  Radix unmounts an inactive `TabsContent`, so a panel-local ref is discarded the moment you glance at the Headers tab, taking the stashed body with it.
- **The provider does *not* reset it** on a request change.
  The drafts carry their own `requestId` and `switchBody` drops any belonging to another request, so a second reset would duplicate that rule - and would fire on the request-change effect, which re-runs on more than the id.

Deliberately **not** persisted: a request has one body, and storing payloads it will never send would put them in exports and in the engine's schema.

The form modes and `binary` need no bucket because the stored record never speaks for them from another mode: `initialRequest` in the request builder's `index.tsx` names `formData`, `urlEncoded` or `binaryFile` only while the stored body is that mode.
A save made in JSON mode refetches a record with no form rows, and with the keys absent the per-field merge sees no change and keeps the draft's rows and chosen file (#3665).
The condition is the stored mode, not a non-empty value: a stored form-data body with no fields still empties the table.

## `RequestBuilderContext` - the GraphQL Variables draft

```typescript
getVariablesDraft: () => VariablesDraft | null
setVariablesDraft: (draft: VariablesDraft) => void
```

The Variables pane's raw text, for the same reason and with the same lifetime.
The pane is a JSON editor over one *key* of the GraphQL envelope, and the envelope cannot always hold what it shows: text that is neither JSON nor a resolvable `{{template}}` is dropped by `serializeGraphQLBody`, deliberately, so that the query pane keeps saving while the variables pane has an unclosed brace.
That makes the pane's own text the only copy - and `GraphQLBody`'s component state the wrong place for it, since the Radix unmount discards a half-typed variables object exactly as it once discarded a stashed JSON body.

It is beside the mode drafts rather than inside them because it is not a mode's body (GraphQL's body is already in the `graphql` bucket).
It carries its own `requestId` for the drafts' reason, and `ownVariablesDraft` - not a second reset in the provider - is what drops one belonging to another request.

## `RequestBuilderContext` - Bulk edit drafts

```typescript
bulkDrafts: BulkDrafts                       // the request on screen's, per table
setBulkDraft: (table: BulkTable, draft: BulkDraft | null) => void
commitBulkDraft: (table: BulkTable) => void  // the Table toggle
```

The Params and Headers tabs' Bulk edit text (#3666).
`BulkEditor` is controlled; the provider holds the drafts filed under `memoryKey`, at most one per table.
State, unlike the body drafts' ref, because the textarea renders from it; per key rather than one slot because one provider serves every request tab: a draft held in the component was dropped by the Params / Headers unmount of a sub-tab switch, and before the panels were keyed it followed the user into the next request and committed there.
The open-tab sweep that bounds the row memory prunes it, and the request-change reset block leaves it alone, so a request returns to its own draft, in text mode.

A draft is written into the request by one rule, `utils/bulk-drafts.ts` (`bulkTextPatch`, with the Params table's own `queryTablePatch` for the URL and the no-op guards of #1480), from four places:

- **The Table toggle** (`commitBulkDraft`): `setRequest` and the draft closes.
- **Send** (`executeRequest`): every open draft is written and closed, and the request the send carries is built from the snapshot plus that patch, because `request` does not hold it until the next render.
  What is on screen is what is sent.
- **Load test** (`startLoadTest`): the same commit as Send (`commitBulkDraftsForSend`), so the test runs on what is on screen.
- **Save** (`handleSave`, so autosave, the Save chord, the command and the goodbye flush alike): the patch goes into the payload and `changedFields`, and is written into the request on screen without a generation bump, since the save carries it.
  The draft stays open, rebased onto what was saved, because autosave fires on its own timer and must not close the editor under the caret.
  When the provider already shows another request (the flush of the one left), only the payload carries it: `shownMemoryKeyRef`, set in a layout effect, keeps the other request's state untouched.
  The same check holds the rest of `handleSave`'s bookkeeping (#3730): a save that runs, or settles, while another request is shown records none of the values it sent (`recentSends`), the fields it settled (`touchedFields`, `baseline`) or the dirty flag, failed or not, so they cannot land in the request now on screen.

A draft on its own does not mark the request dirty, so it is saved only when something saves the request.
Not persisted.

## `RequestBuilderContext` - the headers a setting added

Two settings each own a header row: the body mode's `Content-Type` (written by `BodyPanel`) and the Event stream toggle's `Accept: text/event-stream` (written by `SettingsPanel`, issue #574).
GraphQL is sent as a JSON envelope and genuinely needs `Content-Type: application/json`, so `BodyPanel` appends one - but nothing removed it, so a single visit to GraphQL left the header on the request for good, including after switching back to `none`, which sends no body at all.

Ownership of the row used to be a context-level record, `{ requestId, rowId, value }`, held in a ref the provider owned.
That could not survive a reload: a fresh mount started with an empty ref, so a stale auto-written row was then indistinguishable from one the user typed, and neither `withoutContentType` (nothing to remove) nor a later mode switch (an "existing" row, so nothing to add) could tell the difference (issue #1481).
Ownership now lives on the row itself - `KeyValueEntry.source?: HeaderRowSource`, whose `"body-mode" | "stream"` half (`AutoHeaderSource`) is what an app setting writes;
the third value, `"legacy-default"`, is the engine's own header-strip repair pass marking a row it disabled rather than deleted (issue #1491, `docs/engine/db-schema.md`'s "header-strip pass" section) and is never written from this side.
There is no context accessor for either app setting any more;
`switchAutoHeader` in `modules/request-builder/utils/auto-header.ts` reads and writes the marker directly on the headers array it is handed, once per change:
it removes the marked row when the new setting does not need that same header, then adds whatever the new setting does need - both halves in one pass over one array, because two `updateField("headers", …)` calls would compute the second against the array they had before the first.
`panels/body/content-type.ts` is now just the body-mode half: which `Content-Type` a mode requires, plus the delegation.

Two things it is deliberate about:

- **By marker, not by value.**
  A `Content-Type` the user typed and the row a setting wrote are identical apart from the marker, and only a marked row may be removed.
  `KeyValueEditor`'s `handleUpdate` clears the marker the moment a user retypes a row's key or value - once retyped, it is theirs, whatever the new value happens to be.
  Merely disabling a marked row does not clear it: the row is not sent while disabled, so there is nothing to have adopted.
- **A row already declaring the header - even a different value - is never overridden.**
  Silently replacing it would be a worse version of the bug this exists to fix.
  A disabled declaration does not count: it is not sent, so the header the mode needs is still missing.

The setting that used to be the one slot left, `AutoMethod`, is not a header row at all (issue #1228).
A new request is a GET, and GraphQL over GET is a different transport - the document travels as query parameters and a mutation cannot be sent that way - so picking the GraphQL body mode on a request still holding that default used to build one the server answered with a bare `400`.
The mode now sets `POST` the same reversible way it sets the `Content-Type` header above, and leaving the mode puts the method back.
It has the same reload gap issue #1481 fixed for the two header rows, closed the same way by issue #1505: ownership lives on `RequestState.methodSource?: MethodSource` (`"graphql"`, the domain type mirroring `HeaderRowSource`), a value on the request itself rather than a ref-held record, so it is exactly as durable as `request.method` beside it.
`switchGraphQLMethod` in `panels/body/graphql-method.ts` is the rule that reads and writes it, called from `BodyPanel.handleModeChange` alongside `switchAutoHeader`, and it keeps the same two guarantees stated as bullets above, read against a scalar field instead of a row:
a method the user has since chosen - `methodSource` no longer `"graphql"` - is no longer this side effect's to revert, and `MethodSelector`'s `onValueChange` clears the marker in the same call that sets the hand-picked method, the exact moment `KeyValueEditor`'s `handleUpdate` clears a header row's `source` on a retype.
A GET still reaches GraphQL through the door this side effect does not touch - the user picks GET back, or an import wrote one - which is when the Query pane header's `BadgeText` names the transport that will be used.

**Which identity a builder files under is one value, resolved once** (issue #1272): `memoryKey ?? request.id ?? UNSAVED_AUTO_KEY`, read by every per-builder map the provider still holds - now only the Send-with-row picker's row memory below, since the three reversible-setting records above all moved onto the request's own state.
A request tab is its request and passes nothing.
The editable copy History renders for a stored run passes the run id, because `design-run-seed.ts` gives that copy `id: null` on purpose - a null id is one of the two gates that stop an edited copy from rewriting the saved request - so every open run copy used to share the id-less bucket before issue #1272.
That was not a near miss: the rules read a `requestId` of `null` against another `null` as a match, so the second run tab's picked row was handed the first one's record and read as its own.
A prop rather than a field on `RequestState` that only History would set: `request.id` stays honestly null, and no request grows a "which run am I" field for one caller.
A run id names a tab, so that memory is bounded by the same sweep rather than exempt from it.

`UNSAVED_AUTO_KEY` is what remains for a builder declaring neither - nothing in the app today - and it is the one key the sweep cannot drop, since a key naming no tab cannot be bounded by the tabs.
It is kept rather than removed because the alternative for such a builder is sharing whichever key was written last, which the `null === null` ownership check hands out as owned rather than refusing.

**The open tabs bound the Send-with-row picker's memory** (issue #1271), the provider's one remaining per-request map: which row index each request was last sent with (`rowIndexByRequest`, issues #659 and #1062).
It survives a tab switch and a return, because neither of those is a send - and it goes when the tab does, since the request it was picked for can no longer be switched to.
`tabs-store` is subscribed to rather than selected from, because a provider that re-rendered on every tab focus would charge the request the user is working in for it.
`MAX_OPEN_TABS` caps the tab strip, so it caps the map, and both request tabs and run tabs are swept, by their `entityId` - a request id and a run id respectively, from different tables and so unable to collide.
A run tab holding no builder at all (a load test, a scenario) only ever keeps a key nothing wrote.

The row memory is `useState` rather than a ref - `lastRowIndex` is read while rendering - so its half of the sweep is a `setState`, and `retainKeys` (`context/retain-keys.ts`) returns the map it was handed when every key is still live.
Without that identity guard the provider would re-render on every tab focus, which is exactly the cost the subscription was chosen to avoid.

The two header markers and `methodSource` need none of this: what is persisted is the row itself, in `request.headers`, or the method's own marker, in `request.methodSource` - no provider-side map, no sweep, nothing a reload can lose that a save does not already carry.
