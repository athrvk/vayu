/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * useSaveManager Hook
 *
 * Centralized auto-save manager that:
 * - Handles debounced auto-save for any saveable entity
 * - Registers with centralized save store for app-wide Ctrl/Cmd+S
 * - Reports its own edit's state to the save store, which the Dock reads
 * - Manages save queue and prevents duplicate saves
 */

import { useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
	isFailedOutcome,
	useSaveStore,
	type SaveContext,
	type SaveOutcome,
	type SaveStatus,
	type UnsavedEdit,
} from "@/stores/save-store";
import { useClientSettingsStore } from "@/stores";
import { queryKeys } from "@/queries/keys";
import { ApiError } from "@/services/http-client";
import { SaveBlockedError } from "@/lib/elements";
import { isNotFoundError, saveFailureOutcome, saveRetryDelayMs } from "@/lib/save-failure";

/**
 * The id this hook registers and reports under. Every registration, update and
 * report in this file needs it, and a second spelling of the template string is
 * how they drift apart.
 */
export const saveContextId = (entityId: string) => `request-${entityId}`;

/**
 * Where an entity-switch or unmount flush leaves its edit once the pane that
 * held it is gone. A failure goes back in the registry so the reconnect flush
 * (#1479) and the quit flush (#1489) can retry it, and that retry retires the
 * entry once it lands - left registered dirty, every later reconnect would
 * re-send the stale draft. A save the editor held back has nothing left to
 * send it (the provider reseeds from the next entity), so its id stops
 * counting as unsaved, and so does one the engine answered 404 (#3444): the
 * entity is gone and no retry can land. Either way, a pane that came back to
 * the entity owns the id again and is left alone.
 */
function settleGoodbyeFlush(
	contextId: string,
	name: string,
	save: () => Promise<void>,
	outcome: SaveOutcome | void,
	entityGone: boolean
) {
	const store = useSaveStore.getState();
	if (store.contexts.has(contextId)) return;
	if (outcome === "pending" || (entityGone && isFailedOutcome(outcome))) {
		store.discard(contextId);
		return;
	}
	if (!isFailedOutcome(outcome)) return;
	const retry: SaveContext = {
		id: contextId,
		name,
		hasPendingChanges: true,
		save: async () => {
			await save();
			const { contexts, unregisterContext } = useSaveStore.getState();
			if (contexts.get(contextId) === retry) unregisterContext(contextId);
		},
	};
	store.registerContext(retry);
}

interface UseSaveManagerOptions {
	/** Unique identifier for this save context (e.g., request ID) */
	entityId: string | null;
	/** Human-readable name for the context (e.g., "Request: GET /api/users") */
	contextName?: string;
	/** Function to perform the actual save */
	onSave: () => Promise<void>;
	/** Whether there are unsaved changes */
	hasChanges: boolean;
	/**
	 * A counter the caller increments on every edit.
	 *
	 * `hasChanges` cannot carry this on its own: it is already `true` for the
	 * second keystroke of a burst, so an effect watching it does not re-run and
	 * the delay measures from the *first* edit rather than the last. The token
	 * changes on every edit, which is what makes the delay a debounce and what
	 * tells a returning save whether the payload it sent is still the whole
	 * story.
	 */
	changeToken: number;
	/** Whether auto-save is enabled (default: true) */
	enabled?: boolean;
}

/** Told of the error behind a failed save, before the failure is reported. */
type ErrorSink = (error: unknown) => void;

/** Where this entity's own edit stands; never `saved`, which no id records. */
export type EditStatus = Exclude<SaveStatus, "saved">;

const EDIT_STATUS: Record<UnsavedEdit["kind"], EditStatus> = {
	pending: "pending",
	saving: "saving",
	failed: "error",
};

interface UseSaveManagerReturn {
	/** Trigger an immediate save */
	forceSave: () => Promise<void>;
	/**
	 * This entity's own edit, read from its entry under its own id - never the
	 * Dock's `status`, which is every surface's at once (#3350).
	 */
	status: EditStatus;
	/** Whether this entity's save is in flight */
	isSaving: boolean;
}

