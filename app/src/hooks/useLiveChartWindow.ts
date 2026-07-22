/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * useLiveChartWindow
 *
 * Owns the live dashboard chart retention window preference - how much recent
 * live history the charts keep, as a time window. Persists to localStorage and
 * keeps the dashboard store's `liveWindowSeconds` in sync (the store seeds itself
 * from the same key at creation, so retention is correct even before this hook
 * mounts; the hook takes over as source of truth once it runs).
 */

import { useCallback, useEffect, useState } from "react";
import { STORAGE_KEYS } from "@/constants/storage-keys";
import {
	DEFAULT_LIVE_WINDOW,
	isLiveWindow,
	liveWindowSeconds,
	type LiveWindow,
} from "@/constants/live-window";
import { useDashboardStore } from "@/stores";

function readWindow(): LiveWindow {
	const saved = localStorage.getItem(STORAGE_KEYS.LIVE_CHART_WINDOW);
	return isLiveWindow(saved) ? saved : DEFAULT_LIVE_WINDOW;
}

export function useLiveChartWindow() {
	const [window, setWindowState] = useState<LiveWindow>(readWindow);
	const setLiveWindowSeconds = useDashboardStore((s) => s.setLiveWindowSeconds);

	// Push the preference into the store's retention whenever it changes.
	useEffect(() => {
		setLiveWindowSeconds(liveWindowSeconds(window));
	}, [window, setLiveWindowSeconds]);

	const setWindow = useCallback((next: LiveWindow) => {
		localStorage.setItem(STORAGE_KEYS.LIVE_CHART_WINDOW, next);
		setWindowState(next);
	}, []);

	return { window, setWindow };
}
