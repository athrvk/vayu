/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Centralized Save Store
 *
 * Manages auto-save functionality across the app with:
 * - Debounced auto-save on changes
 * - Manual save (Ctrl/Cmd+S)
 * - Visual save status for UI feedback
 * - Save context registry for app-wide save handling
 */

/* global setTimeout */

import { create } from "zustand";

import { TIMING } from "@/config/timing";
import { useToastStore } from "./toast-store";

export type SaveStatus = "idle" | "pending" | "saving" | "saved" | "error";

/** Save context - represents a saveable entity in the app */
export interface SaveContext {
	/** Unique identifier for this save context */
	id: string;
	/** Human-readable name for the context (e.g., "Request", "Global Variables") */
	name: string;
	/** Function to perform the save */
	save: () => Promise<void>;
	/** Whether there are pending changes */
	hasPendingChanges: boolean;
}

/**
 * Every failure is reported by a toast, and `failSave` is the single place that
 * does it.
 *
 * Failures used to arrive on two different surfaces depending on which file you
 * were in: `showToast` in the dialogs, the dashboard, MCP and OAuth, and this
 * store -> the Dock everywhere else. Worse, "everywhere else" included things
 * that are not saves at all - `CollectionTree` routed a failed *delete* through
 * here, so deleting a collection and failing produced "Save failed - ...".
 *
 * Doing it here rather than at the call sites is deliberate: there were eight of
 * them, and a missed one is a failure that reports nowhere at all.
 *
 * This also removes the `errorMessage` field the store used to hold. Its only
 * reader was the Dock's error line, which this replaces; the copy re-exported
 * from `useSaveManager` already had no reader. Keeping a field nothing reads is
 * the defect this codebase hits most often, so it goes.
 *
 * `lastSavedAt` and `pendingSaveId` went the same way, for the same reason:
 * every match on either name was a write inside this file. `status` now has a
 * reader for all five of its values - the Dock renders `pending` as "Unsaved
 * changes", which is the only thing that says so anywhere when auto-save is
 * turned off. If a "Saved 2m ago" surface ever wants a timestamp back, it
 * arrives with that surface.
 */
interface SaveState {
	// Save status
	status: SaveStatus;

	// Active save context - the context that's currently focused/active
	activeContextId: string | null;

	// Registry of save contexts
	contexts: Map<string, SaveContext>;

	// Actions
	setStatus: (status: SaveStatus) => void;
	markPendingSave: () => void;
	startSaving: () => void;
	/**
	 * Report a successful save: `saved`, then back to `idle` once the indicator
	 * has been on screen for `TIMING.SAVED_STATUS_DURATION_MS`.
	 *
	 * This is the only way to report a success, because the reset is the half
	 * every caller got wrong. A bare `setTimeout(() => setStatus("idle"))` fires
	 * regardless of what happened in between, so it clears a failure another
	 * surface published to the Dock, or wipes a `pending` from an edit made since.
	 * `triggerSave` has always guarded its own reset this way; the five callers
	 * that hand-rolled the timer did not.
	 *
	 * `reportingContextId` names the registered context whose save this is, when
	 * there is one. A context's own `hasPendingChanges` is not consulted: the
	 * registry entry is refreshed by a React effect, so a context that has just
	 * written still reads dirty at the moment it reports. Every *other*
	 * registered context is consulted (see the implementation), and a direct
	 * writer - the collection tree's two renames, which register nothing - names
	 * nobody and is therefore measured against all of them.
	 */
	completeSaveThenIdle: (reportingContextId?: string) => void;
	failSave: (error: string) => void;
	reset: () => void;

	// Context management
	registerContext: (context: SaveContext) => void;
	unregisterContext: (id: string) => void;
	updateContext: (id: string, updates: Partial<Omit<SaveContext, "id">>) => void;
	setActiveContext: (id: string | null) => void;
	getActiveContext: () => SaveContext | null;

	// App-wide save trigger
	triggerSave: () => Promise<void>;

	/** Flush every registered context that has pending changes. Used before quit / on tab close. */
	flushAll: () => Promise<void>;
}

