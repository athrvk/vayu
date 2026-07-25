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
 */
interface SaveState {
	// Save status
	status: SaveStatus;
	lastSavedAt: number | null;

	// Pending save tracking
	pendingSaveId: string | null;

	// Active save context - the context that's currently focused/active
	activeContextId: string | null;

	// Registry of save contexts
	contexts: Map<string, SaveContext>;

	// Actions
	setStatus: (status: SaveStatus) => void;
	markPendingSave: (id: string) => void;
	startSaving: () => void;
	completeSave: () => void;
	failSave: (error: string) => void;
	clearError: () => void;
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
	// Internal helper - runs a save for the given context and updates store state.
	// Caller must own the in-progress guard if needed.
	const runSave = async (context: SaveContext) => {
		set({ status: "saving" });
		try {
			await context.save();
			set({
				status: "saved",
				lastSavedAt: Date.now(),
				pendingSaveId: null,
			});
			setTimeout(() => {
				// Only reset to idle if we're still in the "saved" state
				if (get().status === "saved") get().setStatus("idle");
			}, 2000);
		} catch (error) {
			get().failSave(error instanceof Error ? error.message : "Save failed");
		}
	};

	return {
		status: "idle",
		lastSavedAt: null,
		pendingSaveId: null,
		activeContextId: null,
		contexts: new Map(),

		setStatus: (status) => set({ status }),

		markPendingSave: (id) =>
			set({
				status: "pending",
				pendingSaveId: id,
			}),

		startSaving: () => set({ status: "saving" }),

		completeSave: () =>
			set({
				status: "saved",
				lastSavedAt: Date.now(),
				pendingSaveId: null,
			}),

		failSave: (error) => {
			set({ status: "error", pendingSaveId: null });
			useToastStore.getState().showToast(error, "error");
		},

		clearError: () => set({ status: "idle" }),

		reset: () =>
			set({
				status: "idle",
				lastSavedAt: null,
				pendingSaveId: null,
			}),

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
