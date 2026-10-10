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

/**
 * One context's verdict on one save, which is not the same thing as the
 * store-wide `status`: that is a single slot every surface publishes to, so two
 * contexts saving in the same tick overwrite each other's verdict.
 *
 * `pending` is a save the context declined to send (`SaveBlockedError`) or one
 * that left an edit behind: nothing failed, the edit is simply not on disk.
 *
 * `final` is a failure the engine will repeat for this payload (a 4xx, #1889):
 * the same as `failed` to every reader of the count, and the one a caller that
 * retries must not retry.
 */
export type SaveOutcome = "saved" | "failed" | "final" | "pending";

type FillIn = (context: SaveContext) => void;

/** Save context - represents a saveable entity in the app */
export interface SaveContext {
	/** Unique identifier for this save context */
	id: string;
	/** Human-readable name for the context (e.g., "Request", "Global Variables") */
	name: string;
	/**
	 * Function to perform the save. A context that reports its own verdict
	 * resolves with it; one that resolves with nothing is judged by the status it
	 * published (see `runSave`).
	 */
	save: () => Promise<SaveOutcome | void>;
	/** Whether there are pending changes */
	hasPendingChanges: boolean;
}

/**
 * Every failed *save* is reported by a toast, and `failSave` is the single place
 * that does it. Doing it here rather than at the call sites is deliberate: there
 * were eight of them, and a missed one is a failure that reports nowhere at all.
 *
 * Only a save belongs here. `failSave` also parks the Dock on "Not saved" until
 * the next successful save, so a failure that is not an unsaved edit - a failed
 * delete, create or duplicate - raises its own `showToast` instead; routed here
 * it leaves "Not saved" stuck on screen describing no edit at all.
 *
 * This also removed the `errorMessage` field the store used to hold, back when
 * its only reader was the Dock's error line: the toast replaced that line, and
 * a field nothing reads is the defect this codebase hits most often. It is
 * back (as `lastErrorMessage`) because the toast turned out not to be the
 * whole answer - it clears itself after ten seconds, and nothing on screen
 * says "still not saved" after that. The Dock's persistent status line reads
 * it now, so the field has the reader it lacked before.
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

	/**
	 * The reason the last `failSave` gave, for the Dock's persistent "Not
	 * saved" tooltip. Stale once `status` moves off `"error"` - nothing reads
	 * it in any other state - so no caller needs to clear it on success.
	 */
	lastErrorMessage: string | null;

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

	/**
	 * Flush every registered context that has pending changes, and report what
	 * happened. Used before quit / on tab close - the caller (`main.ts`, #1489)
	 * decides whether a failure or a still-pending edit is worth asking about
	 * before the window goes away, so this counts rather than swallows them.
	 */
	flushAll: () => Promise<{ saved: number; failed: number; pending: number }>;
}

