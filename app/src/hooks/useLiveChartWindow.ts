/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * useLiveChartWindow
 *
 * Owns the live dashboard chart retention window - how much recent live history
 * the charts keep, as a time window - and keeps the dashboard store's
 * `liveWindowSeconds` in sync with it.
 *
 * The value lives **engine-side**, as the `liveReplayWindowMs` config entry,
 * not in localStorage. The engine needs the same number to size the in-memory
 * SSE tick ring that `/runs/:id/live` replays from offset 0 - the replay that
 * rebuilds these charts when the dashboard attaches or re-attaches mid-run - so
 * a renderer-local copy could only drift from it, with the engine retaining
 * less than the chart is set to display. Reading and writing the one entry is
 * what keeps the two spans equal by construction.
 *
 * Until the config query resolves the store keeps its module default, so
 * retention is bounded from the first tick rather than unbounded while loading.
 */

import { useCallback, useEffect } from "react";
import {
	DEFAULT_LIVE_WINDOW,
	LIVE_WINDOW_CONFIG_KEY,
	liveWindowFromMs,
	liveWindowSeconds,
	liveWindowToMs,
	type LiveWindow,
} from "@/constants/live-window";
import { useConfigQuery, useUpdateConfigMutation } from "@/queries";
import { useDashboardStore } from "@/stores";

export function useLiveChartWindow() {
	const { data: config } = useConfigQuery();
	const updateConfig = useUpdateConfigMutation();
	const setLiveWindowSeconds = useDashboardStore((s) => s.setLiveWindowSeconds);

	const raw = config?.entries?.find((e) => e.key === LIVE_WINDOW_CONFIG_KEY)?.value;
	// Entry values are strings. An absent key - config still loading, or an
	// engine older than this setting - leaves the default rather than parsing
	// `undefined` to NaN.
	const window: LiveWindow =
		raw === undefined ? DEFAULT_LIVE_WINDOW : liveWindowFromMs(Number(raw));

	// Push the window into the store's retention whenever it changes.
	useEffect(() => {
		setLiveWindowSeconds(liveWindowSeconds(window));
	}, [window, setLiveWindowSeconds]);

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

	return { window, setWindow };
}
