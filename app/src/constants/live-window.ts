/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Live dashboard chart window - how much recent live history the dashboard
 * charts retain, as a **time** window (not a point count). This array is the
 * single source of truth for the type, the settings picker, and the runtime
 * guard.
 *
 * The window is **not** a renderer-only preference. It is stored engine-side as
 * the `liveReplayWindowMs` config entry, because the engine needs the same
 * number: it sizes the in-memory SSE tick ring that `/runs/:id/live` replays
 * from offset 0, which is what rebuilds these charts when the dashboard
 * attaches or re-attaches mid-run. Two settings would let the retained span and
 * the displayed span disagree - the engine replaying less than the chart is set
 * to show - so there is one value and both sides read it.
 *
 * The dashboard store trims retained ticks to this window on each batch; because
 * uPlot renders on Canvas there's no per-point-DOM cost, so the window is a UX +
 * memory choice, not a rendering constraint.
 */

export interface LiveWindowOption {
	readonly value: string;
	readonly label: string;
	/** Retention in seconds; null = full run (bounded only by MAX_RETAINED_TICKS). */
	readonly seconds: number | null;
}

export const LIVE_WINDOW_OPTIONS = [
	{ value: "1m", label: "1 min", seconds: 60 },
	{ value: "5m", label: "5 min", seconds: 300 },
	{ value: "15m", label: "15 min", seconds: 900 },
	{ value: "30m", label: "30 min", seconds: 1800 },
	{ value: "full", label: "Full run", seconds: null },
] as const satisfies readonly LiveWindowOption[];

export type LiveWindow = (typeof LIVE_WINDOW_OPTIONS)[number]["value"];

export const DEFAULT_LIVE_WINDOW: LiveWindow = "5m";

export function isLiveWindow(value: unknown): value is LiveWindow {
	return typeof value === "string" && LIVE_WINDOW_OPTIONS.some((o) => o.value === value);
}

/** Seconds for a window value, or null for "full run". */
export function liveWindowSeconds(value: LiveWindow): number | null {
	return LIVE_WINDOW_OPTIONS.find((o) => o.value === value)?.seconds ?? null;
}

/**
 * The engine's `liveReplayWindowMs` config key. The engine stores milliseconds
 * and uses `0` for "full run" (no time limit) - matching this module's `null`,
 * which cannot round-trip through an integer config value.
 */
export const LIVE_WINDOW_CONFIG_KEY = "liveReplayWindowMs";

/** Window value → the milliseconds the engine stores. `full` → 0. */
export function liveWindowToMs(value: LiveWindow): number {
	const seconds = liveWindowSeconds(value);
	return seconds === null ? 0 : seconds * 1000;
}

/**
 * Engine milliseconds → the picker option to show. A value that matches no
 * option - the key is a free integer field in the engine's settings list, so a
 * user can save 90000 there - resolves to the nearest option that does not
 * exceed it, so the chart never claims more history than is retained. Anything
 * below the shortest option, and any unparseable value, falls back to the
 * default rather than showing a window nothing is set to.
 */
export function liveWindowFromMs(ms: number | null | undefined): LiveWindow {
	if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) {
		return DEFAULT_LIVE_WINDOW;
	}
	if (ms === 0) return "full";

	let best: LiveWindow | null = null;
	let bestSeconds = -1;
	for (const option of LIVE_WINDOW_OPTIONS) {
		if (option.seconds === null) continue;
		const optionMs = option.seconds * 1000;
		if (optionMs <= ms && option.seconds > bestSeconds) {
			best = option.value;
			bestSeconds = option.seconds;
		}
	}
	return best ?? DEFAULT_LIVE_WINDOW;
}

/**
 * Hard safety cap on retained live ticks regardless of the chosen window - a
 * backstop so a very long "full run" (or a misbehaving high tick rate) can't
 * grow memory without bound. ~33 min at the default 10 Hz tick.
 */
export const MAX_RETAINED_TICKS = 20000;
