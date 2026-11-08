/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Centralized Save Store
 *
 * Every surface that saves reports where its own edit stands under its own id
 * (`reportPending` / `reportSaving` / `reportSaved` / `reportFailed` /
 * `discard`), and the Dock's `status` is derived from all of those reports
 * together (#3350). No surface writes `status` itself, so none can clear
 * another's failure. The store also holds the save context registry that
 * Ctrl/Cmd+S (`triggerSave`) and the quit and reconnect flushes (`flushAll`)
 * walk.
 */

/* global setTimeout */

import { create } from "zustand";

import { TIMING } from "@/config/timing";
import { isDiskFullError } from "@/lib/disk-full";
import { useToastStore } from "./toast-store";

export type SaveStatus = "idle" | "pending" | "saving" | "saved" | "error";

/**
 * One context's verdict on one save, as `runSave` and `flushAll` count it.
 *
 * `pending` is a save the context declined to send (`SaveBlockedError`) or one
 * that left an edit behind: nothing failed, the edit is simply not on disk.
 *
 * `final` is a failure the engine will repeat for this payload (a 4xx, #1889):
 * the same as `failed` to every reader of the count, and the one a caller that
 * retries must not retry.
 *
 * `disk-full` is a `failed` that knows its cause (the engine's 507, #2423): it
 * counts as failed and is retried like one, and `flushAll` carries the cause to
 * the quit prompt so that does not blame the engine for a full disk.
 */
export type SaveOutcome = "saved" | "failed" | "final" | "disk-full" | "pending";

export const isFailedOutcome = (outcome: SaveOutcome | void): boolean =>
	outcome === "failed" || outcome === "final" || outcome === "disk-full";

/**
 * Where one id's edit stands while it is not on disk. An id with nothing
 * unsaved has no entry at all, so "clean" is absence. Entries are replaced on
 * every report, never mutated: `runSave` tells a report made during a save
 * from one made before it by identity.
 */
export type UnsavedEdit =
	| { kind: "pending" }
	| { kind: "saving" }
	| { kind: "failed"; message: string; diskFull: boolean };

/**
 * What `flushAll` reports. `FlushResult` in `electron/save-flush.ts` is the same
 * shape on the other side of the IPC hop. `reason` is present only when it
 * explains every failure.
 */
export interface FlushTally {
	saved: number;
	failed: number;
	pending: number;
	reason?: "disk-full";
}

/** Save context - represents a saveable entity in the app */
export interface SaveContext {
	/** Unique identifier for this save context */
	id: string;
	/** Human-readable name for the context (e.g., "Request", "Global Variables") */
	name: string;
	/**
	 * Function to perform the save. A context that reports its own verdict
	 * resolves with it; see `runSave` for how each shape is judged.
	 */
	save: () => Promise<SaveOutcome | void>;
	/** Whether there are pending changes */
	hasPendingChanges: boolean;
}

/**
 * Every failed *save* is reported by a toast, and `reportFailed` is the single
 * place that raises it, once per failure. A failure that leaves no unsaved edit
 * behind raises its own `showToast` instead - a failed delete, create or
 * duplicate, and a write the surface rolls back on screen (a rename, a
 * context-bar variable commit, a refused blank name): reported here it would
 * hold the Dock on "Not saved" describing no edit, and nothing would ever
 * report that id saved.
 */
interface SaveState {
	/** Derived from `unsaved`: what the Dock renders. */
	status: SaveStatus;
	/** The most recent failure's message while `status` is `"error"`, else null. */
	lastErrorMessage: string | null;

	/**
	 * Every id with an edit not on disk, oldest report first. Keyed by id, not
	 * by registration: an entry outlives `unregisterContext` until its id is
	 * reported saved or discarded, which is how the entity-switch flush of a
	 * pane that has already unregistered still reaches the Dock.
	 */
	unsaved: ReadonlyMap<string, UnsavedEdit>;

	// Active save context - the context that's currently focused/active
	activeContextId: string | null;

	// Registry of save contexts
	contexts: Map<string, SaveContext>;

	/**
	 * An edit `id` holds is not on disk. Does not demote a failure: the edit that
	 * failed is still unsaved, so "Not saved" stays until a save is attempted.
	 */
	reportPending: (id: string) => void;
	reportSaving: (id: string) => void;
	/**
	 * `id` is on disk. The Dock shows `saved` for
	 * `TIMING.SAVED_STATUS_DURATION_MS` unless another id still holds an edit or
	 * something is reported in the meantime.
	 */
	reportSaved: (id: string) => void;
	/**
	 * `id`'s save failed. Raises the failure toast; `cause` is the error behind
	 * `message` when there is one, so a 507 is recorded as disk-full. For an id
	 * discarded while this save was out, the toast is all it raises.
	 */
	reportFailed: (id: string, message: string, cause?: unknown) => void;
	/**
	 * `id`'s edit was thrown away, not written: nothing to report as saved.
	 * Only for an edit that is gone (reverted, reset, or dropped with the editor
	 * that held it), because it also abandons a save still out for it - see
	 * `abandoned`.
	 */
	discard: (id: string) => void;

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
	flushAll: () => Promise<FlushTally>;
}

type Derived = Pick<SaveState, "status" | "lastErrorMessage">;

// Any failure wins, then a save in flight, then an edit not yet sent; only
// with none of those does a recent save show. The newest failure is the one
// described, because a failed report moves its id to the end of the map.
function derive(unsaved: ReadonlyMap<string, UnsavedEdit>, justSaved: boolean): Derived {
	let failure: Extract<UnsavedEdit, { kind: "failed" }> | undefined;
	let saving = false;
	let pending = false;
	for (const edit of unsaved.values()) {
		if (edit.kind === "failed") failure = edit;
		else if (edit.kind === "saving") saving = true;
		else pending = true;
	}
	if (failure) {
		return { status: "error", lastErrorMessage: failure.message };
	}
	let status: SaveStatus = "idle";
	if (saving) status = "saving";
	else if (pending) status = "pending";
	else if (justSaved) status = "saved";
	return { status, lastErrorMessage: null };
}

const verdictOf = (edit: UnsavedEdit): SaveOutcome => {
	if (edit.kind === "failed") return edit.diskFull ? "disk-full" : "failed";
	return "pending";
};

const INITIAL = {
	unsaved: new Map<string, UnsavedEdit>(),
	status: "idle" as SaveStatus,
	lastErrorMessage: null,
	activeContextId: null,
	contexts: new Map<string, SaveContext>(),
};

// Module-local rather than store state: only `derive` reads them, through
// `apply`. `savedWindowGeneration` lets an armed timer tell whether it still
// belongs to the most recent save.
let justSaved = false;
let savedWindowGeneration = 0;

// Ids discarded since a save last started for them or a context last
// registered under them. A save that was out when its editor dropped the edit
// (an id switch, an unmount, a Reset) still settles, and its report describes
// an edit nobody holds: recorded, nothing could ever clear it. So until the id
// is taken back, a failure for it is a toast only, and a pending report counts
// only from a registered owner - that is a new edit; from anyone else it is the
// late save's "still unsaved".
const abandoned = new Set<string>();

// How many failures each id has reported, toast-only ones included: `runSave`
// compares it across a save to tell whether the context already published its
// rejection, which an entry cannot show once the id was abandoned mid-save.
const failureReports = new Map<string, number>();
const failuresOf = (id: string) => failureReports.get(id) ?? 0;

export const useSaveStore = create<SaveState>((set, get) => {
	type SavedWindow = "open" | "close" | "keep";

	// Every write to `unsaved` goes through here, so the derived fields can never
	// disagree with it and a multi-id change notifies subscribers once.
	const apply = (
		change: (unsaved: Map<string, UnsavedEdit>) => void,
		savedWindow: SavedWindow = "close"
	) => {
		const unsaved = new Map(get().unsaved);
		change(unsaved);
		if (savedWindow === "open") {
			justSaved = true;
			armSavedWindowClose();
		} else if (savedWindow === "close") {
			justSaved = false;
			savedWindowGeneration++;
		}
		set({ unsaved, ...derive(unsaved, justSaved) });
	};

	const armSavedWindowClose = () => {
		const armed = ++savedWindowGeneration;
		setTimeout(() => {
			if (armed !== savedWindowGeneration) return;
			justSaved = false;
			set(derive(get().unsaved, justSaved));
		}, TIMING.SAVED_STATUS_DURATION_MS);
	};

	// Delete-then-set moves the id to the end, which is what makes the newest
	// failure the one `derive` describes.
	const put = (id: string, edit: UnsavedEdit) => (unsaved: Map<string, UnsavedEdit>) => {
		unsaved.delete(id);
		unsaved.set(id, edit);
	};

	// The pending or failed edit a context reported while its save ran: an entry
	// that replaced the one present when the save started.
	const reportedDuringSave = (id: string, before: UnsavedEdit | undefined) => {
		const now = get().unsaved.get(id);
		return now !== before && now && now.kind !== "saving" ? now : undefined;
	};

	// A context that returns a verdict owns its publication. Only a success or a
	// hold it left unreported is filled in for it - `useDraftSaveContext`
	// publishes nothing on success - and a reported failure is never published
	// a second time.
	const settleVerdict = (
		id: string,
		before: UnsavedEdit | undefined,
		verdict: SaveOutcome
	): SaveOutcome => {
		const ownReported = get().unsaved.get(id) !== before;
		if (!ownReported && verdict === "saved") get().reportSaved(id);
		if (!ownReported && verdict === "pending") get().reportPending(id);
		return verdict;
	};

	// A context that resolves with nothing is a success unless it reported
	// otherwise while it ran. Resolving is not proof of success on its own:
	// `SettingsMain` publishes its failure and then resolves.
	const settleSilence = (id: string, before: UnsavedEdit | undefined): SaveOutcome => {
		const reported = reportedDuringSave(id, before);
		if (reported) return verdictOf(reported);
		get().reportSaved(id);
		return "saved";
	};

	// A rejection is published here unless the context already reported a
	// failure during the save, which is the double toast a "report, then
	// reject" context used to cost.
	const settleRejection = (id: string, failuresBefore: number, error: unknown): SaveOutcome => {
		if (failuresOf(id) === failuresBefore) {
			get().reportFailed(
				id,
				error instanceof Error ? `Couldn't save - ${error.message}` : "Couldn't save",
				error
			);
		}
		const now = get().unsaved.get(id);
		if (now?.kind === "failed") return verdictOf(now);
		return isDiskFullError(error) ? "disk-full" : "failed";
	};

	// Runs one context's save and reports what became of it. Caller must own the
	// in-progress guard if needed.
	const runSave = async (context: SaveContext): Promise<SaveOutcome> => {
		const before = get().unsaved.get(context.id);
		const failuresBefore = failuresOf(context.id);
		try {
			const verdict = await context.save();
			return verdict
				? settleVerdict(context.id, before, verdict)
				: settleSilence(context.id, before);
		} catch (error) {
			return settleRejection(context.id, failuresBefore, error);
		}
	};

	return {
		...INITIAL,

		reportPending: (id) => {
			if (abandoned.has(id) && !get().contexts.has(id)) return;
			abandoned.delete(id);
			if (get().unsaved.get(id)?.kind === "failed") return;
			apply(put(id, { kind: "pending" }));
		},

		reportSaving: (id) => {
			abandoned.delete(id);
			apply(put(id, { kind: "saving" }));
		},

		reportSaved: (id) => apply((unsaved) => unsaved.delete(id), "open"),

		reportFailed: (id, message, cause) => {
			failureReports.set(id, failuresOf(id) + 1);
			if (!abandoned.has(id)) {
				apply(put(id, { kind: "failed", message, diskFull: isDiskFullError(cause) }));
			}
			useToastStore.getState().showToast(message, "error");
		},

		discard: (id) => {
			if (!get().unsaved.has(id)) return;
			abandoned.add(id);
			apply((unsaved) => unsaved.delete(id), "keep");
		},

		// Context management
		registerContext: (context) => {
			abandoned.delete(context.id);
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
			const outcomes = await Promise.all(dirty.map(runSave));
			const count = (...wanted: SaveOutcome[]) =>
				outcomes.filter((outcome) => wanted.includes(outcome)).length;
			const failed = outcomes.filter(isFailedOutcome).length;
			// The cause is named only when it explains every failure: one context
			// that failed for another reason (a dead engine) makes the prompt's
			// generic wording the honest one, and "the disk is full" would send the
			// user to free space that is not the problem. The key is absent rather
			// than `undefined` when there is no cause, so the result keeps the
			// three-count shape its consumers compare against.
			const diskFullOnly = failed > 0 && count("disk-full") === failed;
			// `pending` is a context that settled without persisting its edit (a
			// blocked save, an edit that landed mid-flight). The caller (`main.ts`,
			// #1489) also sees the case no completed flush can represent - the 2s
			// ceiling firing before the renderer answered - as a `null` result.
			return {
				saved: count("saved"),
				failed,
				pending: count("pending"),
				...(diskFullOnly && { reason: "disk-full" as const }),
			};
		},
	};
});

/**
 * Back to a fresh store, saved-indicator timers included. Tests only: the app
 * never clears another surface's report.
 */
export function resetSaveStoreForTests(): void {
	justSaved = false;
	savedWindowGeneration++;
	abandoned.clear();
	failureReports.clear();
	useSaveStore.setState({
		...INITIAL,
		unsaved: new Map(),
		contexts: new Map(),
	});
}
