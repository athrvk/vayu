/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * useDraftSaveContext - registration for the manual save-button model.
 *
 * `useSaveManager` registers the autosave editors with the save store. The
 * `useEntityDraft` editors had no counterpart: they never called
 * `registerContext`, so `triggerSave` (Ctrl/Cmd+S) and `flushAll` (the quit
 * flush, tab eviction) could not see them at all. A collection's auth, its
 * description, its scripts - all dirty, all invisible, all gone on quit.
 *
 * This is registration only. It does not schedule anything: each editor decides
 * when to call its own `save` - `AuthTab` on its Save button, `InfoTab` and
 * `ScriptTab` when focus leaves the field (see `useEntityDraft` for why auth is
 * the one that waits). The defect this fixes is orthogonal to that choice: the
 * *other* ways to save could not reach any of them.
 *
 * A failure on this path toasts through `failSave` rather than resolving
 * quietly. The editors render their own inline `SaveFailed` callout for a
 * button press, but a Cmd+S from another pane - or a quit flush with nothing on
 * screen at all - has no callout to read, and a resolved promise reads as a
 * success. Swallowing here would report "Saved" for a write that failed.
 *
 * The registered save also resolves with its verdict (`SaveOutcome`), so the
 * store counts this editor's own result rather than the shared status.
 */

import { useCallback, useEffect, useRef } from "react";

import { SaveBlockedError } from "@/lib/elements";
import { useSaveStore, type SaveOutcome } from "@/stores/save-store";

interface DraftSaveContextOptions {
	/** Unique id for this editor, e.g. `collection-<id>-auth`. */
	id: string;
	/** Human-readable name, shown wherever a save context is named. */
	name: string;
	/** Whether the draft differs from the persisted value. */
	isDirty: boolean;
	/**
	 * Whether this editor is the one the user is looking at. Only the active
	 * editor claims the store's active context, so Ctrl/Cmd+S saves the panel on
	 * screen rather than whichever sibling mounted last - these editors are kept
	 * mounted while hidden precisely so their drafts survive a tab switch.
	 */
	isActive: boolean;
	/**
	 * Persist the draft. Rejecting is how a failure is reported; rejecting with
	 * `SaveBlockedError` says the edit was deliberately not sent and is still unsaved.
	 */
	save: () => Promise<void>;
}

export function useDraftSaveContext({
	id,
	name,
	isDirty,
	isActive,
	save,
}: DraftSaveContextOptions): void {
	const registerContext = useSaveStore((s) => s.registerContext);
	const unregisterContext = useSaveStore((s) => s.unregisterContext);
	const updateContext = useSaveStore((s) => s.updateContext);
	const setActiveContext = useSaveStore((s) => s.setActiveContext);
	const markPendingSave = useSaveStore((s) => s.markPendingSave);
	const completeSaveThenIdle = useSaveStore((s) => s.completeSaveThenIdle);
	const failSave = useSaveStore((s) => s.failSave);

	// The registered save is bound once and reads the latest `save` when it runs,
	// so a keystroke does not have to re-register the context.
	const saveRef = useRef(save);
	useEffect(() => {
		saveRef.current = save;
	}, [save]);

	const runSave = useCallback(async (): Promise<SaveOutcome> => {
		try {
			await saveRef.current();
			return "saved";
		} catch (error) {
			// The editor chose not to send (an incomplete element): not a failure, so
			// no toast and no "Not saved" - the edit is still unsaved, which is what
			// `pending` says. Mirrors `useSaveManager`.
			if (error instanceof SaveBlockedError) {
				markPendingSave();
				return "pending";
			}
			const fallback = `Couldn't save ${name}`;
			failSave(error instanceof Error ? `${fallback} - ${error.message}` : fallback);
			return "failed";
		}
	}, [failSave, markPendingSave, name]);

	// Registration is deliberately independent of the dirty flag - it is pushed
	// by the effect below, which runs later in the same commit. Taking `isDirty`
	// as a dependency here would tear the context down and rebuild it on the
	// first keystroke.
	useEffect(() => {
		registerContext({ id, name, save: runSave, hasPendingChanges: false });
		return () => unregisterContext(id);
	}, [id, name, runSave, registerContext, unregisterContext]);

	// Mirrors the registry entry's dirty flag onto the store-wide `status`, which
	// is what the Dock actually reads for "Unsaved changes" (`hasPendingChanges`
	// on a context is not consulted there - see save-store.ts). Without this,
	// `useSaveManager`'s autosave editors lit the Dock on every keystroke and
	// these three never did at all. Edge-triggered on `isDirty`, and guarded on
	// `id` staying the same: a context switching entities (collection.id
	// changing) reseeds cleanly rather than reporting the *previous* entity's
	// dirty-to-clean transition as this one's save completing.
	// Seeded `isDirty: false` regardless of the actual first render, so an
	// editor that somehow mounts already dirty still reports the rising edge
	// instead of silently agreeing with itself that nothing changed.
	const prevRef = useRef({ id, isDirty: false });
	useEffect(() => {
		updateContext(id, { hasPendingChanges: isDirty });
		const prev = prevRef.current;
		if (prev.id === id) {
			if (isDirty && !prev.isDirty) markPendingSave();
			else if (!isDirty && prev.isDirty) completeSaveThenIdle(id);
		}
		prevRef.current = { id, isDirty };
	}, [id, isDirty, updateContext, markPendingSave, completeSaveThenIdle]);

	useEffect(() => {
		if (isActive) setActiveContext(id);
	}, [id, isActive, setActiveContext]);
}
