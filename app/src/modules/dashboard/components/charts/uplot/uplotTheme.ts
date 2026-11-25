/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Bridges Vayu's CSS design tokens into uPlot's Canvas world. uPlot takes concrete colour strings
 * and the tokens hold raw HSL channels (e.g. `--primary: 222 47% 11%`), so they are resolved with
 * getComputedStyle at build time into real `hsl(...)` strings, and re-resolved when the theme flips
 * (light/dark) by re-creating the chart with a new themeKey. Every colour still comes from the
 * design system; nothing is hard-coded.
 */

import { STATUS_CLASS_CSS_VAR } from "@/constants/http-status";

/** Semantic color roles, mapped to CSS custom properties. */
/*
 * There is deliberately no `primary` or `accent` role: both resolve to accent-tracking tokens, and
 * a series painted with the user's accent changes hue per theme and can land on top of a semantic
 * neighbour (CLAUDE.md forbids it; `status-code-series.test.ts` scans for it). Leaving them out of
 * the union makes the compiler catch the mistake rather than a scan after it is written. A
 * categorical series wants `categorical`; an accent wanted deliberately should arrive under a name
 * that says so.
 */
export type ColorRole =
	| "success"
	| "warning"
	| "destructive"
	| "info"
	| "muted"
	| "subtle"
	/**
	 * A categorical series colour, for data with no semantic meaning of its own that must stay
	 * distinct from the semantic roles above. Not `--chart-1`, which tracks the user's accent and
	 * so changes hue per theme; `--chart-3` is violet in both themes and the furthest of the
	 * categorical palette from success/warning/destructive.
	 */
	| "categorical"
	/**
	 * The rest of the categorical set (teal, rose, moss), for a plot whose series count the user
	 * decides: the server-vitals overlay, where a run names its own metrics and the wrapper cycles
	 * these. Not `--chart-1` (see `categorical`), nor **`--chart-4` (amber)**: it measures 2.38
	 * against a light card, under the 3.0 a series must clear to be seen at all
	 * (`status-token-contrast.test.ts`); fine as a *fill* in the timing waterfall, where shape
	 * carries the meaning, but not as a 1.8px line.
	 */
	| "categorical-2"
	| "categorical-3"
	| "categorical-4"
	/*
	 * HTTP status classes, resolving to the `--status-*` family the badges and history tiles use.
	 * Apart from the generic roles above on purpose: `success` / `warning` / `destructive` are a
	 * *series* palette wearing semantic names that also paints p50 / p95 / p99 and the error-rate
	 * area, so repointing them at `--status-*` would recolour the latency charts. The status-code
	 * chart is the one plot whose subject is status, so it uses these and shares the vocabulary in
	 * `constants/http-status.ts`.
	 */
	| "status-success"
	| "status-redirect"
	| "status-client-error"
	| "status-server-error"
	| "status-no-response";

/**
 * Exported for `status-code-series.test.ts`, which asserts the status roles resolve to the
 * `--status-*` family by reading this object, the truth, rather than the source text.
 */
export const ROLE_TOKEN: Record<ColorRole, string> = {
	/*
	 * The series tier, not the banner/button tokens: `--warning` measures 2.14 on a light plot and
	 * `--destructive` 1.73 on a dark one (a deep red chosen to carry a white button label, which
	 * all but vanishes on a near-black plot). The role names stay generic because they are:
	 * `success` is also p50, `warning` also p95.
	 */
	success: "--series-success",
	warning: "--series-warning",
	destructive: "--series-danger",
	info: "--info",
	muted: "--muted-foreground",
	subtle: "--subtle-foreground",
	categorical: "--chart-3",
	"categorical-2": "--chart-2",
	"categorical-3": "--chart-5",
	"categorical-4": "--chart-6",
	"status-success": STATUS_CLASS_CSS_VAR.success,
	"status-redirect": STATUS_CLASS_CSS_VAR.redirect,
	"status-client-error": STATUS_CLASS_CSS_VAR["client-error"],
	"status-server-error": STATUS_CLASS_CSS_VAR["server-error"],
	"status-no-response": STATUS_CLASS_CSS_VAR["no-response"],
};

export interface UplotTheme {
	axis: string;
	grid: string;
	text: string;
	font: string;
	cursor: string;
	/** Resolve a semantic role to an `hsl(...)` string, optionally translucent. */
	color: (role: ColorRole, alpha?: number) => string;
}

/**
 * Build a theme snapshot from the live CSS variables on :root. Call at chart
 * creation and after a light/dark toggle (the tokens change value, not name).
 */
export function readUplotTheme(root: Element = document.documentElement): UplotTheme {
	const cs = getComputedStyle(root);
	const raw = (name: string) => cs.getPropertyValue(name).trim();
	const wrap = (channels: string, alpha?: number) =>
		!channels
			? "transparent"
			: alpha != null && alpha < 1
				? `hsl(${channels} / ${alpha})`
				: `hsl(${channels})`;

	return {
		axis: wrap(raw("--border")),
		grid: wrap(raw("--border"), 0.5),
		text: wrap(raw("--muted-foreground")),
		// Match the SVG charts' JetBrains Mono tick labels for visual continuity.
		font: '10px "JetBrains Mono", ui-monospace, monospace',
		cursor: wrap(raw("--muted-foreground"), 0.55),
		color: (role, alpha) => wrap(raw(ROLE_TOKEN[role]), alpha),
	};
}

/** A stable key that changes when the active theme changes, to force a re-theme. */
export function currentThemeKey(root: Element = document.documentElement): string {
	return root.getAttribute("data-theme") ?? "default";
}
