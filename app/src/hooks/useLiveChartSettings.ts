/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Live dashboard chart retention: the window and the tick ceiling that bound
 * how much history the charts keep.
 *
 * They live **engine-side**, as the `liveReplayWindowMs` and
 * `liveMaxRetainedTicks` config entries, not in localStorage. The engine needs
 * the same two numbers to size the in-memory SSE tick ring that
 * `/runs/:id/live` replays from offset 0 - the replay that rebuilds these charts
 * when the dashboard attaches or re-attaches mid-run - so a renderer-local copy
 * could only drift from it, with one side retaining less than the other assumes.
 * Reading and writing the same entries is what keeps them equal by construction.
 *
 * Two hooks, because reading and editing have different lifetimes (#1936):
 *
 * - {@link useLiveWindowSync} pushes both values into the dashboard store. It is
 *   mounted once at the App root, since a run streams into the store whether or
 *   not Settings is open; scoped to the editor it only ran while Settings >
 *   Dashboard was on screen, and the store otherwise kept its module defaults.
 *   Until the config query resolves the store keeps those defaults, so
 *   retention is bounded from the first tick.
 * - {@link useLiveChartSettings} is the editor the Live Dashboard panel's picker
 *   uses. The picker is the window's **only** editor (#586): the engine settings
 *   list used to offer a second one under a second label and a second save
 *   model, and `ENGINE_SETTINGS_EDITED_IN_APP` is what keeps that row out of it.
 *   The ceiling is a memory backstop, edited from the engine list and only read
 *   here, which is why it is returned rather than settable.
 */

import { useCallback, useEffect } from "react";
import {
	DEFAULT_LIVE_WINDOW,
	DEFAULT_MAX_RETAINED_TICKS,
	LIVE_MAX_TICKS_CONFIG_KEY,
	LIVE_WINDOW_CONFIG_KEY,
	liveWindowFromMs,
	liveWindowSeconds,
	liveWindowToMs,
	type LiveWindow,
} from "@/constants/live-window";
import { useConfigQuery, useUpdateConfigMutation } from "@/queries";
import { useDashboardStore } from "@/stores";

function useLiveConfigValues(): { window: LiveWindow; maxTicks: number } {
	const { data: config } = useConfigQuery();

	const entryValue = (key: string): string | undefined =>
		config?.entries?.find((e) => e.key === key)?.value;

	const rawWindow = entryValue(LIVE_WINDOW_CONFIG_KEY);
	// Entry values are strings. An absent key - config still loading, or an
	// engine older than these settings - leaves the default rather than parsing
	// `undefined` to NaN.
	const window: LiveWindow =
		rawWindow === undefined ? DEFAULT_LIVE_WINDOW : liveWindowFromMs(Number(rawWindow));

	const rawTicks = Number(entryValue(LIVE_MAX_TICKS_CONFIG_KEY));
	const maxTicks =
		Number.isFinite(rawTicks) && rawTicks > 0 ? rawTicks : DEFAULT_MAX_RETAINED_TICKS;

	return { window, maxTicks };
}

/** Pushes the engine's retention settings into the dashboard store. Mount once, at the App root. */
export function useLiveWindowSync(): void {
	const { window, maxTicks } = useLiveConfigValues();
	const setLiveWindowSeconds = useDashboardStore((s) => s.setLiveWindowSeconds);
	const setMaxRetainedTicks = useDashboardStore((s) => s.setMaxRetainedTicks);

	useEffect(() => {
		setLiveWindowSeconds(liveWindowSeconds(window));
	}, [window, setLiveWindowSeconds]);

	useEffect(() => {
		setMaxRetainedTicks(maxTicks);
	}, [maxTicks, setMaxRetainedTicks]);
}

export function useLiveChartSettings() {
	const { window, maxTicks } = useLiveConfigValues();
	const updateConfig = useUpdateConfigMutation();
	const setLiveWindowSeconds = useDashboardStore((s) => s.setLiveWindowSeconds);

	const setWindow = useCallback(
		(next: LiveWindow) => {
			// Apply to the charts immediately - the mutation round-trips to the
			// engine and back through the query cache, and the picker should not
			// feel like it lags a redraw behind the click.
			setLiveWindowSeconds(liveWindowSeconds(next));
			updateConfig.mutate({
				entries: { [LIVE_WINDOW_CONFIG_KEY]: String(liveWindowToMs(next)) },
			});
		},
		[updateConfig, setLiveWindowSeconds]
	);

	return { window, setWindow, maxRetainedTicks: maxTicks };
}
