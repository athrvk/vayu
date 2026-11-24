---
description: >-
  The cross-cutting Zustand stores for centralized auto-save and for unsaved collection drafts that outlive their editor.
---

# Save and entity draft stores

## `save-store.ts` - Centralized Auto-Save

Orchestrates saving across the app.
Every surface that saves reports where its own edit stands, the Dock's status is derived from all of those reports, and a registry of saveable contexts (request tabs, environment editors, Settings) backs Ctrl/Cmd+S and the quit and reconnect flushes.

**State:**
```typescript
{
  unsaved: ReadonlyMap<string, UnsavedEdit>  // every id with an edit not on disk
  status: "idle" | "pending" | "saving" | "saved" | "error"  // derived from `unsaved`
  lastErrorMessage: string | null            // derived: the newest failure's message
  activeContextId: string | null
  contexts: Map<string, SaveContext>         // Saveable entities
}

type UnsavedEdit =
  | { kind: "pending" }
  | { kind: "saving" }
  | { kind: "failed"; message: string; diskFull: boolean }
```

**Each surface reports under its own id, and nothing writes `status` (#3350).**
The store holds no single `status` that every surface writes through public setters (`setStatus`, `markPendingSave`, `startSaving`, `failSave`, `reset`): that shape let one surface's write erase another's:
switching request tabs ran a `reset()` that wiped the variables editor's "Not saved", Settings' clean branch published `idle` over another context's error, and the autosave retry read another surface's failure as its own.
Those setters are gone.
A surface reports:

| Report | Meaning |
|--------|---------|
| `reportPending(id)` | The edit `id` holds is not on disk. Does not demote a failure: the edit that failed is still unsaved. |
| `reportSaving(id)` | A write for `id` is in flight. |
| `reportSaved(id)` | `id` is on disk; opens the "Saved" window. |
| `reportFailed(id, message, cause?)` | `id`'s write failed. Raises the error toast, once, and records whether `cause` was the engine's 507. For an id discarded while the write was out, the toast is all it raises (below). |
| `discard(id)` | `id`'s edit was thrown away, not written: nothing to report as saved. Only for an edit that is gone, because it also abandons a write still out for it. |

An id with nothing unsaved has no entry, so "clean" is absence.
**The derivation:** any failure wins, and the newest one is described, because a failed report moves its id to the end of the map; then a save in flight; then an edit not yet sent; only with none of those does a recent save show `saved`, for `TIMING.SAVED_STATUS_DURATION_MS`, before `idle`.
A report under one id cannot touch another's entry, which is the whole fix: a rename landing, Settings mounting clean, a tab switch - none of them can make the Dock stop saying "Not saved" while some other edit is still unsaved.
`resetSaveStoreForTests` is the only thing that clears every report, and only tests call it.

An entry is keyed by id, not by registration: it outlives `unregisterContext` until its id is reported saved or discarded.
That is how the entity-switch flush of a pane that has already unregistered still reaches the Dock.

**The ids.**
`useSaveManager` reports under its context id (`request-<id>`), `useDraftSaveContext` under the id it registers, `VariableTableEditor` under its context id (`globals-editor`, `environment-<id>`, `collection-<id>`), `SettingsMain` under `settings`, the inbox reply under `inbox-reply`, and the context bar's variables section under `context-bar-variables`.
A surface that drops its draft discards its id:
`VariableTableEditor`, and `useDraftSaveContext` for an editor that passes no `stored` draft (the inbox reply), when the id changes or they unmount (the draft is component state, so nothing holds it after that), `useDraftSaveContext` for a stored draft (the collection editors, #3459) when that stored draft is dropped or its entity is gone,
which an unmount alone does not do (see [`entity-draft-store.ts`](#entity-draft-storets---unsaved-collection-drafts-that-outlive-their-editor)), `SettingsMain` when its staged edits are gone (reverted,
or flushed with every one of them invalid) and no write is in flight, and `useSaveManager` when the request's edit is gone without a save (reverted, or the request deleted elsewhere while dirty) and no write is in flight, which also cancels the autosave retry.
Settings reports an invalid staged edit as `pending` too: it is unsaved, held back the way a blocked save is, and its save resolves `pending` for it, so a Ctrl/Cmd+S on an invalid edit does not read as "Saved".

**A write that settles after its id was discarded describes no edit.**
The editor that dropped the edit (an id switch, an unmount, a Reset) is gone or holds something else, but the write it started still lands, and recorded under that id its failure or its "still unsaved" would hold the Dock with nothing ever to clear it.
So a discarded id is abandoned until a save starts for it (`reportSaving`) or a context registers under it: a failure reported for it is a toast only, and `reportPending` counts only from a context registered under the id, which is a new edit.
A goodbye flush never discards first, so its failure is recorded and stays "Not saved" until a later flush saves it - except for an entity that was deleted (below).

**A deleted entity's edit is dropped, not saved (#3444).**
The tree's delete of a request, or of a collection above it, awaits the engine and then closes the tabs, and a tab's unmount flushes its draft.
Saved into the deleted row that PUT answers 404, toasts "Couldn't save - Request not found" and leaves a retry context nothing can land, so the Dock stays "Not saved" and the quit prompt warns about an edit nobody can keep.
`useTreeCrud` therefore calls `markRemoved(ids)` with the context ids (`request-<id>`, a collection's descendant requests included) after the delete lands and before `closeTabsForEntities`.
The set behind it is module-local like `abandoned`, not store state, and `isRemoved(id)` is what the goodbye flush asks: a removed id is `discard`ed without a save.
A context registering under the id clears the mark, so a restore (Undo brings the same id back) saves normally.
The backstop for a delete the tree did not make (another window, an MCP client) is the flush's own answer: a goodbye flush whose save fails with a 404 discards the id instead of re-registering a retry.
The failure toast has already been raised by then and is not taken back.

**A failure that leaves no unsaved edit is a toast, not `reportFailed`.**
`reportFailed` holds the Dock on "Not saved" until that id saves again, so it is for a failed write whose edit is still on screen.
A failed create, duplicate or delete (collections, requests and environments alike) leaves nothing pending and nothing retries; a failed rename (the collection tree's two, the environment tree's) puts the stored name back; a failed context-bar variable commit puts the stored value back in its input;
a refused blank name (`reportBlankNameRefused`, `lib/blank-name.ts`) restores the stored name; a failed `SettingsMain` category-switch or unmount flush wrote edits that had already left the screen with their category, so nothing staged is left for a Save to retry.
Each raises its own error toast.
Reported to the store, any of them would park the Dock on "Not saved" describing no edit, under an id nothing would ever report saved.

**Direct writers** are the surfaces that write without going through the store's `runSave`, and they report the same way.
The tree renames register no save context: each reports `saving` under `rename-collection-<id>`, `rename-request-<id>` or `rename-environment-<id>` while the PUT is out, then `saved`, or a `discard` and the toast.
The rename field stays mounted until the PUT settles, so a failure is reported over the typed name rather than after the row has snapped back.
`SettingsMain`'s Save button and category-switch flush, and the inbox's `CannedResponseControls` Apply (#1450), report around the PUT themselves, because a direct click reaches no registered context's `save` through the store.
Each of them reports `pending` rather than `saved` for an edit staged while its write was in flight, as `useSaveManager` does.
A direct writer also cannot report "Saved" over another surface's unsaved edit (#1385): a rename landing while the open request holds an unsaved script reports `saved` under the rename's id, and the request's `pending` outranks it.

`VariablesSection` also **registers a context** (`context-bar-variables`).
A variable commit is a plain mutation rather than a draft, so it registers one entry for the whole section whose `hasPendingChanges` tracks whether any commit is outstanding and whose `save()` resolves when the last one settles - without it `flushAll` had nothing to wait for, and the renderer could be torn down mid-PUT with the input already showing the value as committed.
It reports `saving` while any commit is out; when the last one settles it reports `saved`, or withdraws the report if one of them failed (the toast has said so, and the input is back on the stored value).
A commit settles from the mutation's own promise (`mutateAsync`), never `mutate`'s per-call callbacks: a TanStack observer holds one set of those, replaced by the next `mutate` and never called once the host unmounts, so a second quick commit in the same scope, or a tab switch mid-PUT, left "Saving…" up until restart.
Its `save()` resolves with the commits' verdict, `failed`, or `disk-full` when every failure was a 507, which is what the quit prompt counts.

`completeSave`, `completeSaveThenIdle` and the hand-rolled `setTimeout(() => setStatus("idle"), …)` timers went with the setters.
The "Saved" window is the store's own: `reportSaved` opens it and any later report closes it, so a success two seconds ago cannot clear a failure reported since, and two saves a second apart cannot end each other's indicator early.
Its lifetime is `TIMING.SAVED_STATUS_DURATION_MS`, in one place, for every surface that saves.

**`lastErrorMessage` is the reason behind an `"error"` status**, for the Dock's persistent line - see below.
A field with one reader, the Dock's error line, goes when that line does, as `errorMessage` did; this one has a second reader because the toast is not the whole answer (next paragraph).
Whether that failure was a 507 is kept on its entry (`diskFull`), not beside it: `flushAll` reads it per context, and no screen reads a store-wide copy.

There is no `lastSavedAt` or `pendingSaveId`, for the same reason that field almost went a second time - every match on either name was a write inside `save-store.ts`.
`status` is still the store's main public surface, and all five of its values have a reader: the Dock renders `pending` as **"Unsaved changes"**, which is the only place in the app that says so.
That matters because auto-save is a setting the user can turn off, and with it off nothing was written back and nothing said as much (the tab strip carries no unsaved-dot on purpose).

**`"error"` has two readers now, not one.**
The toast `reportFailed` raises expires after `TIMING.TOAST_DURATION_MS.error` (10s), and a failed save can leave a draft unsaved for as long as the engine stays down - far longer than that.
The Dock's ambient status line (`Dock.tsx`) renders an `"error"` status as **"Not saved"**, coloured with `--destructive-text`, with `lastErrorMessage` in a tooltip on hover - the same shape `EngineStatus` uses for its own error, rather than a second way of saying "hover for the reason."
It stays until the failed id is reported saved or discarded, so it outlives the toast for exactly as long as the edit stays unsaved.

**A failed save retries itself.**
Two surfaces do, on one backoff: `saveRetryDelayMs` (`lib/save-failure.ts`) re-arms with the auto-save delay, doubling on each further failure and capped at `TIMING.SAVE_RETRY_MAX_DELAY_MS` (one minute).
`useSaveManager`'s debounced timer is the only one of its callers that retries, cancelled on unmount, on an entity switch, and by the next ordinary edit.
`VariableTableEditor` retries any failed save of its own (its saves are all blur, toggle or flush commits, with no debounce to re-arm), while it is still dirty; the retry is cancelled on unmount and on an entity switch, superseded by any save that starts, and armed only by the last of a run of queued saves, since one queued behind a failure is already its retry.
A 4xx is final (#1889): the engine rejected the payload itself (a 400, a 413), so both report it as `"final"` (`saveFailureOutcome`, which asks `isFinalError`, the predicate the query and mutation retry rules share) and no retry is armed.
The status stays `error` - the Dock keeps saying "Not saved" - and the next edit re-arms the debounce (the editor's next blur or toggle saves again).
A 5xx, a timeout or an unreachable engine keeps retrying.
So does a 507, the engine's answer to a write the data folder's volume has no room for (#2423): both report it as `"disk-full"`; the toast is the generic "Couldn't save - <engine message>", because the engine's sentence already names the cause and the action, and the backoff above carries on until space returns.
The retry is the app's own timer; nothing here reads the 503's `Retry-After`.
In `useSaveManager`, Cmd/Ctrl+S and the entity-switch/quit goodbye flush still call `performSave` directly and report their own outcome once - retrying either would save into a pane the user has already left, or double a save they just asked for by hand.

**A reconnect flushes every dirty context, not just the one that failed.**
`useHealthQuery`'s automatic-reconnect branch and `useEngineRestart`'s manual one both call `flushAll()` right after `invalidateQueries()` - the same move, for the same reason: a dirty editor's own retry can be backed off up to a minute behind an engine that just came back, and nothing else pokes it sooner.
Every registered context is safe to flush here, unlike the quit flush's urgency: a context with nothing pending is a no-op, and one that has never failed loses nothing by saving now instead of on its own schedule.

**A reconnect also names the services the outage stopped** (issue #3493).
Inboxes, mock servers and OAuth issuers live in the engine process, so the engine that comes back runs none of them.
`recordServicesBeforeOutage` (`lib/services-stopped-by-restart.ts`) reads `queryKeys.inbox.list()`, `queryKeys.mockIssuer.list()` and `queryKeys.mockServer.list()` out of the cache at the outage's first sign, `useHealthQuery`'s first failed poll or `useEngineRestart` before it asks for the restart, because the lists' own poll can reach the new engine before any reconnect is noticed.
What counts as running is `runningServicesIn`, the definition `useRunningServices` shares.
Both reconnect branches then call `reportServicesStoppedByOutage`, which takes the one pending snapshot (the second caller finds none), fetches the three lists fresh, and raises one warning toast for the services that were running and are absent or `running: false` now, compared by id: it names at most three and counts the rest ("and 2 more").
A list read that another refetch cancels (the reconnect's own invalidate, a mutation's) is read again, up to three times.
A failed fetch raises nothing and puts the snapshot back, marked restored, for the other path's report of the same outage; the next outage's first record replaces it.
A list change with the engine up (an MCP stop, a Stop in the drawer) records nothing on its own; only one the cached lists had not shown yet when an outage began is named as if the restart had done it.

**`triggerSave` will not report a success the context did not have.**
A registered context can report its own failure under its id and then *resolve* rather than reject (`SettingsMain`), so `runSave` cannot take a resolved promise for a success.
Without that a failed Cmd/Ctrl+S showed "Saved" beside its own failure toast.

**A context's `save` can report its own verdict** (`SaveOutcome`: `"saved"`, `"failed"`, `"final"`, `"disk-full"` or `"pending"`; `useSaveManager`, `useDraftSaveContext`, `VariableTableEditor` and the context bar's variables section do), and that verdict is what `runSave` and `flushAll` count -
never a status read back from the store, which charged one context's failure to another when the status was a single shared slot.
A reported `"saved"` or `"pending"` that the context did not also report under its own id during the save is filled in for it (the draft editors report nothing on success), and a failure it reported is never published a second time.
`pending` is a save that settled without persisting its edit: a `SaveBlockedError` (the editor declined to send an incomplete element; the request builder still sends the rest of the request, #3048) or an edit that landed while the write was in flight.
It is not a failure - no toast, no "Not saved", no retry - and `flushAll` counts it in `pending`.
`"final"` is a failure that will not retry (a 4xx); `flushAll` counts it in `failed`.
`"disk-full"` is a failure that retries like any other and knows its cause (a 507, #2423); `flushAll` counts it in `failed` too, and sets `reason: "disk-full"` on its result only when every failed context was disk-full.
One failure of another kind beside it leaves the key out, because then "the disk is full" would be only part of the story.
The key is absent, not `undefined`, when there is no cause.
Three places turn a failed save into `"disk-full"`, all through `isDiskFullError` (`lib/disk-full.ts`): `saveFailureOutcome` (`lib/save-failure.ts`, read by `useSaveManager`'s `performSave` and by `VariableTableEditor`), the `useDraftSaveContext` save (the collection editors, whose saves reject) and `runSave`'s own catch in the store.

A context that resolves with nothing (`SettingsMain`) is judged by what it reported under its own id during that save: an entry that replaced the one present when the save started.
A `failed` entry reads `failed`, or `disk-full` when its cause was a 507; a `pending` one reads `pending` (#1381), because a context that saw an edit land mid-write reports it for the payload that went out not holding that edit; no report is a success, which `runSave` then reports.
So a context that reports and resolves names a 507 by handing the error over as the cause, `reportFailed(id, message, error)`; a call that omits it reads `failed` (#2685).
A context that reports and then *rejects* is judged the same way: `runSave`'s catch publishes a rejection only when the context did not report a failure during that save, so the failure is toasted once rather than once by the editor and again by the store.
That is counted (each id's failure reports, toast-only ones included), not read from the entry, because an editor that switched away mid-save has discarded the entry its failure would have replaced.
The inbox's `CannedResponseControls` (whose `persist` catches its own rejection, so it must not rethrow: the wrapper would toast a second time) returns the verdict from `persist` instead, which `useDraftSaveContext` forwards; a bare resolution there would read `saved`, which is also why a draft that `collect` refuses resolves `pending`.

**A goodbye flush is retired by the flush that saves it.**
An entity switch or unmount flushes the pane's edit after its context has unregistered (`settleGoodbyeFlush` in `useSaveManager.ts`).
A failure re-registers a retry context under the same id, so the reconnect flush (#1479) and the quit flush (#1489) can send it again; that retry unregisters itself once its save lands, and the landing reports the id saved.
Before #3350 nothing marked it clean, so the Dock sat on "Unsaved changes" and every reconnect re-sent the stale draft.
A save the editor held back has nothing left to send it (the provider reseeds from the next entity), so its id is discarded, and so is one the engine answered 404 or that the tree marked removed (#3444): the entity is gone and no retry can land.
A pane that came back to the entity owns the id again and is left alone.

**SaveContext:**
```typescript
{
  id: string
  name: string
  save: () => Promise<SaveOutcome | void>  // SaveOutcome: "saved" | "failed" | "final" | "disk-full" | "pending"
  hasPendingChanges: boolean
}
```

**Key Methods:**
```typescript
// One selector per member: a bare `useSaveStore()` subscribes to every field (#1714).
const reportFailed = useSaveStore((s) => s.reportFailed);

// Reports, under the caller's own id - see the table above:
//   reportPending, reportSaving, reportSaved, reportFailed, discard
// markRemoved(ids) / isRemoved(id)  an entity's delete landed; its goodbye flush
//                is skipped and discarded (#3444)
// Registry:
//   registerContext, unregisterContext, updateContext,
//   setActiveContext, getActiveContext
// triggerSave()  Ctrl/Cmd+S - saves the active context, else the first dirty one
// flushAll()     saves every dirty context (quit, reconnect); resolves to
//                { saved, failed, pending, reason? } - see above
```

**Non-persisted**.
See `useSaveManager` (debounced-autosave editors) and `useDraftSaveContext` (draft editors, whether they commit on blur or on a button) for registration details.
Between them every dirty editor in the app is in this registry, which is what `flushAll` walks on quit - a surface that is not registered is not merely unsaved on quit, it is invisible.

The collection tree does not read the registry: a request whose open tab has unsaved edits drags like any other row (#3447).
A move rewrites the row's owner and order, and the builder's save is a merge-patch of the fields that changed, so neither writer carries what the other owns and neither needs to wait.

## `entity-draft-store.ts` - Unsaved Collection Drafts That Outlive Their Editor

A `Map<entityKey, { draft, baseline }>` holding every `useEntityDraft` draft outside the component that edits it (#3459).
`Shell.tsx` mounts only the tab on screen, so a look at a request unmounted the whole collection screen, and a draft in component state went with it: no prompt, the Dock idle, the old script still sent.

**Key Methods:**

```typescript
entityDraftKey(collectionId, "elements")    // "<entityId>:<field>"; also "info", collectionAuthDraftKey(id) for "auth"
put(key, { draft, baseline })               // useEntityDraft's setDraft / adopt, while the draft is dirty
drop(key, only?)                            // reset, a draft edited back clean, a save that landed
dropForEntities(entityIds)                  // closing a collection tab, deleting a collection subtree
const draftAuth = useCollectionAuthDraft(collectionId); // the Auth tab's unsaved pick, mounted or not
```

**Clean is absence.**
An entry exists only while its draft differs from the persisted value.
`baseline` is the persisted value the draft diverged from, so a change that lands while the editor is unmounted still arrives on the remount as `externalValue`, a conflict, rather than replacing the draft; an entry whose draft the persisted value has caught up with is a save that landed and is dropped.

**Who drops an entry.**
The editor (`useEntityDraft`'s `reset`, an edit back to the persisted value, the persisted value catching up after a save, or `markSaved` for a save that lands once the editor has gone), the save context's detached save once it lands (`useDraftSaveContext`), and `tabs-store`:
every close path (`closeTabsNow`, LRU eviction) drops the closed collection tabs' drafts, and `closeTabsForEntities` drops every id the delete names, descendants included, beside `clearEntity`.
The delete path cannot rely on `markRemoved`, whose ids are request-scoped, and a draft left behind would send its save at the deleted row on quit.

**A detached draft is read against the collections list.**
Once its editor is gone, nothing on screen compares the draft with what is stored, so the detached context does (`useDraftSaveContext`'s `stored`, built by `useStoredCollectionDraft` in `CollectionDetail/collection-drafts.ts`, which also defines the value each editor drafts against).
It watches the `collections.list` cache: a collection that leaves the list (an MCP `delete_collection`, a trash purge, another window) or a stored value that catches up with the draft drops the entry and discards the id, and a 404 from the detached save does the same after its failure toast.
A stored value that moved away from the draft's `baseline` is a conflict (#1437): the detached save declines as `pending` rather than write over it unseen, so the quit asks and the remount shows "Changed elsewhere".

**It replaced `collection-auth-draft-store.ts` (#1483).**
The Inheritance Chain card and the context bar's `CollectionAuthSection` read the stored collection, which says nothing about a mode picked and not yet saved.
`AuthTab` does not mirror its draft into a store of its own that clears on unmount: the draft outlives the tab, so the context bar would describe the saved auth while the tab stayed dirty.
Both read the entity draft store through `useCollectionAuthDraft` instead; `withDraftAuth` (`modules/request-builder/utils/auth-resolution.ts`) substitutes the pick into an ancestor chain before either reader calls `resolveAuthSource`, so a dirty pick and its own inheritance chain agree.
A reader tells "unsaved" from a just-saved entry with `isUnsavedAuthDraft` (same module), which compares the way the tab's `isDirty` does; both readers append "(unsaved)" only while that holds, because the engine composes from the stored row and a request below sends that until Save.

**Non-persisted**, deliberately: a draft can carry a credential, and an unsaved edit does not outlive the app - the quit flush saves it or asks.
