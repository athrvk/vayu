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

	/**
	 * The floor on how long the Dock's "Saving…" line stays on screen before it
	 * shows "Saved" in its place.
	 *
	 * A save against the local engine often lands in under 50ms, which is well
	 * under the ~100-200ms a state needs to be legible at all - "Saving…" was
	 * there and gone in the same frame most people would notice it, so every
	 * save read as an instant, flickerless jump from "Unsaved changes" straight
	 * to "Saved". 400ms sits inside the 300-600ms range general loading-state
	 * guidance gives for "long enough to register as a state, short enough not
	 * to read as latency".
	 *
	 * Deliberately a presentation concern, not a store one: `save-store.ts`'s
	 * `status` still flips to `"saved"` the instant a save lands - every other
	 * reader of that store (the eight `startSaving`/`completeSaveThenIdle`
	 * callers' own tests among them) needs the truth as soon as it is known, not
	 * a truth held back for legibility. Read in exactly one place -
	 * `SaveStatusLine` in `layout/Dock.tsx`, the only surface that renders
	 * `status` for a human to read - which holds the *display* on "saving" a
	 * little past a status change it has already received, rather than delaying
	 * the store underneath it.
	 */
	SAVING_MIN_VISIBLE_MS: 400,

	/**
	 * Ceiling on the backoff `useSaveManager` doubles through after a failed
	 * auto-save. Read in exactly one place - the retry scheduled from
	 * `performSave`'s catch - so a save that keeps failing settles into a fixed
	 * cadence instead of backing off forever.
	 */
	SAVE_RETRY_MAX_DELAY_MS: 60_000,

	/**
	 * How long a copy button's check stays in place of its Copy glyph.
	 *
	 * The one duration for the whole app's copy acknowledgement (#1686). It
	 * replaces three that meant the same thing - 1500ms in the MCP settings
	 * panel, 2000ms in the two update surfaces, and a transient-status constant
	 * in the response viewer and the snippet section - and it is read only by
	 * `useCopy`, which is now the only thing that schedules the reset.
	 *
	 * That third one, a general "transient in-component status" entry at the
	 * same 2000ms, is gone with them: the copy tick was its only reader, and a
	 * key here with no reader is the defect `timing-keys-have-readers.test.ts`
	 * exists for. A future indicator that is not the clipboard's gets its own
	 * name rather than borrowing this one.
	 */
	COPY_RESET_MS: 2000,

	/**
	 * How long a just-created row stays highlighted so the eye can find it.
	 *
	 * The Services drawer orders inboxes by port, so a new one lands wherever
	 * its ephemeral port sorts - not at the end. Without the highlight the only
	 * evidence a click did anything was a row count nobody was counting. Same
	 * order as the copy tick (`COPY_RESET_MS`): long enough to be seen after the toast pulls
	 * the eye elsewhere, short enough that it is over before it reads as a
	 * selection the user has to clear.
	 */
	ROW_FLASH_MS: 2500,

	/**
	 * How long the collection tree's typeahead buffer survives between
	 * keystrokes before the next letter starts a fresh search.
	 *
	 * The WAI-ARIA practices leave the number to the implementation. 500ms is
	 * what native tree views use: long enough to type a three-letter prefix
	 * without hurrying, short enough that a letter pressed after a pause means
	 * "jump to something starting with this" rather than extending a prefix the
	 * user has forgotten they were building.
	 */
	TREE_TYPEAHEAD_MS: 500,

	/**
	 * How long a drag has to hover a collapsed folder before it springs open.
	 *
	 * The gesture that has to survive it is "pass over a folder on the way
	 * somewhere else", so this is deliberately longer than an incidental
	 * traverse and shorter than the moment a user would give up and drop
	 * somewhere they did not want. 700ms is what macOS Finder and Windows
	 * Explorer both use for the same interaction.
	 */
	TREE_SPRING_LOAD_MS: 700,

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

	/**
	 * How long a hover-opened `{{variable}}` popover stays up after the pointer
	 * leaves the token, before closing (issue #1220 hover redesign).
	 *
	 * This used to reuse `TOOLTIP_DELAY_MS`, on the reasoning that one named
	 * constant beats a second one for a closely related purpose - but the two
	 * delays answer different questions. Opening is "has the pointer paused
	 * long enough to mean it", which 150ms already answers well. Closing is
	 * "has the pointer had long enough to physically travel from the token to
	 * the popover's own content", which is real mouse-travel distance and time,
	 * not intent - and 150ms was too short: a popover a token's own height or
	 * two away closed before an ordinary mouse movement covered the gap,
	 * because `useEditorVariableTokens.ts` and `EditableVariable.tsx` both
	 * cancel this timer the instant the pointer is confirmed over the popover's
	 * content, so the grace only has to outlast the *travel*, not the whole
	 * visit - a shorter number here costs nothing once the pointer arrives.
	 */
	VARIABLE_POPOVER_LEAVE_GRACE_MS: 350,

	/** Engine health poll interval while the app is open. */
	HEALTH_CHECK_INTERVAL_MS: 30_000,

	/**
	 * Engine health poll interval while the engine is *not* answering.
	 *
	 * The window now loads alongside the engine rather than after it, so the
	 * first seconds of an ordinary launch are spent disconnected and the poll
	 * that ends that state is on the startup path. At the 30s cadence a launch
	 * could sit disconnected for half a minute after the engine was already
	 * serving. Disconnected is an abnormal state the user wants left, and a
	 * refused connection to a closed localhost port costs almost nothing, so it
	 * is polled hard and only until it answers.
	 */
	HEALTH_RECONNECT_POLL_INTERVAL_MS: 1_000,

	/**
	 * How long a launch's first poll failures mean "still starting" rather than
	 * "unreachable".
	 *
	 * The same number the main process spends waiting for a cold engine
	 * (`ENGINE_HEALTH_POLL_BUDGET_MS` in `electron/constants.ts`), because it is
	 * the same question asked from the other side: below it the engine is doing
	 * its startup housekeeping - orphan reconciliation, inbox cleanup, a
	 * page-reclaim rewrite - and above it something is actually wrong. The two
	 * files share no module graph, so `health.test.ts` holds them together.
	 *
	 * Shorter would be tidier on screen and dishonest: it would put a failure
	 * affordance on launches that go on to succeed, which is the whole of #1164.
	 */
	ENGINE_STARTUP_GRACE_MS: 45_000,

	/**
	 * How often the two service lists (webhook inboxes, OAuth issuers) and a
	 * mock server's own list are re-read.
	 *
	 * Polled at all because this app is not the only client that can start a
	 * service: the MCP server exposes the same lifecycle to an agent, and curl
	 * reaches the engine directly. Without a poll the Dock's running-services
	 * indicator, mounted for the app's whole lifetime, would only ever report
	 * what this window itself started.
	 *
	 * 10s rather than the health check's 30s because a service started
	 * elsewhere should show up in the Dock while the user is still looking, but
	 * membership in these lists changes far less often than a mock server's
	 * traffic does - see `MOCK_ACTIVITY_POLL_INTERVAL_MS` for that.
	 */
	SERVICES_POLL_INTERVAL_MS: 10_000,

	/**
	 * How often a running mock server's own route hit counts and activity log
	 * are re-read. Faster than `SERVICES_POLL_INTERVAL_MS` on purpose: a hit
	 * count changes with live traffic the moment a request lands, unlike a
	 * service list's membership, and this constant covers only the mock-server
	 * tab, not the app-wide Dock subscription.
	 */
	MOCK_ACTIVITY_POLL_INTERVAL_MS: 3_000,

	/** Wait after asking electron to restart the engine before refetching. */
	ENGINE_RESTART_WAIT_MS: 1500,

	/**
	 * How long the Dock's save line takes to fade out on its way to idle, and
	 * how long its track is held open to let that fade actually play.
	 *
	 * Must stay in step with the opacity transition on `layout/Dock.tsx`'s live
	 * cell (`duration-200`) - the same pairing `TOAST_EXIT_MS` documents for
	 * `ui/toast.tsx`, for the same reason: `useSaveStatusDisplay` still reports
	 * the *old* status (so the text and the track's open width do not move)
	 * for exactly this long after the store goes `idle`, which is what gives
	 * the opacity transition a frame to animate against instead of the node's
	 * content vanishing in the same update that starts the fade.
	 */
	SAVE_LINE_FADE_MS: 200,

	/**
	 * How long a tab mark keeps its last content on screen after the thing it
	 * was counting is gone.
	 *
	 * The same defect `SAVE_LINE_FADE_MS` answers for the Dock's save line, at
	 * the two marks that sit on a tab trigger: `TabCount` in `ui/tabs.tsx` and
	 * `TestsResultChip` in the response viewer. Both empty their content the
	 * instant there is nothing to show, while `MARK_TRACK`'s
	 * `grid-template-columns: 1fr -> 0fr` goes on collapsing around them - so
	 * the track shrank smoothly and the digit inside it was simply gone, a cut
	 * masked by the container's own motion. `useHeldValue` holds the outgoing
	 * content for this long so the opacity transition has a populated node.
	 *
	 * 150ms rather than `SAVE_LINE_FADE_MS`'s 200 because the two play the
	 * motion in a different order. The Dock's line is centred in its track, so
	 * a squeeze would eat a whole sentence from both ends; it fades first and
	 * collapses after, two gestures back to back. A mark is a digit or a
	 * four-character chip already clipped by `overflow-hidden`, so it fades
	 * *while* its own track closes - one gesture, and this has to match that
	 * track's `duration-150` for the two halves to land together. A count
	 * changes with every keystroke in the Params table; 200 + 150 sequential
	 * there would read as lag rather than as motion.
	 */
	MARK_FADE_MS: 150,

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
