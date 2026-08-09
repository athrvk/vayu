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
 * `ScriptTab` use it because a credential or a script is a deliberate act with
 * a button, not a keystroke that persists itself.
 *
 * `InfoTab` no longer does. Its name and description commit on blur like the
 * request builder's, so it takes the draft, the resync and the mutation reset
 * from here and simply never renders a Save button - which is why `reset` has
 * one caller fewer than `draft` does.
 *
 * The mechanism was hand-rolled once per tab (`AuthTab`, `InfoTab`,
 * `ScriptTab`) with the same five moving parts each time, and the copies had
 * already drifted: two cleared the save mutation on a collection switch and one
 * did not, so a failure on one collection kept claiming to have failed on the
 * next. Folding the mutation reset into the hook is the point - it makes that
 * omission unrepresentable rather than merely absent.
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

	// Latest persisted value, reachable from the effects and from `reset`
	// without being a dependency of either. Synced in its own effect - written
	// before the resync effect below, which runs after it in declaration order.
	const valueRef = useRef(value);
	useEffect(() => {
		valueRef.current = value;
	});

	// Reseed when the entity switches, and when the persisted value changes
	// under us (a save lands, a background refetch arrives). Can't be derived:
	// the draft intentionally diverges from the persisted value between an edit
	// and its save, and a render-phase reset keyed on the value would miss a
	// switch to a different entity whose value happens to equal the draft.
	useEffect(() => {
		// The updater form is why this needs no `react-hooks/set-state-in-effect`
		// suppression, unlike the three copies it replaces: the effect never
		// reads the state it writes. It also keeps an unchanged draft
		// object-identical, so a resync that changes nothing (mount, an unrelated
		// prop churning) does not cost a render.
		setDraft((prev) => (JSON.stringify(prev) === serializedValue ? prev : valueRef.current));
	}, [entityKey, serializedValue]);

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
	}, []);

	return {
		draft,
		setDraft,
		isDirty: JSON.stringify(draft) !== serializedValue,
		reset,
	};
}