export const useSaveStore = create<SaveState>((set, get) => {
	// Bumped by every `completeSaveThenIdle`, so an armed reset can tell whether
	// it is still the most recent one. Module-local rather than store state: no
	// renderer reads it, and a field nothing renders is the defect this file's
	// history is made of.
	let idleResetGeneration = 0;

	// Internal helper - runs a save for the given context and updates store state.
	// Caller must own the in-progress guard if needed.
	const runSave = async (context: SaveContext) => {
		set({ status: "saving" });
		try {
			await context.save();
			// Resolving is not proof of success. Every registered context reports
			// its own failure through `failSave` and then resolves rather than
			// rejecting (`useSaveManager`, `SettingsMain`, `VariableTableEditor`
			// all do), so overwriting unconditionally turned a failed Cmd+S into
			// "Saved" - with the failure toast still on screen next to it.
			//
			// Nor is it proof of completeness (#1381). A context that saw an edit
			// land while its write was in flight publishes `pending`, because the
			// payload that went out does not hold that edit; overwriting *that*
			// put "Saved" on the Dock over an edit nobody had persisted, on the
			// two paths that come through here - Cmd+S and the quit flush.
			//
			// Both cases are the same rule: a status the context published for
			// itself is the truthful one, and this wrapper only fills in the
			// silence.
			const published = get().status;
			if (published === "error" || published === "pending") return;
			get().completeSaveThenIdle(context.id);
		} catch (error) {
			get().failSave(error instanceof Error ? error.message : "Save failed");
		}
	};

	return {
		status: "idle",
		activeContextId: null,
		contexts: new Map(),

		setStatus: (status) => set({ status }),

		markPendingSave: () => set({ status: "pending" }),

		startSaving: () => set({ status: "saving" }),

		completeSaveThenIdle: (reportingContextId) => {
			// "Saved" is a claim about the editor, not about one round trip. That
			// is the rule #1381 wrote for `runSave`, and `runSave` only covers the
			// contexts that go through it: a direct writer publishes its success
			// straight onto the one status the Dock renders, so renaming a folder
			// while the open request holds an unsaved edit said "Saved" - true of
			// the rename, false of everything else on screen.
			//
			// So a success is only `saved` when nothing else is dirty. `pending`
			// is the honest answer otherwise, and it is the Dock's "Unsaved
			// changes" - the context still holding the edit clears it when it
			// writes. Guarding here rather than at the call sites covers the ones
			// added later, which is the half a per-caller fix cannot do.
			const othersDirty = [...get().contexts.values()].some(
				(context) => context.id !== reportingContextId && context.hasPendingChanges
			);
			if (othersDirty) {
				set({ status: "pending" });
				return;
			}

			set({ status: "saved" });
			const armed = ++idleResetGeneration;
			setTimeout(() => {
				// Two conditions, and both are load-bearing. The status check keeps
				// this timer off a status somebody else published meanwhile. The
				// generation check keeps it off a *later* save's "saved": two saves
				// a second apart would otherwise have the first timer end the second
				// one's indicator early. `useSaveManager` hand-rolled the second half
				// as a `clearTimeout` of its own timer; it lives here now, so every
				// caller gets it.
				if (armed !== idleResetGeneration) return;
				if (get().status === "saved") get().setStatus("idle");
			}, TIMING.SAVED_STATUS_DURATION_MS);
		},

		failSave: (error) => {
			set({ status: "error" });
			useToastStore.getState().showToast(error, "error");
		},

		reset: () => set({ status: "idle" }),

		// Context management
		registerContext: (context) => {
			const newContexts = new Map(get().contexts);
			newContexts.set(context.id, context);
			set({ contexts: newContexts });
		},

		unregisterContext: (id) => {
			const newContexts = new Map(get().contexts);
			newContexts.delete(id);
			const activeContextId = get().activeContextId === id ? null : get().activeContextId;
			set({ contexts: newContexts, activeContextId });
		},

		updateContext: (id, updates) => {
			const contexts = get().contexts;
			const existing = contexts.get(id);
			if (existing) {
				const newContexts = new Map(contexts);
				newContexts.set(id, { ...existing, ...updates });
				set({ contexts: newContexts });
			}
		},

		setActiveContext: (id) => set({ activeContextId: id }),

		getActiveContext: () => {
			const { activeContextId, contexts } = get();
			if (!activeContextId) return null;
			return contexts.get(activeContextId) || null;
		},

		// App-wide save trigger (used by Ctrl/Cmd+S)
		triggerSave: async () => {
			const activeContext = get().getActiveContext();
			if (activeContext) {
				await runSave(activeContext);
				return;
			}
			// Fallback: save any context with pending changes
			for (const context of get().contexts.values()) {
				if (context.hasPendingChanges) {
					await runSave(context);
					return;
				}
			}
		},

		flushAll: async () => {
			const saves = [...get().contexts.values()]
				.filter((c) => c.hasPendingChanges)
				.map((c) => runSave(c));
			await Promise.all(saves);
		},
	};
});
