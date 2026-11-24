---
description: >-
  The cross-cutting Zustand stores for where a collection's data and spec files live, the row an open builder is bound to, and which data-loss notice was already seen.
---

# Data file, spec file, bound row and recovery notice stores

## `data-file-store.ts` - Where Each Collection's Data File Lives

Each collection's data-file binding, by collection id, so the Run dialog can pre-fill the file instead of asking for it every run (issue #599).
Since #2765 the binding is a column of the collection's engine row (`Collection.dataFile`, `{path, fileName, hash?, castNumbers?}`), so a workspace backup carries it, a trashed collection keeps it and a restore brings it back.
This store is a **mirror** of the collections list, not a record:
`useFileBindingMirror` (mounted in `App.tsx`) subscribes to the query cache (`installFileBindingMirror`, `queries/file-bindings.ts`) and rebuilds the map from `queryKeys.collections.list()` inside every write to it, before any observer re-renders, so a component that reads the contract off the list and the file off the store never sees one without the other.
An unchanged binding keeps its object and an unchanged map keeps its identity, so a refetch republishes nothing.
A reader that holds the `Collection` (the Data tab) reads `collection.dataFile` directly; the store is for readers that hold only an id (the run dialogs' pre-fill, Send-with-row, `useDataFileStatus`).

**State:**
```typescript
{
  locations: Record<string, {
    path: string; fileName: string; hash?: string; castNumbers?: boolean
  }>  // keyed by collection id, rebuilt from the collections list
}
```

**Writes** go through the collection update, never through the store:
```typescript
// useDataContractWriter: the binding rides the same PUT as the columns
mutate({ id, dataSchema: { columns, declaredAt, fileName }, dataFile: { path, fileName, hash, castNumbers } });
mutate({ id, dataSchema: null, dataFile: null });          // Clear / Remove
// useDataFileReadingMutation: the binding is built when the write is sent
mutateReading({ id, path, castNumbers });                  // rememberReading
recordDataFileHash(path, hash);  // queries/file-bindings.ts: every binding at that path whose hash moved
```

**A collection's binding writes go out one at a time** (`queries/file-bindings.ts`).
The engine replaces a binding object whole, so a hash write built from the binding before a pick or a toggle landed would put the old one back.
Every update that carries `specFile` or `dataFile` waits for the same collection's earlier binding writes (`writeFileBinding`, which the update hook routes them through, and which stores the answered row itself);
the two that change one member of the binding - a re-read's hash and a toggle's `castNumbers` - are built from the store only once those have landed (`reviseDataFileBinding`), and send nothing if the binding no longer names their file by then.

**Persistence:** none here; the engine row.

**Two things the binding deliberately is not.**
It is not the *contract* - the declared columns (`dataSchema`) travel through import and export; a path is true of one filesystem only, so `POST /import/apply` refuses one and neither export writes one.
Its one reader outside the renderer is the app's own MCP server: `useDataFileLocationMirror` (mounted in `App.tsx`, after `useFileBindingMirror`) publishes the whole map to the main process over `dataFile:locations` on launch and on every change, and `list_collections` names a collection's file from that copy (issue #1742; a `fields: "full"` row, the summary names none).
`useAppFocusMirror` (also mounted in `App.tsx`) does the same for the active tab and environment over `app:focus`, publishing only when the snapshot changes, so `get_app_focus` can answer "the request I have open" (issue #2045).
And it never holds **rows**: a data file's contents are user data of unknown sensitivity and are persisted nowhere in Vayu, which `useDataContractWriter.test.tsx` and `DataTab.test.tsx` assert against the update payload - what the row stores - rather than against a surface.

The binding is written when the user declares a contract by picking a file, on the Data tab or in either run dialog (`hooks/useDataContractWriter.ts`), in the same update as the columns, with the path obtained through the preload's existing `getFilePath` bridge; and dropped, in the same update, when the contract is cleared (Clear or Remove) or a later pick carries no path.
A delete or a purge writes nothing: the row goes to the trash with its binding and the store's entry leaves with the row's place in the list, and a restore's refetch brings both back.
A write of `specFile` / `dataFile` alone does not invalidate cached compositions (`useUpdateCollectionMutation`): nothing composes against a file location.
Reading the file back needs the gated `dataFile:read` IPC (`electron/data-file.ts`), because the renderer otherwise cannot name a path.
The gate includes the main process's grant registry (#2357): a path is read only if the user picked, dropped or opened it through the app, which `getFilePath` records with the engine (`file_grants`, so it survives a restart).
**A stored path is not a grant.**
A data file declared before that registry existed holds no grant and must be picked once more; a path restored from a backup on another machine names a file that is usually not there.
Either way `dataFile:read` rejects with a "pick the file again" message (naming the path when the file is not there), `dataFile:hash` answers `{ status: "missing" }`, and the Data tab shows the bound path struck through beside the reason.
The renderer does not seed grants from stored paths - that is the input being gated.

`hash` is the SHA-256 of the file's bytes the last time the app read it (issue #2051), the same digest a run records as `dataFileHash`.
A pick writes it with the path; every re-read through `readDeclaredDataFile` calls `recordDataFileHash`, which writes the new digest to every binding at that path whose hash moved - nothing when it did not, so re-reading an unchanged file writes nothing - and logs a failed write rather than failing the read.
It is optional because a binding written before hashes were recorded has none until its next read.
Nothing that only *compares* writes it: `useDataFileStatus` and MCP's `list_collections` ask the main process for the file's current digest (`dataFile:hash`, which answers `{ status: "found", hash }` or `{ status: "missing" }` for a file that has moved or holds no grant) and fall back to this one only when they cannot.

`castNumbers` is how the file's CSV/TSV values are read (issue #2540), the picker's **Read numbers as numbers**: absent or `false` reads every cell as text, `true` reads an unquoted integer or decimal as a number.
It describes *this* file, so a pick writes it as the picker read the file (off for a fresh pick) and Remove takes it with the path.
Toggling the checkbox writes it through `useDataContractWriter`'s `rememberReading`, a binding-only update that is sent only while the binding still names the toggled file's path and reads it the other way when the write goes out; a hash refresh keeps it.
Every re-read (`readDeclaredDataFile`, which requires the flag) parses with it, so the Run dialog's pre-fill, the load dialog's, Send-with-row and the Data tab all read the file the way the user last chose.
A run sends it beside the rows as `dataFileCastNumbers` and its snapshot records it, so a re-run that reads the binding reads the file the way the recorded run did.

A row's binding is normalized in `CollectionTransformer` (`toDataFileLocation`): anything but a `{path, fileName}` pair of non-empty strings is no binding, so a value that got in another way never reaches the read IPC *as a path*; a malformed `hash` drops only the hash, and a non-boolean `castNumbers` reads as off.
An engine that predates the column, or answers `{}`, reads as unbound.

**Bindings from an older Vayu.**
Before #2765 both stores were zustand `persist` stores, under the `localStorage` keys that are now `LEGACY_FILE_BINDING_KEYS` (`vayu.spec-files`, `vayu.data-files`).
`useLegacyFileBindingImport` (mounted in `App.tsx`) reads them once, after the first collections list arrives (`importLegacyFileBindings`, `queries/legacy-file-bindings.ts`):
each entry goes through the row's normalizer and is written, binding-only, to the collection it named - but only to one the engine still lists and that holds no binding of that kind, so a binding already on the row is never overwritten.
An entry for a collection the list does not name - one deleted, or sitting in the trash, before the upgrade - is dropped, so restoring such a collection later brings it back unbound.
A key is removed once every write it asked for has landed; a launch that cannot reach the engine keeps it and the next one finishes the move.
A key that is not a payload the old store could have written is logged and dropped.

## `spec-file-store.ts` - Where Each Collection's Spec File Lives

Each collection's picked spec file, by collection id, for the specs that were picked as files rather than fetched from a URL (issue #638).
The binding is `Collection.specFile` (`{path, fileName}`) on the engine row (#2765), and this store mirrors it the way `data-file-store` above mirrors `dataFile`, from the same cache subscription.

**State:**
```typescript
{
  locations: Record<string, { path: string; fileName: string }>  // keyed by collection id
}
```

**Writes:** `useBindSpecMutation` writes `specFile` after the bind lands and before the collections refetch (`{ specFile: null }` for a URL or a paste, which forgets an earlier file); Unbind clears it in the same update as `openapi: null`;
a file-picked OpenAPI import writes it to each root that bound a spec, after the apply (`queries/import.ts`: the collection has no id until then, and `POST /import/apply` refuses a file binding), logging a failed write rather than failing an import that committed.

**Persistence:** none here; the engine row.

The same two-halves law as `data-file-store` above, one contract over: the **document** is engine state (`spec_documents.content`, hashed there, bound by `collection.openapi.specId`) and travels through import; a *path* is true of one filesystem only, so a backup keeps it and no export or import carries it.
A URL-sourced spec has no binding at all - its origin is `spec_documents.source_url`, which is portable and is what a re-fetch will use.
And it never holds spec **content**, which `spec-bind.test.tsx` and `SpecTab.test.tsx` assert against the update payload.

The Spec tab reads `collection.specFile` and shows the bound file's path as the document's source.
Reading the file again (the Sync section's Check) and the files a picked document *references* needs the gated `specFile:read` IPC (`electron/spec-file.ts`), which takes the document's path plus the reference and resolves one against the other in the main process.
The document path must be one the user picked, dropped or opened (the grant registry, #2357) - a stored path is refused with a "pick the file again" message, so a binding made before grants existed needs one more pick - and the reference may not leave that document's directory.
The same grant gate holds `dataFile:read`.
A check that fails to read the bound file strikes the path through (SpecSync's `onFileRead`), learned from the attempted read rather than from an existence check of its own.
A delete, a restore and a purge write nothing, as for the data-file binding.

## `bound-row-store.ts` - The Row The Open Builder Is Bound To

One slot: the data row a Send-with-row has picked, and the id of the request it was picked for (issue #1074).

**State:**
```typescript
{
  bound: { requestId: string; row: Record<string, unknown> } | null
}
```

**Key Methods:**
```typescript
const setBoundRow = useBoundRowStore((s) => s.setBoundRow);
setBoundRow({ requestId, row }); // or null for "bound to none"
```

**Persistence:** none, deliberately - see below.

**Why a store at all.**
`RequestBuilderProvider` already gives the picked row to its own resolver, which covers every preview inside the builder (issue #1062).
The tab strip is the one that is not below it: `useTabDescriptors` labels every open tab from a single list-wide resolver, so it cannot take the row off the builder's context and, left alone, labelled a tab from the environment while the bar one row beneath it showed the file's value.

**One slot, not a map, and it names its request.**
The builder binds a row for the request it is showing, so that is the only request an on-screen preview can be bound for; a row per remembered index would be a row out of a file that is no longer the one loaded.
Carrying the request id is what lets a reader check rather than assume, so a slot left standing cannot relabel the next tab - `boundRowFor(bound, requestId)` is that check, named once rather than repeated at each call site.

**Never persisted, and cleared with the builder.**
Rows are user data of unknown sensitivity and are persisted nowhere in Vayu, the same law `data-file-store` states above; the builder also clears the slot when it unmounts, so a row cannot outlive the send that justified it.

## `recovery-notice-store.ts` - Which Data-Loss Notice Was Already Seen

One timestamp: the `at` of the startup-recovery record the user has already been told about (issue #922).

**State:**
```typescript
{
  acknowledgedAt: number | null  // epoch ms of the dismissed record, or null
}
```

**Key Methods:**
```typescript
const { acknowledgedAt, acknowledge } = useRecoveryNoticeStore();
```

**Persistence:** `vayu.recovery-notice` (v1)

The *record* is the engine's - a marker file beside the database, reported on `GET /health` for as long as it stands, because a record that cleared itself as soon as something read it would be lost whenever the engine restarted before the app polled.
Showing a notice about it exactly once is this side's job, and one timestamp is the whole of it: a later recovery carries a later `at` and is a different event, so it surfaces again with no per-event bookkeeping.
Persisted rather than session state because "does not repeat on the next launch" is the point - a window reopened against an already-running engine would otherwise re-announce a wipe the user had dismissed.
A stored value that is not a finite number reads as "nothing acknowledged", the safe direction: a notice shown twice is an annoyance, one suppressed by a garbage value is silent data loss again.
It is normalized through **both** `migrate` and `merge`: `migrate` runs only on a version mismatch, while `merge` runs on every rehydrate, so only the pair reaches the same-version payload that is the common case.
