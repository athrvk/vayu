/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * UI Timing Configuration
 *
 * All UI-facing delays, debounces, polling intervals and retry policies in
 * one place. Values are milliseconds unless the name says otherwise.
 */

/*
 * The auto-save delay is deliberately *not* here. It is a user setting, not a
 * fixed timing: `autoSave.delayMs` in `constants/client-settings.ts`, chosen in
 * Settings → General and read by `useSaveManager`. An `AUTO_SAVE_DELAY_MS: 3000`
 * did sit here, with no readers and a value two seconds off the real default -
 * which is worse than absent, since this file is where CLAUDE.md tells you to
 * look for a millisecond value.
 */
export const TIMING = {
	/**
	 * How often a rendered relative time recomputes itself.
	 *
	 * The response pane shows a response's age, and it sits open while you keep
	 * editing the request beside it - so a "just now" that never updates is a
	 * claim that goes stale while being looked at. Coarser than the finest
	 * granularity the formatter has (a minute), which is all it needs to be.
	 */
	RELATIVE_TIME_TICK_MS: 30_000,
	/**
	 * How long the "Saved" indicator stays visible after a save.
	 *
	 * Read in exactly one place - `completeSaveThenIdle` in `save-store.ts`, which
	 * is the only way a success is reported - so every saving surface in the app
	 * shows it for the same time.
	 */
	SAVED_STATUS_DURATION_MS: 3000,

	/** Transient in-component status feedback (the response viewer's copy tick). */
	STATUS_RESET_MS: 2000,

	/**
	 * Radix tooltip open delay, set once on the root `TooltipProvider` in
	 * `main.tsx` and inherited everywhere.
	 *
	 * This comment used to claim "used across the app" while the root provider
	 * set nothing, so Radix's 700ms default governed almost everything and two
	 * components opted into 150ms locally. Worse, two more mounted *bare* nested
	 * providers, which do not inherit - a provider with no `delayDuration` prop
	 * re-establishes 700ms for its subtree. Those are gone; a nested provider is
	 * now the exception that has to say why.
	 */
	TOOLTIP_DELAY_MS: 150,

	/** Engine health poll interval while the app is open. */
	HEALTH_CHECK_INTERVAL_MS: 30_000,

	/** Wait after asking electron to restart the engine before refetching. */
	ENGINE_RESTART_WAIT_MS: 1500,

	/** GraphQL editor diagnostics debounce. */
	GRAPHQL_DIAGNOSTICS_DEBOUNCE_MS: 250,
	/** GraphQL schema introspection debounce after URL/headers change. */
	GRAPHQL_INTROSPECTION_DEBOUNCE_MS: 400,

	/** Run report polling: first attempt delay, retry delay, and max attempts. */
	REPORT_INITIAL_DELAY_MS: 3000,
	REPORT_RETRY_DELAY_MS: 1000,
	REPORT_MAX_ATTEMPTS: 5,

	/**
	 * Toast auto-dismiss, per variant, handed to the Radix primitive.
	 *
	 * Per variant rather than one constant: a confirmation is read at a glance,
	 * while a failure has to be read and often names a cause from the engine
	 * ("database is locked") that takes longer to take in. These are floors, not
	 * limits - the primitive pauses them on hover, focus and window blur.
	 */
	TOAST_DURATION_MS: {
		info: 4000,
		success: 4000,
		warning: 6000,
		error: 10000,
	},

	/**
	 * How long a dismissed toast is kept before it leaves the queue.
	 *
	 * Must stay in step with the exit animation on `ui/toast.tsx`
	 * (`duration-200`). It exists because deleting the entry the moment the toast
	 * closes unmounts the element in the same update that sets
	 * `data-state="closed"`, and Radix cannot animate a node whose parent has
	 * already removed it - the exit gets no frame and only the enter animation
	 * ships. Shorter than the animation and the node vanishes mid-flight; longer
	 * and a dismissed toast lingers doing nothing.
	 */
	TOAST_EXIT_MS: 200,
} as const;
