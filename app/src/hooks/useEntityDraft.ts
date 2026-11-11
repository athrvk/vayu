/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * useEntityDraft - the manual save-button model, in one place.
 *
 * Two save models exist in this app. `useSaveManager` is the autosave one the
 * request builder uses. This is the other one: an editable draft, a Save button
 * gated on `isDirty`, and a Reset that throws the draft away. `AuthTab` and
 * `ElementsTab` are its button users.
 *
 * `InfoTab` takes the draft, the resync and the mutation reset from here and
 * renders no Save button at all - it commits when focus leaves the field, like
 * the request builder. `reset` therefore has fewer callers than `draft`;
 * `InfoTab` reaches the discard path through `adopt`.
 *
 * **The draft lives in `entity-draft-store`, not in the component (#3459).**
 * `Shell.tsx` mounts only the tab on screen, so a draft in component state was
 * thrown away by a look at a request. The store holds it by `entityKey`, so a
 * remount, or a switch back to an entity shown earlier, picks up where the
 * edit was; `useDraftSaveContext` keeps the save reachable meanwhile.
 *
 * **Why auth alone kept the button (#446).** Not because a credential is
 * grander than a script - the request builder autosaves its own auth. Because a
 * blur inside `AuthFields` is not a completion signal: an OAuth 2.0 config with
 * Advanced open renders 20 focus stops, 9 of them non-value controls (pickers,
 * switches, the reveal toggle, Get Token), and clicking reveal to check a
 * half-typed password fires `focusout` while the draft is dirty. The fields
 * only make sense written together. A script tab has exactly one focus stop, so
 * leaving it means the same thing leaving a description does. If collection
 * auth is ever to persist by itself, the mechanism is `useSaveManager`'s
 * debounce, not a blur - a different change from this one.
 *
 * The mechanism was hand-rolled once per tab (`AuthTab`, `InfoTab`,
 * `ScriptTab`) with the same five moving parts each time, and the copies had
 * already drifted: two cleared the save mutation on a collection switch and one
 * did not, so a failure on one collection kept claiming to have failed on the
 * next. Folding the mutation reset into the hook is the point - it makes that
 * omission unrepresentable rather than merely absent.
 *
 * **A dirty draft is never silently overwritten (#1437).** The resync used to
 * fire on every change to `value` regardless of `isDirty`, so an MCP
 * `update_collection` landing while a tab was mid-edit replaced the user's
 * unsaved text with whatever the agent wrote. Now a resync only adopts the new
 * value while the draft is clean; while it is dirty, the incoming value is
 * held in `externalValue` instead of overwriting `draft`, and the caller
 * decides what to show. `baseline` - the value the draft last agreed with the
 * server on - is exposed alongside it so a caller with more than one field
 * (`InfoTab`'s `{name, description}`) can diff `draft` and `externalValue`
 * against it and merge per key, rather than treating the whole draft as one
 * conflict.
 *
 * ```ts
 * const { draft, setDraft, isDirty, reset } = useEntityDraft({
 *   entityKey: collectionAuthDraftKey(collection.id),
 *   value: collection.auth,
 *   mutation: updateCollection,
 * });
 * ```
 */

import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";

import { useEntityDraftStore, type EntityDraftEntry } from "@/stores/entity-draft-store";

interface EntityDraftOptions<T> {
	/**
	 * Identity of the thing being edited, and the key its draft is stored under
	 * (`entityDraftKey`). A change here is a *switch* (a different collection),
	 * not an edit: the draft shown becomes that entity's own, and the save
	 * mutation's error state is cleared.
	 */
	entityKey: string;
	/**
	 * The persisted value: what the draft starts from, falls back to, and is
	 * compared against. May be a fresh object literal every render - the hook
	 * tracks it by JSON value, not by identity, so callers do not have to
	 * memoize it.
	 */
	value: T;
	/**
	 * The save mutation this editor reports through. Only `reset` is used, and
	 * only on a switch. Required, not optional: the copy that forgot it is the
	 * bug this hook exists to prevent.
	 */
	mutation: { reset: () => void };
}

interface EntityDraft<T> {
	draft: T;
	setDraft: Dispatch<SetStateAction<T>>;
	isDirty: boolean;
	/** Throw the draft away and go back to the persisted value. */
	reset: () => void;
	/**
	 * `setDraft` for taking a persisted value into the draft (`InfoTab`'s per-key
	 * Take theirs). When that leaves the draft equal to the persisted value, the
	 * clean edge is a discard, not a save: `consumeDiscard` reports it. While
	 * the draft stays dirty, `baseline` and `externalValue` are left alone.
	 */
	adopt: Dispatch<SetStateAction<T>>;
	/**
	 * Whether the draft going clean was a `reset` or an `adopt` rather than a save
	 * landing, and clears that answer. Pass it to `useDraftSaveContext` so the Dock reports a
	 * discard as idle instead of "Saved" (#1931).
	 */
	consumeDiscard: () => boolean;
	/**
	 * Tell the hook a save of `sent` landed; call it from the editor's own save.
	 * While the editor shows this entity the persisted value catching up says
	 * the same thing, so this does nothing. Once it does not (unmounted, or
	 * switched to another entity while the save was out) this is the only notice
	 * the stored draft gets, and an entry still equal to `sent` is dropped.
	 */
	markSaved: (sent: T) => void;
	/**
	 * The persisted value the draft last agreed with the server on. A caller
	 * that merges by field (`InfoTab`'s `{name, description}`) diffs `draft`
	 * and `externalValue` against this to tell which side touched which key; a
	 * caller that treats the draft as one value (a script, an auth config) has
	 * no use for it.
	 */
	baseline: T;
	/**
	 * A persisted value that arrived while the draft was dirty, not yet
	 * adopted - null when nothing is pending. Set instead of silently
	 * overwriting `draft`, so the caller can show what changed underneath and
	 * let the user take it. A change that lands while the editor is unmounted
	 * arrives here too, on the remount.
	 */
	externalValue: T | null;
}

/**
 * The stored entry, unless the persisted value has caught up with its draft:
 * that is a save that landed - this editor's, or one made while it was
 * unmounted - and it describes nothing unsaved.
 */
function heldEntry<T>(
	entry: EntityDraftEntry<T> | undefined,
	serializedValue: string
): EntityDraftEntry<T> | undefined {
	return entry && JSON.stringify(entry.draft) !== serializedValue ? entry : undefined;
}

const resolve = <T>(next: SetStateAction<T>, previous: T): T =>
	typeof next === "function" ? (next as (prev: T) => T)(previous) : next;

export function useEntityDraft<T>({
	entityKey,
	value,
	mutation,
}: EntityDraftOptions<T>): EntityDraft<T> {
	// The whole hook keys off this rather than off `value`'s identity. Callers
	// pass anything from a plain array (ElementsTab) to an object built inline
	// per render (InfoTab's `{ name, description }`).
	const serializedValue = JSON.stringify(value);

	const stored = useEntityDraftStore((s) => s.entries.get(entityKey)) as
		EntityDraftEntry<T> | undefined;
	const held = heldEntry(stored, serializedValue);

	// Latest persisted value, reachable from the callbacks without being a
	// dependency of them.
	const valueRef = useRef(value);
	useEffect(() => {
		valueRef.current = value;
	});

	// The callbacks read the store, not the render's `held`: two calls in one
	// batch (InfoTab's two adopts) must each see what the other wrote.
	const liveEntry = useCallback(
		() =>
			heldEntry(
				useEntityDraftStore.getState().entries.get(entityKey) as
					EntityDraftEntry<T> | undefined,
				JSON.stringify(valueRef.current)
			),
		[entityKey]
	);

	const write = useCallback(
		(next: T) => {
			const persisted = valueRef.current;
			const store = useEntityDraftStore.getState();
			if (JSON.stringify(next) === JSON.stringify(persisted)) {
				store.drop(entityKey);
				return;
			}
			// The baseline stays what the draft first diverged from, so a value
			// that changed underneath since is still a conflict (#1437).
			store.put(entityKey, { draft: next, baseline: liveEntry()?.baseline ?? persisted });
		},
		[entityKey, liveEntry]
	);

	const setDraft = useCallback(
		(next: SetStateAction<T>) => write(resolve(next, liveEntry()?.draft ?? valueRef.current)),
		[write, liveEntry]
	);

	// The "own save landed" case: the persisted value now equals the draft, so
	// the entry is spent. Dropped only if it is still the entry this render read,
	// so an edit made since survives.
	useEffect(() => {
		if (stored && !held) useEntityDraftStore.getState().drop(entityKey, stored);
	}, [entityKey, stored, held]);

	// The other half of the switch. These editors are rendered without a `key`,
	// so a different entity arrives via props on the same component instance -
	// and a TanStack mutation holds `isError` until the next `mutate`. Without
	// this, a failed save would keep being reported against an entity the user
	// never tried to save. `reset` is bound once in the observer, so it is a
	// stable dep.
	const resetSave = mutation.reset;
	useEffect(() => {
		resetSave();
	}, [entityKey, resetSave]);

	// Set only when `reset` actually discards an edit: resetting a clean draft
	// produces no dirty-to-clean edge to consume it, and a mark left behind
	// would make the next real save read as a discard.
	const discardedRef = useRef(false);
	const reset = useCallback(() => {
		if (liveEntry()) discardedRef.current = true;
		useEntityDraftStore.getState().drop(entityKey);
	}, [entityKey, liveEntry]);

	// Takes a value from the persisted side into the draft (`InfoTab`'s per-key
	// Take theirs). Marked a discard only when it lands exactly on the persisted
	// value from a dirty draft: with another field still dirty no clean edge
	// follows to consume the mark, and the later real save would read as a
	// discard.
	const adopt = useCallback(
		(next: SetStateAction<T>) => {
			const entry = liveEntry();
			const resolved = resolve(next, entry?.draft ?? valueRef.current);
			if (entry && JSON.stringify(resolved) === JSON.stringify(valueRef.current)) {
				discardedRef.current = true;
			}
			write(resolved);
		},
		[liveEntry, write]
	);

	// The entity on screen, or null once the editor has unmounted.
	const shownKeyRef = useRef<string | null>(entityKey);
	useEffect(() => {
		shownKeyRef.current = entityKey;
		return () => {
			shownKeyRef.current = null;
		};
	}, [entityKey]);

	// Dropping the entry while the editor shows it would paint the old value
	// for a frame: the query cache tells its observers on a later tick than
	// this store does.
	const markSaved = useCallback(
		(sent: T) => {
			if (shownKeyRef.current === entityKey) return;
			const entry = useEntityDraftStore.getState().entries.get(entityKey);
			if (entry && JSON.stringify(entry.draft) === JSON.stringify(sent)) {
				useEntityDraftStore.getState().drop(entityKey, entry);
			}
		},
		[entityKey]
	);

	const consumeDiscard = useCallback(() => {
		const discarded = discardedRef.current;
		discardedRef.current = false;
		return discarded;
	}, []);

	return {
		draft: held ? held.draft : value,
		setDraft,
		isDirty: held !== undefined,
		reset,
		adopt,
		consumeDiscard,
		markSaved,
		baseline: held ? held.baseline : value,
		externalValue: held && JSON.stringify(held.baseline) !== serializedValue ? value : null,
	};
}