export const useSaveStore = create<SaveState>((set, get) => {
	// Bumped by every `completeSaveThenIdle`, so an armed reset can tell whether
	// it is still the most recent one. Module-local rather than store state: no
	// renderer reads it, and a field nothing renders is the defect this file's
	// history is made of.
	let idleResetGeneration = 0;

	// Is any registered context holding an unsaved edit? `exceptId` leaves out
	// the context asking, which is the one entry that cannot be trusted at the
	// moment it asks: a context's `hasPendingChanges` is refreshed by an effect,
	// so its own still reads the pre-save `true` as its write lands.
	const dirtyContextExists = (exceptId?: string) =>
		[...get().contexts.values()].some(
			(context) => context.id !== exceptId && context.hasPendingChanges
		);

	// A context that reports no verdict is judged by the status it published for
	// itself: every such context reports its own failure through `failSave` and
	// then resolves rather than rejecting (`SettingsMain`, `VariableTableEditor`),
	// so resolving is not proof of success. Overwriting unconditionally turned a
	// failed Cmd+S into "Saved" - with the failure toast still on screen next to
	// it. This wrapper only fills in the silence when nothing else has.
	//
	// `fillIn` is how a success is published. `flushAll` runs every dirty context
	// at once and passes a collector instead: filling in per context can itself
	// publish `pending` (`completeSaveThenIdle` holds another dirty context
	// against a success), and the next context to resolve would read that as its
	// own verdict. The batch fills in once, after every verdict is in.
	const outcomeFromPublishedStatus = (context: SaveContext, fillIn: FillIn): SaveOutcome => {
		const published = get().status;
		if (published === "error") return "failed";
		if (published === "pending") return "pending";
		fillIn(context);
		return "saved";
	};

	// A context that did report is believed over the shared status, which another
	// context saving in the same tick may have overwritten. A reported "saved"
	// still fills in the silence, because a context such as `useDraftSaveContext`
	// publishes nothing on success, but never over another context's "error" or
	// "pending".
	const outcomeFromReport = (
		context: SaveContext,
		reported: SaveOutcome,
		fillIn: FillIn
	): SaveOutcome => {
		if (reported !== "saved") return reported;
		const published = get().status;
		if (published !== "error" && published !== "pending") fillIn(context);
		return "saved";
	};

	// Internal helper - runs a save for the given context, updates store state,
	// and reports what became of it. Caller must own the in-progress guard if
	// needed.
	const runSave = async (
		context: SaveContext,
		fillIn: FillIn = (c) => get().completeSaveThenIdle(c.id)
	): Promise<SaveOutcome> => {
		set({ status: "saving" });
		try {
			const reported = await context.save();
			return reported
				? outcomeFromReport(context, reported, fillIn)
				: outcomeFromPublishedStatus(context, fillIn);
		} catch (error) {
			get().failSave(
				error instanceof Error ? `Couldn't save - ${error.message}` : "Couldn't save"
			);
			return "failed";
		}
	};

	return {
		status: "idle",
		lastErrorMessage: null,
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
			if (dirtyContextExists(reportingContextId)) {
				set({ status: "pending" });
				// A registry entry is refreshed by an effect, so a *sibling* that
				// finished its own write moments ago can still read dirty above -
				// two surfaces saving within a render of each other each see the
				// other as unsaved, and this `pending` would then sit on the Dock
				// until the next save, describing nothing. So re-derive it once the
				// effects have flushed. The two guards are the ones below: a later
				// save re-arms the generation and owns the status from then on, and
				// a `pending` a context published for its own unsaved edit is not
				// this timer's to clear - that context is still in the registry,
				// still dirty.
				const armed = ++idleResetGeneration;
				setTimeout(() => {
					if (armed !== idleResetGeneration) return;
					if (get().status !== "pending") return;
					if (dirtyContextExists()) return;
					get().setStatus("idle");
				}, TIMING.SAVED_STATUS_DURATION_MS);
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
			set({ status: "error", lastErrorMessage: error });
			useToastStore.getState().showToast(error, "error");
		},

		reset: () => set({ status: "idle", lastErrorMessage: null }),

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
			const dirty = [...get().contexts.values()].filter((c) => c.hasPendingChanges);
			const settled: SaveContext[] = [];
			const outcomes = await Promise.all(
				dirty.map((c) => runSave(c, (s) => settled.push(s)))
			);
			// Publish the batch's success once; a failure or a pending verdict
			// published by a context stays on the status as it is.
			const last = settled[settled.length - 1];
			if (last && !["error", "pending"].includes(get().status)) {
				get().completeSaveThenIdle(last.id);
			}
			const count = (wanted: SaveOutcome) =>
				outcomes.filter((outcome) => outcome === wanted).length;
			// `pending` is a context that settled without persisting its edit (a
			// blocked save, an edit that landed mid-flight). The caller (`main.ts`,
			// #1489) also sees the case no completed flush can represent - the 2s
			// ceiling firing before the renderer answers - as a `null` result.
			return {
				saved: count("saved"),
				failed: count("failed") + count("final"),
				pending: count("pending"),
			};
		},
	};
});