export function useSaveManager({
	entityId,
	contextName,
	onSave,
	hasChanges,
	changeToken,
	enabled = true,
}: UseSaveManagerOptions): UseSaveManagerReturn {
	const ownEdit = useSaveStore((s) =>
		entityId ? s.unsaved.get(saveContextId(entityId)) : undefined
	);
	const reportPending = useSaveStore((s) => s.reportPending);
	const reportSaving = useSaveStore((s) => s.reportSaving);
	const reportSaved = useSaveStore((s) => s.reportSaved);
	const reportFailed = useSaveStore((s) => s.reportFailed);
	const discard = useSaveStore((s) => s.discard);
	const registerContext = useSaveStore((s) => s.registerContext);
	const unregisterContext = useSaveStore((s) => s.unregisterContext);
	const updateContext = useSaveStore((s) => s.updateContext);
	const setActiveContext = useSaveStore((s) => s.setActiveContext);

	const autoSaveEnabled = useClientSettingsStore((s) => s.autoSave.enabled);
	const autoSaveDelayMs = useClientSettingsStore((s) => s.autoSave.delayMs);
	const queryClient = useQueryClient();

	const timeoutRef = useRef<NodeJS.Timeout | null>(null);
	// Saves are queued, never dropped - see performSave.
	const saveQueueRef = useRef<Promise<SaveOutcome | void>>(Promise.resolve());
	const onSaveRef = useRef(onSave);
	const hasChangesRef = useRef(hasChanges);
	const changeTokenRef = useRef(changeToken);
	const enabledRef = useRef(enabled);
	// Read from `attemptAutoSave`, not closed over directly: closing over
	// `autoSaveDelayMs` would give `attemptAutoSave` a new identity on every
	// settings change, and that identity is a dependency of the entity-switch
	// effect below, which flushes a save from its cleanup on *any* identity
	// change - not only an entity switch.
	const autoSaveDelayMsRef = useRef(autoSaveDelayMs);

	// A failed auto-save's own retry timer, separate from `timeoutRef` (the
	// ordinary debounce): a save that failed has nothing new to debounce, so it
	// needs a timer the normal edit-driven effect never arms. `retryAttemptRef`
	// is the consecutive-failure count behind the doubling backoff below - reset
	// on the next success, not on every edit, so a failure that outlives a
	// keystroke keeps backing off rather than restarting at the base delay.
	const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
	const retryAttemptRef = useRef(0);
	// `attemptAutoSave` schedules its own retry via this ref rather than
	// calling itself by name: a `useCallback` cannot close over its own
	// binding before it is declared, and reading a `let` assigned after the
	// fact only defers the same self-reference into the callback body.
	const attemptAutoSaveRef = useRef<() => Promise<void>>(() => Promise.resolve());

	const clearRetry = useCallback(() => {
		if (retryTimeoutRef.current) {
			clearTimeout(retryTimeoutRef.current);
			retryTimeoutRef.current = null;
		}
	}, []);

	// Keep onSave ref updated to avoid stale closures
	useEffect(() => {
		onSaveRef.current = onSave;
	}, [onSave]);

	// Keep hasChanges ref updated
	useEffect(() => {
		hasChangesRef.current = hasChanges;
	}, [hasChanges]);

	// Keep the change token ref updated
	useEffect(() => {
		changeTokenRef.current = changeToken;
	}, [changeToken]);

	// Keep enabled ref updated
	useEffect(() => {
		enabledRef.current = enabled;
	}, [enabled]);

	// Keep the retry delay ref updated
	useEffect(() => {
		autoSaveDelayMsRef.current = autoSaveDelayMs;
	}, [autoSaveDelayMs]);

	// Clear the pending auto-save on unmount. The "saved" indicator's own reset
	// is the store's now, and deliberately survives this component: the Dock
	// outlives the request pane, so the status it is showing has to be cleared by
	// whoever set it, not by whichever pane happened to unmount.
	useEffect(() => {
		return () => {
			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current);
				timeoutRef.current = null;
			}
			clearRetry();
		};
	}, [clearRetry]);

	// Perform the actual save.
	//
	// A save already in flight used to make this a no-op. That silently lied:
	// the flying request carries the snapshot taken when it started, so anything
	// typed since is not in it - yet Cmd+S, the quit flush and the
	// entity-switch flush all awaited that no-op and reported "saved". The
	// switch case was the destructive one, because the provider resets its state
	// right after, so the skipped edits were gone rather than merely unsaved.
	//
	// Saves are therefore serialized instead of skipped: a caller that arrives
	// mid-flight queues behind it and its promise resolves only once *its* save
	// has run. The cost is one redundant round trip when nothing changed in
	// between, which is the right trade against reporting a save that never
	// happened.
	//
	// The verdict is returned as well as reported: `status` is derived from
	// every surface's reports, so a caller that needs to know what became of
	// *this* save (`flushAll`, the retry) cannot read it back from there.
	const performSave = useCallback(
		(onError?: ErrorSink): Promise<SaveOutcome | void> => {
			if (!entityId) return Promise.resolve();
			const contextId = saveContextId(entityId);

			// Bind the saver now, not when the queue reaches us. An entity switch
			// flushes from its effect cleanup, which runs before the next render
			// repoints `onSaveRef` - a queued save that read the ref late would write
			// the entity the user just switched *to*.
			const save = onSaveRef.current;
			// The generation that saver carries. Bound here, beside it, for the same
			// reason: both describe the state of the entity at this moment, and a
			// read taken later would describe an edit this save is not carrying.
			const savedGeneration = changeTokenRef.current;

			const run = saveQueueRef.current.then(async (): Promise<SaveOutcome> => {
				reportSaving(contextId);
				try {
					await save();
					// "Saved" is a claim about the editor, not about the round trip.
					// An edit that landed while this save was in flight is not in
					// what went out, so the honest status is still "unsaved" - the
					// Dock reads this store, and it used to flash "Saved" over an
					// edit nobody had persisted. The caller re-arms the save; this
					// only refuses to mislabel it.
					if (changeTokenRef.current !== savedGeneration) {
						reportPending(contextId);
						return "pending";
					}
					reportSaved(contextId);
					return "saved";
				} catch (error) {
					if (error instanceof SaveBlockedError) {
						// Not a failure - the caller chose not to send. Report the same
						// "still dirty, nothing in flight" state a plain unsaved edit
						// has, so the status bar reads correctly and `attemptAutoSave`
						// does not arm a retry against a payload that will not have
						// changed by the next tick.
						reportPending(contextId);
						return "pending";
					}
					console.error("Save failed:", error);
					onError?.(error);
					reportFailed(
						contextId,
						error instanceof Error
							? `Couldn't save - ${error.message}`
							: "Couldn't save",
						error
					);

					// A 4xx is the engine's verdict on this payload, not a hiccup - a
					// timed-out or refused connection is the shape a dead engine
					// actually takes, and that is the only failure worth reacting to
					// here. `shouldRetryQuery` already draws this line for queries;
					// mutations reach `ApiError` the same way.
					if (!(error instanceof ApiError)) {
						// The health poll can be up to HEALTH_CHECK_INTERVAL_MS behind
						// an engine that just died - a failed save is evidence sooner
						// than the next tick would be, so nudge it now instead of
						// waiting.
						void queryClient.invalidateQueries({ queryKey: queryKeys.health.status() });
					}
					return saveFailureOutcome(error);
				}
			});
			saveQueueRef.current = run;
			return run;
		},
		[entityId, reportSaving, reportSaved, reportPending, reportFailed, queryClient]
	);

	/**
	 * The auto-save path specifically, not every `performSave` caller.
	 *
	 * Cmd+S and the entity-switch/unmount goodbye flush call `performSave`
	 * directly and report their own outcome once - retrying either would save
	 * into a pane the user has already left, or double a save they just asked
	 * for by hand. Only the debounced timer below needs a failure to try
	 * again, so only it (and the retry this schedules for itself) goes through
	 * this wrapper.
	 *
	 * `performSave` swallows its own errors and always resolves, so a failure
	 * is read from the verdict it returns rather than from a rejection. Never
	 * from the store's `status`: that is every surface's at once, and another
	 * surface's failure is not this save's to retry.
	 */
	const attemptAutoSave = useCallback(async () => {
		const outcome = await performSave();
		if (!isFailedOutcome(outcome)) {
			retryAttemptRef.current = 0;
			clearRetry();
			return;
		}
		// The engine rejected this payload (#1889) and would again: re-sending it
		// only re-toasts. The failure stays reported so the Dock keeps saying "Not
		// saved", and the next edit re-arms the debounce above.
		if (outcome === "final") {
			retryAttemptRef.current = 0;
			return;
		}
		// An edit reverted or a request deleted while this save was out leaves
		// nothing to retry; the effect that discards it clears any retry too.
		if (!enabledRef.current || !hasChangesRef.current) return;

		// Doubling from the user's own delay, capped so a save that keeps
		// failing settles into a fixed cadence instead of backing off forever.
		const attempt = retryAttemptRef.current;
		retryAttemptRef.current = attempt + 1;
		const delay = saveRetryDelayMs(autoSaveDelayMsRef.current, attempt);
		clearRetry();
		retryTimeoutRef.current = setTimeout(() => {
			void attemptAutoSaveRef.current();
		}, delay);
	}, [performSave, clearRetry]);

	useEffect(() => {
		attemptAutoSaveRef.current = attemptAutoSave;
	}, [attemptAutoSave]);

	// Register/unregister with centralized save context
	useEffect(() => {
		if (!entityId || !enabled) return;

		const contextId = saveContextId(entityId);

		registerContext({
			id: contextId,
			name: contextName || `Request`,
			save: performSave,
			hasPendingChanges: hasChanges,
		});
		setActiveContext(contextId);

		return () => {
			unregisterContext(contextId);
		};
	}, [
		entityId,
		enabled,
		contextName,
		performSave,
		hasChanges,
		registerContext,
		unregisterContext,
		setActiveContext,
	]);

	// Update context when hasChanges changes
	useEffect(() => {
		if (!entityId || !enabled) return;
		const contextId = saveContextId(entityId);
		updateContext(contextId, { hasPendingChanges: hasChanges, save: performSave });
	}, [entityId, enabled, hasChanges, performSave, updateContext]);

	// Flush pending edits for the *previous* entity on an entity change or
	// unmount. Cleanups run before the new render's ref-update effects, so
	// performSave (keyed on the old entityId via useCallback) still sees the
	// old onSaveRef - an edit still inside the auto-save delay when you switch
	// is saved, not dropped. Nothing is reset on the way in: each id's report
	// is its own, so the new entity starts clean without clearing anyone's.
	useEffect(() => {
		return () => {
			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current);
				timeoutRef.current = null;
			}
			// Cancels a retry a prior failure armed for *this* entity. The flush
			// below goes through `performSave` directly, never `attemptAutoSave`,
			// so a failure here reports once and does not arm a new one - there
			// is no pane left to retry into once this cleanup has run.
			clearRetry();
			if (!entityId || !enabledRef.current || !hasChangesRef.current) return;
			// The sibling registration effect has already unregistered this
			// context by the time this runs, so what the flush leaves behind is
			// settled outside the registry.
			const contextId = saveContextId(entityId);
			// A request deleted from the tree is gone, and its edit is too: there is
			// nothing to save it to, so it is dropped rather than PUT to a 404 (#3444).
			if (useSaveStore.getState().isRemoved(contextId)) {
				discard(contextId);
				return;
			}
			const save = onSaveRef.current;
			const name = contextName || "Request";
			let failure: unknown;
			void performSave((error) => {
				failure = error;
			}).then((outcome) =>
				settleGoodbyeFlush(contextId, name, save, outcome, isNotFoundError(failure))
			);
		};
	}, [entityId, performSave, clearRetry, contextName, discard]);

	// An edit that is gone - reverted, or its request deleted elsewhere - leaves
	// this id's report describing nothing, and nothing to retry. A save in
	// flight is left to report its own outcome; that report changes `ownEdit`
	// and brings this back. Keyed on the pane's current entity, so the edit a
	// goodbye flush carried off under the previous id is not touched.
	useEffect(() => {
		if (!entityId || (enabled && hasChanges)) return;
		clearRetry();
		if (!ownEdit || ownEdit.kind === "saving") return;
		discard(saveContextId(entityId));
	}, [entityId, enabled, hasChanges, ownEdit, clearRetry, discard]);

	// Force save (for manual triggers)
	const forceSave = useCallback(async () => {
		// Cancel any pending auto-save
		if (timeoutRef.current) {
			clearTimeout(timeoutRef.current);
			timeoutRef.current = null;
		}

		await performSave();
	}, [performSave]);

	// Auto-save on changes, debounced from the *last* edit.
	//
	// `changeToken` is in the dependency list and `hasChanges` alone is not
	// enough: the boolean is already `true` by the second keystroke, so this
	// effect did not re-run and the timer armed by the first keystroke ran to
	// term - a save fired five seconds into a burst carrying a half-typed
	// script, every burst, which is what made the in-flight-edit race fire so
	// often. With the token here, each edit clears the pending timer in the
	// cleanup below and arms a fresh one, so one save follows the pause.
	useEffect(() => {
		if (!enabled || !hasChanges || !entityId) {
			return;
		}

		// Mark as pending regardless - the "unsaved changes" state (and manual
		// save via Cmd+S) still applies even when auto-save is turned off.
		reportPending(saveContextId(entityId));

		// A new edit supersedes a retry a prior failure scheduled: the timer
		// armed below covers saving it, so the stale one would only race a
		// second attempt against the first. The backoff count survives this -
		// it resets on success, not on every keystroke - so typing through an
		// outage does not reset a save back to retrying every few seconds.
		clearRetry();

		// Respect the global auto-save preference: when disabled, leave the entity
		// marked dirty but never schedule an automatic save.
		if (!autoSaveEnabled) {
			return;
		}

		// Clear existing timeout
		if (timeoutRef.current) {
			clearTimeout(timeoutRef.current);
		}

		// Set new timeout for auto-save (user-configurable delay)
		timeoutRef.current = setTimeout(() => {
			void attemptAutoSave();
		}, autoSaveDelayMs);

		return () => {
			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current);
			}
		};
	}, [
		enabled,
		hasChanges,
		changeToken,
		entityId,
		reportPending,
		attemptAutoSave,
		autoSaveEnabled,
		autoSaveDelayMs,
		clearRetry,
	]);

	const status = ownEdit ? EDIT_STATUS[ownEdit.kind] : "idle";
	return {
		forceSave,
		status,
		isSaving: status === "saving",
	};
}
