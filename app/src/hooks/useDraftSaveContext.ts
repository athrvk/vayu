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
 *
 * **A stored draft keeps its context after the editor goes (#3459).** Given
 * `stored`, an editor that unmounts or switches id while dirty leaves its
 * context registered (`detach`): the Dock keeps "Unsaved changes", the tab
 * stays dirty (`isTabDirty`), and the quit flush still saves the draft. Without
 * it (the inbox reply, whose draft is component state) the edit goes with the
 * editor, as it always has.
 */

import { useCallback, useEffect, useRef } from "react";

import { isDiskFullError } from "@/lib/disk-full";
import { SaveBlockedError } from "@/lib/elements";
import { isNotFoundError } from "@/lib/save-failure";
import { useEntityDraftStore } from "@/stores/entity-draft-store";
import { useSaveStore, type SaveOutcome } from "@/stores/save-store";

/**
 * What is persisted for a stored draft's entity right now, read from outside
 * the editor: the value, `"gone"` once the entity no longer exists, or
 * `undefined` while that is not known (nothing loaded).
 */
export type PersistedReading = { value: unknown } | "gone" | undefined;

/** A draft kept in `entity-draft-store`, and how to read what it is a draft of. */
export interface StoredDraft {
	/** The `useEntityDraft` key the draft is stored under. */
	key: string;
	read: () => PersistedReading;
	/** Calls `onChange` whenever `read` may answer differently; returns the unsubscribe. */
	subscribe: (onChange: () => void) => () => void;
}

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
	 * screen rather than whichever sibling mounted last - `CollectionDetail`
	 * keeps a visited editor mounted while another of its sub-tabs is showing.
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
	/**
	 * Where the draft is stored. Given, the context outlives the editor for as
	 * long as that stored draft is unsaved - see `detach`. Omitted, the context
	 * goes with the editor.
	 */
	stored?: StoredDraft;
}

type DraftSave = () => Promise<SaveOutcome | void>;

// Runs an editor's save and reports a failure under its id; see the header for
// why a failure is reported rather than swallowed.
async function runDraftSave(id: string, name: string, save: DraftSave): Promise<SaveOutcome> {
	try {
		return (await save()) ?? "saved";
	} catch (error) {
		// The editor chose not to send (an incomplete element): not a failure, so
		// no toast and no "Not saved" - the edit is still unsaved, which is what
		// `pending` says. Mirrors `useSaveManager`.
		if (error instanceof SaveBlockedError) {
			useSaveStore.getState().reportPending(id);
			return "pending";
		}
		const fallback = `Couldn't save ${name}`;
		useSaveStore
			.getState()
			.reportFailed(
				id,
				error instanceof Error ? `${fallback} - ${error.message}` : fallback,
				error
			);
		return isDiskFullError(error) ? "disk-full" : "failed";
	}
}

// The ids whose editor let go of a dirty stored draft, each with what ends its
// detachment. A remount under the same id ends it before registering its own
// context, so a detached watch never outlives its context.
const detached = new Map<string, () => void>();

/**
 * Where a detached draft stands against what is persisted now. `spent` is a
 * draft nothing is left to save: its entry is gone (the tab closed, a late
 * save landed), its entity is gone (deleted elsewhere), or the persisted value
 * caught up with it (saved elsewhere). `conflict` is a change that landed after
 * the draft diverged, which the draft must not be written over unseen (#1437).
 */
function standingOf(stored: StoredDraft): "unsaved" | "conflict" | "spent" {
	const entry = useEntityDraftStore.getState().entries.get(stored.key);
	if (!entry) return "spent";
	const reading = stored.read();
	if (reading === undefined) return "unsaved";
	if (reading === "gone") return "spent";
	const persisted = JSON.stringify(reading.value);
	if (persisted === JSON.stringify(entry.draft)) return "spent";
	return persisted === JSON.stringify(entry.baseline) ? "unsaved" : "conflict";
}

/**
 * Keeps `id`'s context registered after its editor let go of a dirty stored
 * draft. Its save is the editor's last `save`, which closed over that draft and
 * over that editor's own mutation observer, which still works unmounted. When
 * it lands, the context and the entry go. While the draft is `spent` the
 * context, the entry and the id's report all go; while it is a `conflict` the
 * save declines, so the quit asks and the remount shows the change.
 */
