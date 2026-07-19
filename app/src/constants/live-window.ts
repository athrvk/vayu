/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Live dashboard chart window — how much recent live history the dashboard
 * charts retain, as a **time** window (not a point count). A renderer-only
 * preference, persisted to localStorage. This array is the single source of
 * truth: the type, the settings picker, and the runtime guard all derive from it.
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
 * Hard safety cap on retained live ticks regardless of the chosen window — a
 * backstop so a very long "full run" (or a misbehaving high tick rate) can't
 * grow memory without bound. ~33 min at the default 10 Hz tick.
 */
export const MAX_RETAINED_TICKS = 20000;
