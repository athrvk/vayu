---
description: >-
  The hooks for auto-save and manual drafts: `useSaveManager`, `useEntityDraft`, `useDraftSaveContext` and how the request builder's draft adopts an external write.
---

# Save and draft hooks

## `useSaveManager()` - Auto-Save Manager

Orchestrates auto-save for a saveable entity (request, environment, etc.) with debouncing, context registration, and centralized save state tracking.
Located in `app/src/hooks/useSaveManager.ts`.

**API:**
```typescript
const {
  forceSave: () => Promise<void>
  status: "idle" | "pending" | "saving" | "error"  // this entity's own entry, not the Dock's
  isSaving: boolean                                // this entity's save is in flight
} = useSaveManager({
  entityId: string | null           // Unique ID for this entity
  contextName?: string              // Display name (e.g., "Request: GET /api")
  onSave: () => Promise<void>       // Function to persist changes
  hasChanges: boolean               // Whether unsaved changes exist
  changeToken: number               // Bumped by the caller on every edit
  enabled?: boolean                 // Disable auto-save (default: true)
});
```

**Features:**
- **Debounced auto-save:** Triggers after the delay the user chose in Settings → General, defaulting to 5000ms (`autoSave.delayMs` in `client-settings-store`, options in `constants/client-settings.ts`)
- **Context registration:** Automatically registers with `useSaveStore()` for app-wide Ctrl/Cmd+S integration and tab LRU coordination
- **Save status:** Reports to the centralized save store under `request-<id>`, which the Dock derives "Saving…" and "Saved" from.
  The `status` it returns is that one entry's (`idle` when there is none), never the Dock's app-wide one: `InfoPanel` keeps the description source open on `error`, and another surface's failure is not this request's (#3350)
- **Entity switching:** Flushes pending saves when entity ID changes (in cleanup, before unmounting)
- **Saves are queued, never skipped:** a caller arriving while another save is in flight waits behind it and gets its own write, so its promise resolves only once *its* edits are persisted.
  Skipping (the old behaviour) meant Cmd/Ctrl+S, the quit flush and the entity-switch flush all reported "saved" for edits that were never in the flying snapshot - and the switch then reset the provider, making them unrecoverable.
  `performSave` binds `onSaveRef.current` at call time rather than when the queue reaches it, so a save queued by the entity-switch cleanup still writes the entity being left
- **No `debounceMs` parameter:** the delay is a user preference, not a per-caller one, so the hook reads it from the store rather than taking it as an option.
  Turning auto-save off in Settings leaves the entity marked dirty - Ctrl/Cmd+S still saves it - but schedules nothing.
- **The delay runs from the last edit, and `changeToken` is what makes it a debounce** (#1381).
  `hasChanges` cannot carry that on its own: it is already `true` by the second keystroke, so an effect keyed on it does not re-run and the timer armed by the *first* keystroke runs to term.
  A save then went out five seconds into every burst carrying a half-typed script.
  The token changes on every edit, so each one tears the pending timer down and arms a fresh one
- **A returning save reports "Saved" only for the edits it carried** (#1381).
  The saver and the token are bound together when `performSave` is called; if the token has moved by the time the write lands, an edit arrived that the payload does not hold, and the status goes back to `pending` rather than flashing "Saved" over it.
  The caller is what re-arms the save - this only refuses to mislabel it

`app/src/config/timing.ts` carries no `AUTO_SAVE_DELAY_MS`: a constant nothing reads has no place as the source of truth.
`timing-keys-have-readers.test.ts` now fails on any TIMING key without a reader, and `useSaveManager.autosave-setting.test.tsx` pins the Settings value to the timer that actually runs.

**Usage:**
```typescript
const { forceSave, status, isSaving } = useSaveManager({
  entityId: requestId,
  contextName: `Request: ${request.method} ${request.url}`,
  onSave: () => apiService.updateRequest(requestId, changes),
  hasChanges: JSON.stringify(draft) !== JSON.stringify(saved),
  enabled: true
});
```

## `useEntityDraft()` - Manual Draft/Save Model

The other save model, and the counterpart to `useSaveManager()`: an editable draft, a Save button gated on `isDirty`, and a Reset that discards it.
Located in `app/src/hooks/useEntityDraft.ts`.
`CollectionDetail`'s `AuthTab` and `ElementsTab` (issue #1512) are its button users.

`InfoTab` uses the hook without the button: it wants the draft, the resync and the mutation reset, but commits when focus leaves the field, like the request builder.
`reset` therefore has fewer callers than `draft` has; `InfoTab` reaches the discard path through `adopt` instead.

**Why auth - and now Elements - keep the button (#446, #1512).**
Not because a credential or an element list outranks a plain field - the request builder autosaves its own auth through `useSaveManager`, as `InfoTab` does.
Because a blur is not a completion signal once a tab is more than one focus stop: an OAuth 2.0 config with Advanced open renders 20 focus stops, 9 of them non-value controls, and clicking reveal to check a half-typed password fires `focusout` while the draft is dirty - so a blur-commit would write half a credential to the record every descendant request inherits from.
The old `ScriptTab` had exactly one focus stop (its Monaco editor), so leaving it meant what leaving a description means - but `ElementsTab`'s `ElementList` is adding a kind, naming a row, toggling it, reordering it and editing its form, each a separate stop, and a `script.*` element's own editor inside the list would fire the identical half-typed-value blur.
The fields only make sense saved together, which is what the button means on both tabs now.
Should collection auth or elements ever persist by themselves, the mechanism is the debounce, not a blur - a different change from this one.
Both tabs state their save model above the fields, since they are the ones on that screen that differ.

**API:**
```typescript
const {
  draft: T                                 // The editable copy
  setDraft: Dispatch<SetStateAction<T>>    // Standard setState signature
  isDirty: boolean                         // Draft differs from the persisted value
  reset: () => void                        // Discard the draft, adopting the persisted value
  adopt: Dispatch<SetStateAction<T>>       // setDraft for taking a persisted value; landing on it from a dirty draft is a discard (#2033)
  consumeDiscard: () => boolean            // Was the last clean edge a reset or an adopt? Clears the answer (#1931)
  markSaved: (sent: T) => void             // Call from the editor's save once it lands; drops the stored draft if the editor has gone meanwhile (#3459)
  baseline: T                              // The value the draft last agreed with the server on
  externalValue: T | null                  // A persisted change pending while the draft is dirty
} = useEntityDraft<T>({
  entityKey: string                        // Identity of the thing being edited, and its entity-draft-store key
  value: T                                 // The persisted value
  mutation: { reset: () => void }          // The save mutation this editor reports through
});
```

**Behaviour:**
- **Seeds and resyncs while clean:** a clean draft follows `value` when it changes - a save landing, a background refetch.
  In `InfoTab` this is what clears the post-trim divergence, since the tab persists `name.trim()`.
  The request builder needs the same property for the same reason and gets it a different way, since its state is not a draft: see [the draft adopts an external write per field](#the-request-builders-draft-adopts-an-external-write-per-field).
- **A dirty draft is never silently overwritten (#1437).**
  While the draft disagrees with `baseline`, an incoming change to `value` is held in `externalValue` instead of reseeding `draft`, which would let an MCP `update_collection` landing mid-edit replace the user's unsaved text with whatever the agent wrote.
  `ElementsTab` and `AuthTab` treat `externalValue` as one value and show a "Changed elsewhere" `Callout` (`CollectionDetail/shared.tsx`'s `ExternalChangeCallout`) whose action calls `reset()` to take it.
  `InfoTab`'s draft has two independent fields, so it diffs `draft` and `externalValue` against `baseline` per key instead: a key the user has not touched adopts the external value immediately, the same as a clean tab; a key both sides touched surfaces its own conflict, named, and is left at the user's edit until they choose.
  Its per-key Take theirs calls `adopt`, not `setDraft` and not `reset` (which would take the other field too):
  while the draft stays dirty `adopt` leaves `baseline` and `externalValue` alone, so the other key's conflict survives, and it marks a discard only when the result equals the persisted value and the draft differed from it before - with the other field still dirty no clean edge follows to consume the mark, and the later real save would read as a discard.
- **Tracks by JSON value, not identity:** `value` may be a fresh object literal every render (`InfoTab` builds `{ name, description }` inline); callers do not have to memoize it.
- **`entityKey` is a switch, not an edit:** a change shows that entity's own draft (its stored one, or its persisted value) *and* calls `mutation.reset()`.
  The entity switched away from keeps its draft in the store, so going back to it restores the edit (#3459).
  These editors render without a React `key`, so a different entity arrives via props on the same instance, and a TanStack mutation holds `isError` until the next `mutate` - without the reset, a failed save is reported against an entity the user never tried to save.
  The keys come from `entityDraftKey`: `<collectionId>:elements` for the whole element list, `:info`, and `:auth` (`collectionAuthDraftKey`, which the context bar reads too).
- **Requiring the mutation is the point:** the three hand-rolled copies this replaced had drifted, and the one that omitted the reset had exactly that bug.

**Usage:**
```typescript
const { draft, setDraft, isDirty, reset } = useEntityDraft({
  entityKey: collectionAuthDraftKey(collection.id),
  value: collection.auth,
  mutation: updateCollection,
});
```

**The draft lives in `entity-draft-store`, not in the component (#3459).**
`Shell.tsx` mounts only the tab on screen, so clicking a request unmounted the whole collection screen and, with the draft in component state, threw an unsaved script away without a prompt.
The hook reads the draft from the store by `entityKey` (falling back to `value` when there is none) and writes it there on `setDraft`, `adopt`, `reset` and `markSaved`, so a remount picks up the edit where it was, dirty, with `baseline` intact: a change that landed meanwhile arrives as `externalValue`.
`useDraftSaveContext`'s `draftKey` keeps the save reachable while the editor is gone; see [`entity-draft-store.ts`](save-and-drafts.md#entity-draft-storets---unsaved-collection-drafts-that-outlive-their-editor) for who drops an entry.

`CollectionDetail` still force-mounts the three draft-holding tabs (Info, Auth, Elements) from their first visit onwards.
The draft no longer needs it; what does is what the store does not hold, the editors' own undo history and scroll position, across a look at a sibling.
The Variables tab is deliberately not force-mounted: it autosaves and claims the store's active context on mount, so keeping it alive behind another tab would point Ctrl/Cmd+S at the wrong editor.

## `useDraftSaveContext()` - Registering a Manual Draft

The counterpart to `useSaveManager`'s registration half, for editors using the `useEntityDraft` model.
Located in `app/src/hooks/useDraftSaveContext.ts`.
Used by `InfoTab`, `AuthTab` and `ElementsTab`.

```typescript
useDraftSaveContext({
  id: `collection-${collection.id}-auth`,  // Unique per editor
  name: `Collection auth: ${collection.name}`,
  isDirty,                                 // From useEntityDraft
  isActive: active,                        // Is this the tab on screen?
  save: persist,                           // Rejecting is how failure is reported
  consumeDiscard,                          // From useEntityDraft
  draftKey,                                // The entityKey: the context outlives the editor
});
```

**Behaviour:**
- **Registration only.**
  It schedules nothing; each editor decides when to call its own `save` - `AuthTab` and `ElementsTab` on their Save button, `InfoTab` when focus leaves the field.
  The defect it fixes is orthogonal to that choice: the *other* ways to save - Ctrl/Cmd+S, the quit flush, tab eviction - could not reach these editors at all, because none of the three tabs ever called `registerContext`.
- **`isActive` decides who owns Ctrl/Cmd+S.**
  `triggerSave` prefers the active context, and these editors stay mounted while hidden, so without it the last sibling to mount would answer for the panel on screen.
- **A failure toasts rather than resolving quietly.**
  The editors render an inline `SaveFailed` callout for a button press, but a quit flush has no callout on screen, and a resolved promise reads as success - swallowing here would report "Saved" for a write that failed.
  The registered save resolves with its verdict: `"failed"` after the toast, `"saved"` on success, and `"pending"` for a `SaveBlockedError`, which only marks the Dock "Unsaved changes" - no toast, no "Not saved" (the same reading `useSaveManager` gives it).
- **The save must carry its own validity guard.**
  A disabled button does not stop the store-driven paths, which is why `InfoTab` refuses a blank collection name inside `persist`.
  With its buttons gone that guard is now the only one, and it is silent by itself - the tab pairs it with `reportBlankNameRefused()` (`lib/blank-name.ts`), a toast raised once the tab has put the stored name back; with nothing left unsaved there is no "Not saved" to report.
- **`isDirty` also drives the Dock's "Unsaved changes" line (#1483).**
  The registry's own `hasPendingChanges` is not what the Dock reads - only the store's per-id reports are - so the hook calls `reportPending(id)` the moment `isDirty` turns true and `reportSaved(id)` the moment it turns false again, mirroring `useSaveManager`'s autosave editors.
  Edge-triggered, and reset rather than fired across an `id` change, so switching the entity a mounted editor describes never reports the previous entity's save as this one's.
- **A stored draft keeps its context after the editor goes (#3459).**
  On an unmount or an id switch, an editor that passed a `draftKey` and was dirty leaves its context registered (`detach`): still `hasPendingChanges`, so `isTabDirty` holds the tab and the quit flush and Ctrl/Cmd+S's fallback still reach it, and its id stays reported, so the Dock keeps "Unsaved changes".
  Its save is the editor's last `save`, which closed over the draft and over a mutation observer that still works unmounted.
  When that save lands the context and the stored draft both go; when the stored draft is dropped another way (the tab closed, the collection deleted) the context goes and the id is discarded.
  That includes a save the editor started on screen and that landed after it went: the editor's save calls `useEntityDraft`'s `markSaved`, which drops the entry only when no editor shows it (one that does sees the persisted value catch up instead, and dropping first would paint the old value for a frame, since the query cache notifies on a later tick).
  A remount under the same id takes the context back.
  Without a `draftKey` (the inbox reply, whose draft is component state), or for a clean draft or an id `markRemoved` names, the goodbye discards the id's report as before.
  On a remount over a dirty stored draft the rising edge reports it pending again.
- **A discard is not a save (#1931, #2033).**
  The clean edge is a save landing, a `useEntityDraft` `reset` (the Reset button, an external change's "Take theirs") or an `adopt` that lands on the persisted value (`InfoTab`'s per-field Take theirs).
  All three editors (`InfoTab`, `AuthTab`, `ElementsTab`) pass the draft's `consumeDiscard` as the hook's `consumeDiscard` option; when it says the edge was a discard the hook calls `discard(id)` instead, so the Dock returns to idle rather than flashing "Saved" for a write that never happened.
  `discard` removes only this id's report, so another context's edit or failure stays on the Dock.

## The request builder's draft adopts an external write per field

`RequestBuilderProvider` resets its whole draft when the request **id** changes, and neither a rename, an MCP agent's `update_request`, nor a move to another collection changes the id.
Before issue #1436, only `name` adopted a change that arrived this way - every other field held a snapshot taken when the tab opened, so a debounced auto-save could write that snapshot back over whatever an agent had just changed, a delete under a dirty tab flushed a doomed PUT into a 404, and a move discarded the whole draft along with the id-based reset it was routed through.

The fix generalizes the name's adoption into a per-field three-way merge, the same shape `useEntityDraft` (below) already uses for the collection tabs:

- **`baseline`** is the value the draft last agreed with the server on - not necessarily `request`, which is whatever the user has typed, and not necessarily what a stray refetch just reported either, if that report conflicts with an edit (see below).
- **`touchedFields`** is which top-level `RequestState` keys `setRequest` / `updateField` have written since that baseline.
  A successful save clears exactly the fields it sent; `takeExternalField` (below) clears one.
- On every `initialRequest` change (the request query's copy, gated on its object identity so the diff runs once per refetch and not once per keystroke),
  `mergeExternalWrite` (`app/src/lib/field-merge.ts`) diffs `initialRequest` against `baseline` over every mergeable field (`MergeableRequestField` - every `RequestState` key except `id`, `collectionId` and `disabledDefaultHeaders`, which have their own rules below):
  - a field the fetch did not change is left alone;
  - a field the fetch changed and the user has **not** touched adopts the new value into the draft, via `setRequestState` (never `setRequest` - adopting someone else's write is not an edit of ours, and marking it dirty would schedule a save that writes back what was just read) and `baseline` moves to match;
  - a field the fetch changed and the user **has** touched, to a *different* value than the fetch reports, is a conflict: the draft keeps the user's value, `baseline` is deliberately left where it was (so the conflict keeps being detected until it is resolved), and the incoming value is exposed on `fieldConflicts[field]`;
  - a touched field the fetch now agrees with (the save's own echo, or a coincidence) resolves quietly - `baseline` moves, nothing is shown;
  - a touched field the fetch reports at the value one of this builder's last two saves sent for it is that save's echo even when the draft has moved on (#3664):
    a keystroke landing during the `PUT`'s round trip leaves the draft ahead of the echo, and `handleSave` skips its bookkeeping for an unsettled save, so without this rule the echo read as a conflict whose "Take theirs" would revert the typing.
    `handleSave` appends the sent values to `recentSends` before it awaits `onSave` and keeps them after, since the cache write can land on either side of the resolve.
    Only while its own request is on screen (`shownMemoryKeyRef`, #3730): a goodbye flush starts after the switch, and its values in the next request's list would read an outside write of them there as an echo.
    The merge receives the list as `options.sent`, moves `baseline` to the echo, raises nothing, and leaves the field touched, so the next save sends the newer draft.
    Two saves, not one, because `useSaveManager` starts a queued save in the microtask after the first resolves, before the first's cache write has rendered.
    A save whose `onSave` rejects removes its own entry (by identity, since a later save may have appended): it has no echo, so an outside write of its value conflicts.
    The rule is keyed on the value, not on a save being in flight: an outside write in the same window, to any other value, still conflicts.
    The accepted limit is the converse: a settled save's values stay in the list until two later saves or a reset clear them, so an outside write equal to one of them reads as an echo and only moves `baseline`.
    `mergeExternalWrite` compares by JSON content, not by reference: `auth` and the other object fields are rebuilt into fresh objects on every fetch regardless of content, and `===` there would read every refetch as an external change - the same reason `useEntityDraft` compares by `JSON.stringify`.
    JSON content is not enough for the four key/value tables (`params`, `headers`, `formData`, `urlEncoded`, #3663):
    every conversion from storage gives each row a fresh ephemeral id and a spare blank row, so the save's own echo never matched and was adopted, replacing every row with a fresh-id copy (rows are keyed by id, so each remounted and the caret was lost), and an outside write to any field over an unsaved table edit raised a conflict on the table.
    The provider passes `mergeExternalWrite` a per-field equality (`options.equals`) that compares those tables as `sameRows` does (`components/shared/KeyValueEditor/key-value.ts`): the rows `toKeyValueEntries` would store, member by member, with the id and the blank rows out and the engine's member order ignored.
    When a table really is adopted (an untouched table an outside write changed, or "Take theirs"), `carryRowIds` gives each incoming row the id of the draft row it restates, by content and in order, and the spare row the draft's spare row id, so only the rows the write changed remount.
    The merge is skipped in a render that is a reset (a different request id or `initialResponse`, #3662): the reset seeds `baseline` and clears `touchedFields` for the request just loaded, and a merge in the same render would still read the previous request's touched fields and report them as conflicts.
- **`fieldConflicts`** and **`takeExternalField(field)`** are on `RequestBuilderContextValue`.
  `ExternalChangeNotice` (`request-builder/components/`) renders one `ExternalChangeCallout` per logical group - the five fields the editor splits a request's body across (`bodyMode`/`body`/`formData`/`urlEncoded`/`binaryFile`) count as one "body" group, so a body conflict does not paint five callouts - and its "Take theirs" resolves every field in the group.
- **`collectionId`** is not a mergeable field: a `collectionId`-only change with the same id (the `move_item` case) updates just that field in place, leaving the rest of a dirty draft untouched, in a dedicated branch beside the id-keyed full reset.
- **A request deleted elsewhere** stops `index.tsx` handing the provider an `initialRequest` at all, while keeping `RequestBuilderProvider` mounted (see below) so the draft is not lost.
  The provider notices `initialRequest` went missing while `request.id` is still set and flips `requestGone`, which feeds `useSaveManager`'s `enabled` - so a dirty draft's autosave timer, already armed or about to be, never fires a PUT against an id that now 404s.
  A delete made from the collection tree never reaches that state: it marks the ids removed (`markRemoved`) before the tabs close, and the tab's goodbye flush drops the draft instead of sending it (#3444).
- **The generation** `handleSave` checks (`changeTokenRef`, see the save-manager walkthrough below) bumps on a foreign write too, not only on the user's own edits - an effect keyed on `baseline`'s identity, not a direct write inside the merge itself:
  a ref write during the render phase is unsafe under React's rules (a render can be discarded or replayed) and is what this repo's `react-hooks/refs` lint rejects.
  Without the bump, a save already in flight when the merge adopts or conflicts a field could still clear `hasUnsavedChanges` over a value the merge just changed underneath its response.
- **`restoreStoredName()`** is unchanged in spirit but now reads `baseline.name` rather than a name-only ref: the Info tab's blank-name refusal needs the stored name back, and the baseline already holds it for every field, not just this one.

**The save payload only ever carries what `touchedFields` names** (`buildUpdatePayload` in `request-builder/index.tsx`): `onSave` receives `(request, changedFields)`, and an untouched field is omitted from the `PUT /requests/:id` body entirely - which the engine's merge-patch already reads as "leave the stored value alone" - rather than being resent unchanged.
The four body fields collapse into the wire's `body`/`bodyType` pair if any one of them was touched.
`name` keeps its own rule inside that: touched-but-blank still omits the key (a blank name is refused, not saved), for the reason the old comment gave - the debounced auto-save can fire while the field is briefly empty.

**`useUpdateRequestMutation`'s cache write also learned to lose a race** (`queries/collections.ts`): a foreign write's own refetch can land in the detail cache while this client's save is still in flight, and writing the save's response into the cache unconditionally could then overwrite the *newer* row with a stale one purely because the older write's round trip finished second.
The `onSuccess` handler now compares `updatedAt` (a `toISOString()` string end to end, so lexical and chronological order agree) and keeps whichever row is actually newer.

Guarded by `RequestBuilderProvider.name-sync.test.tsx` (the name-only case that started this), `RequestBuilderProvider.external-write-merge.test.tsx` (the general per-field merge, the move, the delete, and the generation bump),
`RequestBuilderProvider.save-generation.test.tsx` (the echo of a save an edit raced, landing before or after the save resolves or after a queued save started, and a failed save's value still conflicting),
`field-merge.test.ts` (`mergeExternalWrite` itself), `save-request-name.test.ts` and `request-builder.script-clearing.test.tsx` (the partial payload), and `collections.update-request-race.test.ts` (the cache race).
