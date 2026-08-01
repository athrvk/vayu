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
 * This is registration only. It does not schedule anything, and the Save button
 * stays the primary affordance: the manual model is a deliberate choice for
 * these editors (see `useEntityDraft`), and the defect was that the *other*
 * ways to save could not reach them.
 *
 * A failure on this path toasts through `failSave` rather than resolving
 * quietly. The editors render their own inline `SaveFailed` callout for a
 * button press, but a Cmd+S from another pane - or a quit flush with nothing on
 * screen at all - has no callout to read, and `runSave` in the save store treats
 * a resolved promise as a success. Swallowing here would report "Saved" for a
 * write that failed.
 */

import { useCallback, useEffect, useRef } from "react";

import { useSaveStore } from "@/stores/save-store";

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
	/** Persist the draft. Rejecting is how a failure is reported. */
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
	const failSave = useSaveStore((s) => s.failSave);

	// The registered save is bound once and reads the latest `save` when it runs,
	// so a keystroke does not have to re-register the context.
	const saveRef = useRef(save);
	useEffect(() => {
		saveRef.current = save;
	}, [save]);

	const runSave = useCallback(async () => {
		try {
			await saveRef.current();
		} catch (error) {
			failSave(error instanceof Error ? error.message : `Couldn't save ${name}`);
		}
	}, [failSave, name]);

	// Registration is deliberately independent of the dirty flag - it is pushed
	// by the effect below, which runs later in the same commit. Taking `isDirty`
	// as a dependency here would tear the context down and rebuild it on the
	// first keystroke.
	useEffect(() => {
		registerContext({ id, name, save: runSave, hasPendingChanges: false });
		return () => unregisterContext(id);
	}, [id, name, runSave, registerContext, unregisterContext]);

	useEffect(() => {
		updateContext(id, { hasPendingChanges: isDirty });
	}, [id, isDirty, updateContext]);

	useEffect(() => {
		if (isActive) setActiveContext(id);
	}, [id, isActive, setActiveContext]);
}
