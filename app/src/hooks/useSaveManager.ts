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
 * - Updates centralized save status for UI feedback
 * - Manages save queue and prevents duplicate saves
 */

import { useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSaveStore } from "@/stores/save-store";
import { useClientSettingsStore } from "@/stores";
import { queryKeys } from "@/queries/keys";
import { ApiError } from "@/services/http-client";
import { TIMING } from "@/config/timing";

/**
 * The registry id this hook saves under. Three places in this file need it -
 * the registration, the `hasPendingChanges` update, and the success this hook
 * reports for itself - and a fourth spelling of the same template string is how
 * the three drift apart.
 */
const saveContextId = (entityId: string) => `request-${entityId}`;

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

interface UseSaveManagerReturn {
	/** Trigger an immediate save */
	forceSave: () => Promise<void>;
	/** Current save status */
	status: "idle" | "pending" | "saving" | "saved" | "error";
	/** Whether currently saving */
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
	const {
		status,
		markPendingSave,
		startSaving,
		completeSaveThenIdle,
		failSave,
		reset,
		registerContext,
		unregisterContext,
		updateContext,
		setActiveContext,
	} = useSaveStore();

	const autoSaveEnabled = useClientSettingsStore((s) => s.autoSave.enabled);
	const autoSaveDelayMs = useClientSettingsStore((s) => s.autoSave.delayMs);
	const queryClient = useQueryClient();

	const timeoutRef = useRef<NodeJS.Timeout | null>(null);
	// Saves are queued, never dropped - see performSave.
	const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
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
	const performSave = useCallback((): Promise<void> => {
		if (!entityId) return Promise.resolve();

		// Bind the saver now, not when the queue reaches us. An entity switch
		// flushes from its effect cleanup, which runs before the next render
		// repoints `onSaveRef` - a queued save that read the ref late would write
		// the entity the user just switched *to*.
		const save = onSaveRef.current;
		// The generation that saver carries. Bound here, beside it, for the same
		// reason: both describe the state of the entity at this moment, and a
		// read taken later would describe an edit this save is not carrying.
		const savedGeneration = changeTokenRef.current;

		const run = saveQueueRef.current.then(async () => {
			startSaving();
			try {
				await save();
				// "Saved" is a claim about the editor, not about the round trip.
				// An edit that landed while this save was in flight is not in
				// what went out, so the honest status is still "unsaved" - the
				// Dock reads this store, and it used to flash "Saved" over an
				// edit nobody had persisted. The caller re-arms the save; this
				// only refuses to mislabel it.
				if (changeTokenRef.current === savedGeneration) {
					completeSaveThenIdle(saveContextId(entityId));
				} else {
					markPendingSave();
				}
			} catch (error) {
				console.error("Save failed:", error);
				failSave(error instanceof Error ? error.message : "Save failed");

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
			}
		});
		saveQueueRef.current = run;
		return run;
	}, [entityId, startSaving, completeSaveThenIdle, markPendingSave, failSave, queryClient]);

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
	 * `performSave` swallows its own errors and always resolves, so the
	 * outcome is read back from the store status it just published rather than
	 * from a rejection.
	 */
	const attemptAutoSave = useCallback(async () => {
		await performSave();
		if (useSaveStore.getState().status !== "error") {
			retryAttemptRef.current = 0;
			clearRetry();
			return;
		}
		if (!enabledRef.current) return;

		// Doubling from the user's own delay, capped so a save that keeps
		// failing settles into a fixed cadence instead of backing off forever.
		const attempt = retryAttemptRef.current;
		retryAttemptRef.current = attempt + 1;
		const delay = Math.min(
			autoSaveDelayMsRef.current * 2 ** attempt,
			TIMING.SAVE_RETRY_MAX_DELAY_MS
		);
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

	// Reset on entity change; flush pending edits for the *previous* entity in
	// the cleanup. Cleanups run before the new render's ref-update effects, so
	// performSave (keyed on the old entityId via useCallback) still sees the
	// old onSaveRef - an edit still inside the auto-save delay when you switch
	// is saved, not dropped. (The delay is the user's setting, default 5s; this
	// said "<3s", the value of a dead constant in `config/timing.ts` that the
	// hook never read. That constant is gone.)
	useEffect(() => {
		reset();
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
			if (enabledRef.current && hasChangesRef.current) {
				performSave();
			}
		};
	}, [entityId, reset, performSave, clearRetry]);

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
		markPendingSave();

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
		markPendingSave,
		attemptAutoSave,
		autoSaveEnabled,
		autoSaveDelayMs,
		clearRetry,
	]);

	return {
		forceSave,
		status,
		isSaving: status === "saving",
	};
}
