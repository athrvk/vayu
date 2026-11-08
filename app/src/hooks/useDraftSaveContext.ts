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
 * A failure on this path is reported through `reportFailed` rather than
 * resolving quietly. The editors render their own inline `SaveFailed` callout
 * for a button press, but a Cmd+S from another pane - or a quit flush with
 * nothing on screen at all - has no callout to read, and a resolved promise
 * reads as a success. Swallowing here would report "Saved" for a write that
 * failed.
 *
 * The registered save also resolves with its verdict (`SaveOutcome`), which is
 * what the store counts.
 */

import { useCallback, useEffect, useRef } from "react";

import { isDiskFullError } from "@/lib/disk-full";
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
	 * A save that reports its own failure and resolves (the canned reply, whose
	 * Apply button shares this function) returns the verdict instead, or the
	 * resolution reads as `saved`.
	 */
	save: () => Promise<SaveOutcome | void>;
	/**
	 * Asked on every dirty-to-clean edge: true when the draft was thrown away
	 * (`useEntityDraft`'s `consumeDiscard`), so the Dock goes idle rather than
	 * reporting a save that never happened. Omitted, every clean edge is a save.
	 */
	consumeDiscard?: () => boolean;
}

export function useDraftSaveContext({
	id,
	name,
	isDirty,
	isActive,
	save,
	consumeDiscard,
}: DraftSaveContextOptions): void {
	const registerContext = useSaveStore((s) => s.registerContext);
	const unregisterContext = useSaveStore((s) => s.unregisterContext);
	const updateContext = useSaveStore((s) => s.updateContext);
	const setActiveContext = useSaveStore((s) => s.setActiveContext);
	const reportPending = useSaveStore((s) => s.reportPending);
	const reportSaved = useSaveStore((s) => s.reportSaved);
	const reportFailed = useSaveStore((s) => s.reportFailed);
	const discard = useSaveStore((s) => s.discard);

	// The registered save is bound once and reads the latest `save` when it runs,
	// so a keystroke does not have to re-register the context.
	const saveRef = useRef(save);
	useEffect(() => {
		saveRef.current = save;
	}, [save]);

	const runSave = useCallback(async (): Promise<SaveOutcome> => {
		try {
			return (await saveRef.current()) ?? "saved";
		} catch (error) {
			// The editor chose not to send (an incomplete element): not a failure, so
			// no toast and no "Not saved" - the edit is still unsaved, which is what
			// `pending` says. Mirrors `useSaveManager`.
			if (error instanceof SaveBlockedError) {
				reportPending(id);
				return "pending";
			}
			const fallback = `Couldn't save ${name}`;
			reportFailed(
				id,
				error instanceof Error ? `${fallback} - ${error.message}` : fallback,
				error
			);
			return isDiskFullError(error) ? "disk-full" : "failed";
		}
	}, [id, name, reportFailed, reportPending]);

	// Registration is deliberately independent of the dirty flag - it is pushed
	// by the effect below, which runs later in the same commit. Taking `isDirty`
	// as a dependency here would tear the context down and rebuild it on the
	// first keystroke.
	useEffect(() => {
		registerContext({ id, name, save: runSave, hasPendingChanges: false });
		return () => unregisterContext(id);
	}, [id, name, runSave, registerContext, unregisterContext]);

	// The draft goes with its id: a switch reseeds it (`useEntityDraft`) and an
	// unmount drops it, so nothing is left for this id's report to describe.
	// Its own effect, keyed on `id` alone, because the registration above also
	// re-runs on a rename, which drops no draft.
	useEffect(() => () => discard(id), [id, discard]);

	// Reports the registry entry's dirty flag under this id, which is what the
	// Dock's "Unsaved changes" is derived from (`hasPendingChanges` on a context
	// is not consulted there - see save-store.ts). Edge-triggered on `isDirty`,
	// and guarded on `id` staying the same: a context switching entities
	// (collection.id changing) reseeds cleanly rather than reporting the
	// *previous* entity's dirty-to-clean transition as this one's save
	// completing.
	// Seeded `isDirty: false` regardless of the actual first render, so an
	// editor that somehow mounts already dirty still reports the rising edge
	// instead of silently agreeing with itself that nothing changed.
	const prevRef = useRef({ id, isDirty: false });
	useEffect(() => {
		updateContext(id, { hasPendingChanges: isDirty });
		// Consumed on every run, not only on the falling edge, so a mark that no
		// edge claimed (an id switch landing with it) cannot colour a later save.
		const discarded = consumeDiscard?.() ?? false;
		const prev = prevRef.current;
		if (prev.id === id) {
			if (isDirty && !prev.isDirty) reportPending(id);
			else if (!isDirty && prev.isDirty) {
				if (discarded) discard(id);
				else reportSaved(id);
			}
		}
		prevRef.current = { id, isDirty };
	}, [id, isDirty, consumeDiscard, updateContext, reportPending, reportSaved, discard]);

	useEffect(() => {
		if (isActive) setActiveContext(id);
	}, [id, isActive, setActiveContext]);
}