function detach(id: string, name: string, stored: StoredDraft, save: DraftSave) {
	const saveStore = useSaveStore.getState;
	let unwatch = () => {};
	const end = () => {
		unwatch();
		detached.delete(id);
	};
	const letGo = () => {
		end();
		saveStore().unregisterContext(id);
		useEntityDraftStore.getState().drop(stored.key);
	};
	const release = () => {
		letGo();
		saveStore().discard(id);
	};
	const settle = () => {
		if (standingOf(stored) === "spent") release();
	};
	const watch = () => {
		const unwatchDraft = useEntityDraftStore.subscribe(settle);
		const unwatchPersisted = stored.subscribe(settle);
		unwatch = () => {
			unwatchDraft();
			unwatchPersisted();
		};
	};
	const detachedSave = async (): Promise<SaveOutcome> => {
		if (standingOf(stored) === "conflict") return "pending";
		// Unwatched while it runs: the editor's save drops the entry itself when
		// it lands (`markSaved`), and that is a save, not a discard.
		unwatch();
		let entityGone = false;
		const outcome = await runDraftSave(id, name, () =>
			save().catch((error: unknown) => {
				entityGone = isNotFoundError(error);
				throw error;
			})
		);
		// An editor that mounted again meanwhile owns the id now.
		if (saveStore().contexts.get(id)?.save !== detachedSave) return outcome;
		// A 404 is the entity deleted where the persisted reading has not seen
		// it yet: no retry can land, so the failure is a toast and no more.
		if (outcome === "saved") letGo();
		else if (entityGone || standingOf(stored) === "spent") release();
		else watch();
		return outcome;
	};
	saveStore().registerContext({ id, name, save: detachedSave, hasPendingChanges: true });
	watch();
	detached.set(id, end);
	// The editor may have let go because its entity is gone ("Collection not
	// found"), or after the persisted value caught up in the same commit.
	settle();
}

export function useDraftSaveContext({
	id,
	name,
	isDirty,
	isActive,
	save,
	consumeDiscard,
	stored,
}: DraftSaveContextOptions): void {
	const registerContext = useSaveStore((s) => s.registerContext);
	const unregisterContext = useSaveStore((s) => s.unregisterContext);
	const updateContext = useSaveStore((s) => s.updateContext);
	const setActiveContext = useSaveStore((s) => s.setActiveContext);
	const reportPending = useSaveStore((s) => s.reportPending);
	const reportSaved = useSaveStore((s) => s.reportSaved);
	const discard = useSaveStore((s) => s.discard);

	// The registered save is bound once and reads the latest `save` when it runs,
	// so a keystroke does not have to re-register the context.
	const saveRef = useRef(save);
	useEffect(() => {
		saveRef.current = save;
	}, [save]);

	const runSave = useCallback(() => runDraftSave(id, name, saveRef.current), [id, name]);

	// Registration is deliberately independent of the dirty flag - it is pushed
	// by the effect below, which runs later in the same commit. Taking `isDirty`
	// as a dependency here would tear the context down and rebuild it on the
	// first keystroke.
	useEffect(() => {
		detached.get(id)?.();
		registerContext({ id, name, save: runSave, hasPendingChanges: false });
		return () => unregisterContext(id);
	}, [id, name, runSave, registerContext, unregisterContext]);

	// What the goodbye below needs to know about the id that is leaving. React
	// runs every cleanup of a commit before any effect of it, so in that cleanup
	// this still describes the outgoing id rather than the one replacing it.
	const committed = useRef({ id, name, isDirty, stored, save });
	useEffect(() => {
		committed.current = { id, name, isDirty, stored, save };
	});

	// The goodbye, on an unmount or an id switch: a dirty stored draft keeps
	// its context (`detach`); anything else has no edit left for this id's
	// report to describe. Its own effect, keyed on `id` alone, because the
	// registration above also re-runs on a rename, which leaves no draft.
	useEffect(
		() => () => {
			const {
				id: lastId,
				name: lastName,
				isDirty: wasDirty,
				stored: lastStored,
				save: lastSave,
			} = committed.current;
			const keep =
				lastStored !== undefined &&
				lastId === id &&
				wasDirty &&
				useEntityDraftStore.getState().entries.has(lastStored.key) &&
				!useSaveStore.getState().isRemoved(id);
			if (keep) detach(id, lastName, lastStored, lastSave);
			else discard(id);
		},
		[id, discard]
	);

	// Reports the registry entry's dirty flag under this id, which is what the
	// Dock's "Unsaved changes" is derived from (`hasPendingChanges` on a context
	// is not consulted there - see save-store.ts). Edge-triggered on `isDirty`,
	// and guarded on `id` staying the same: a context switching entities
	// (collection.id changing) never reports the *previous* entity's
	// dirty-to-clean transition as this one's save completing.
	// Seeded `isDirty: false` regardless of the actual first render, so an
	// editor that mounts already dirty - over a stored draft (#3459) - still
	// reports the rising edge instead of agreeing with itself that nothing
	// changed.
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
