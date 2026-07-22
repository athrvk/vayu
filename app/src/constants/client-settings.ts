/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Client settings — option lists, defaults, and guards for the renderer-only
 * preferences held in the client-settings store (editor behavior, chart
 * granularity, SLO threshold, live refresh rate, auto-save). These arrays are
 * the single source of truth: the store defaults, the settings pickers, and the
 * runtime clamps all derive from them.
 */

export interface LabeledOption<T> {
	readonly value: T;
	readonly label: string;
	readonly description?: string;
}

/* ── Editor ──────────────────────────────────────────────────────────────── */

export const EDITOR_FONT_SIZES = [11, 12, 13, 14, 16] as const;
export const DEFAULT_EDITOR_FONT_SIZE = 13;

export const EDITOR_TAB_SIZES = [2, 4] as const;
export const DEFAULT_EDITOR_TAB_SIZE = 2;

export interface EditorPrefs {
	fontSize: number;
	wordWrap: boolean;
	minimap: boolean;
	lineNumbers: boolean;
	tabSize: number;
}

export const DEFAULT_EDITOR_PREFS: EditorPrefs = {
	fontSize: DEFAULT_EDITOR_FONT_SIZE,
	wordWrap: true,
	minimap: false,
	lineNumbers: true,
	tabSize: DEFAULT_EDITOR_TAB_SIZE,
};

/* ── Dashboard / charts ──────────────────────────────────────────────────── */

/** Time-bucket width for the shared time-series charts. */
export const CHART_GRANULARITY_OPTIONS: readonly LabeledOption<number>[] = [
	{ value: 0.5, label: "0.5s", description: "Finest" },
	{ value: 1, label: "1s", description: "Balanced" },
	{ value: 2, label: "2s", description: "Smoothest" },
];
export const DEFAULT_CHART_BUCKET_SECONDS = 0.5;

/** Capacity SLO — the p99 latency at which the breakpoint/saturation triggers. */
export const SLO_THRESHOLD_MIN_MS = 1;
export const SLO_THRESHOLD_MAX_MS = 60_000;
export const DEFAULT_SLO_THRESHOLD_MS = 200;

/** How often live SSE metrics are committed into the UI store. */
export const LIVE_REFRESH_OPTIONS: readonly LabeledOption<number>[] = [
	{ value: 250, label: "250 ms", description: "Smoothest" },
	{ value: 500, label: "500 ms", description: "Balanced" },
	{ value: 1000, label: "1 s", description: "Lightest" },
];
export const DEFAULT_LIVE_REFRESH_MS = 500;

/* ── Auto-save ───────────────────────────────────────────────────────────── */

export const AUTO_SAVE_DELAY_OPTIONS: readonly LabeledOption<number>[] = [
	{ value: 5_000, label: "5s" },
	{ value: 30_000, label: "30s" },
	{ value: 60_000, label: "1m" },
];
export const DEFAULT_AUTO_SAVE_ENABLED = true;
export const DEFAULT_AUTO_SAVE_DELAY_MS = 5_000;

/**
 * Snap a persisted delay onto the nearest offered option.
 *
 * The options were 1s/3s/5s and are now 5s/30s/1m, so anyone who had chosen 1s
 * or 3s holds a value that no longer appears in the picker. Without this the
 * setting renders with nothing selected while auto-save quietly keeps using the
 * old interval — the control and the behaviour disagreeing, which is worse than
 * either being wrong on its own.
 *
 * Nearest rather than reset-to-default, because 3s should land on 5s rather
 * than jumping to a minute.
 */
export function nearestAutoSaveDelay(ms: number): number {
	return AUTO_SAVE_DELAY_OPTIONS.reduce((best, o) =>
		Math.abs(o.value - ms) < Math.abs(best.value - ms) ? o : best
	).value;
}

export interface AutoSavePrefs {
	enabled: boolean;
	delayMs: number;
}

export const DEFAULT_AUTO_SAVE_PREFS: AutoSavePrefs = {
	enabled: DEFAULT_AUTO_SAVE_ENABLED,
	delayMs: DEFAULT_AUTO_SAVE_DELAY_MS,
};

/* ── Guards / clamps ─────────────────────────────────────────────────────── */

export function clampSloThresholdMs(ms: number): number {
	if (!Number.isFinite(ms)) return DEFAULT_SLO_THRESHOLD_MS;
	return Math.min(SLO_THRESHOLD_MAX_MS, Math.max(SLO_THRESHOLD_MIN_MS, Math.round(ms)));
}

export function isChartBucketSeconds(v: number): boolean {
	return CHART_GRANULARITY_OPTIONS.some((o) => o.value === v);
}

export function isLiveRefreshMs(v: number): boolean {
	return LIVE_REFRESH_OPTIONS.some((o) => o.value === v);
}
