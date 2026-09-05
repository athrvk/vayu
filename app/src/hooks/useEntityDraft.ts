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
 * gated on `isDirty`, and a Reset that throws the draft away. `AuthTab` is its
 * one remaining button user.
 *
 * `InfoTab` and `ScriptTab` take the draft, the resync and the mutation reset
 * from here and render no Save button at all - they commit when focus leaves
 * the field, like the request builder. `reset` therefore has one caller, where
 * `draft` has three.
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
 *   entityKey: collection.id,
 *   value: collection.auth,
 *   mutation: updateCollection,
 * });
 * ```
 */

import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type Dispatch,
	type SetStateAction,
} from "react";

interface EntityDraftOptions<T> {
	/**
	 * Identity of the thing being edited. A change here is a *switch* (a
	 * different collection, a different script kind), not an edit - it clears
	 * the save mutation's error state as well as reseeding the draft.
	 */
	entityKey: string;
	/**
	 * The persisted value: what the draft is seeded from, resynced to, and
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
	 * let the user take it.
	 */
	externalValue: T | null;
}

export function useEntityDraft<T>({
	entityKey,
	value,
	mutation,
}: EntityDraftOptions<T>): EntityDraft<T> {
	// The whole hook keys off this rather than off `value`'s identity. Callers
	// pass anything from a plain string (ScriptTab) to an object built inline
	// per render (InfoTab's `{ name, description }`); with `value` as an effect
	// dep the latter would resync on every render forever.
	const serializedValue = JSON.stringify(value);

	const [draft, setDraft] = useState<T>(value);
	const [baseline, setBaseline] = useState<T>(value);
	const [externalValue, setExternalValue] = useState<T | null>(null);

	// Latest persisted value, reachable from the effects and from `reset`
	// without being a dependency of either. Synced in its own effect - written
	// before the resync effect below, which runs after it in declaration order.
	const valueRef = useRef(value);
	useEffect(() => {
		valueRef.current = value;
	});

	// Mirrors `draft` the same way `valueRef` mirrors `value`, so the resync
	// effect can read the draft as it stands without taking a dependency on it
	// - which would run the effect on every keystroke instead of only when the
	// entity or the persisted value changes.
	const draftRef = useRef(draft);
	useEffect(() => {
		draftRef.current = draft;
	});

	// `baseline` as of just before this render's resync effect runs - a ref
	// rather than reading the `baseline` state directly, for the same
	// "effect never reads the state it writes" reason as `draftRef`.
	const baselineRef = useRef(value);
	const prevEntityKeyRef = useRef(entityKey);

	const syncTo = useCallback((next: T) => {
		baselineRef.current = next;
		setBaseline(next);
		setExternalValue(null);
	}, []);

	// Reseed when the entity switches, or - while the draft is clean - when
	// the persisted value changes under us (a save lands, a background refetch
	// arrives). A *dirty* draft is never reseeded out from under an edit
	// (#1437): the change is held in `externalValue` instead, for the caller
	// to show and let the user adopt.
	useEffect(() => {
		const switched = prevEntityKeyRef.current !== entityKey;
		prevEntityKeyRef.current = entityKey;

		if (switched) {
			syncTo(valueRef.current);
			setDraft(valueRef.current);
			return;
		}

		const previousBaseline = JSON.stringify(baselineRef.current);
		if (serializedValue === previousBaseline) {
			// Nothing changed since our last sync - including a pending external
			// change that has since reverted to exactly what we started from.
			setExternalValue(null);
			return;
		}

		const draftSerialized = JSON.stringify(draftRef.current);

		if (draftSerialized === serializedValue) {
			// The draft already matches the fresh value - our own save landed.
			syncTo(valueRef.current);
			return;
		}

		if (draftSerialized === previousBaseline) {
			// The draft was clean: adopt the change, as before.
			syncTo(valueRef.current);
			setDraft(valueRef.current);
			return;
		}

		// Dirty, and the change conflicts with the in-progress edit: keep the
		// draft, surface the pending value instead of discarding it.
		setExternalValue(valueRef.current);
	}, [entityKey, serializedValue, syncTo]);

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

	const reset = useCallback(() => {
		setDraft(valueRef.current);
		syncTo(valueRef.current);
	}, [syncTo]);

	return {
		draft,
		setDraft,
		isDirty: JSON.stringify(draft) !== serializedValue,
		reset,
		baseline,
		externalValue,
	};
}
