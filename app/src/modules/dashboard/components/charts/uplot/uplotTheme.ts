/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * uplotTheme - bridges Vayu's CSS design tokens into uPlot's Canvas world.
 *
 * uPlot takes concrete color strings, and our tokens hold raw HSL channels
 * (e.g. `--primary: 222 47% 11%`), so we resolve them at build time via
 * getComputedStyle and hand uPlot real `hsl(...)` strings. Re-resolve whenever
 * the theme flips (light/dark) by re-creating the chart with a new themeKey.
 *
 * This keeps the Canvas charts as token-driven as the SVG charts they replace -
 * every color still comes from the design system, nothing is hard-coded.
 */

import { STATUS_CLASS_CSS_VAR } from "@/constants/http-status";

/** Semantic color roles, mapped to CSS custom properties. */
/*
 * There is deliberately no `primary` or `accent` role.
 *
 * Both existed, both resolved to accent-tracking tokens, and neither had a
 * single consumer - four series had used `primary` and were moved off it,
 * because a series painted with the user's accent changes hue per theme and can
 * land on top of a semantic neighbour. CLAUDE.md forbids it and
 * `status-code-series.test.ts` scans for it.
 *
 * A scan catches the mistake after it is written; leaving the roles out of the
 * union means the compiler catches it instead. Nothing is lost: a genuinely
 * categorical series wants `categorical`, and if the accent is ever wanted
 * deliberately it should arrive with a name that says so.
 */
export type ColorRole =
	| "success"
	| "warning"
	| "destructive"
	| "info"
	| "muted"
	| "subtle"
	/**
	 * A categorical series colour, for data that has no semantic meaning of its
	 * own and must stay distinct from the semantic roles above.
	 *
	 * Deliberately not `--chart-1`: that token tracks the user's accent, so a
	 * series painted with it changes hue per theme and can land on top of a
	 * semantic series. `--chart-3` is violet in both themes and is the furthest
	 * of the categorical palette from success/warning/destructive.
	 */
	| "categorical"
	/*
	 * HTTP status classes, resolving to the same `--status-*` family the badges
	 * and history tiles use.
	 *
	 * Separate from the generic roles above on purpose. `success` / `warning` /
	 * `destructive` are a *series* palette wearing semantic names: in this file's
	 * consumers they also paint p50 / p95 / p99 and the error-rate area, which
	 * have nothing to do with HTTP status. Repointing them at `--status-*` would
	 * recolour the latency charts.
	 *
	 * The status-code chart is the one plot whose subject genuinely is status, so
	 * it uses these and shares the vocabulary in `constants/http-status.ts`. It
	 * previously borrowed `categorical` for 3xx and `muted` for a failed
	 * connection - which meant the violet a user saw for 3xx was the same violet
	 * used for p99, HDR latency, the latency breakdown and the throughput area,
	 * so it taught nothing.
	 */
	| "status-success"
	| "status-redirect"
	| "status-client-error"
	| "status-server-error"
	| "status-no-response";

/**
 * Exported for `status-code-series.test.ts`, which asserts the status roles
 * resolve to the `--status-*` family. That was a source scan and broke the
 * moment the values stopped being string literals - the object is the truth,
 * so the test reads the object.
 */
export const ROLE_TOKEN: Record<ColorRole, string> = {
	/*
	 * The series tier, not the banner/button tokens these roles used to point
	 * at. `--warning` measured 2.14 on a light plot and `--destructive` 1.73 on
	 * a dark one - in dark it is a deep red chosen to carry a white button
	 * label, which all but vanishes on a near-black plot. The role names stay
	 * generic because they are: `success` is also p50, `warning` also p95.
	 */
	success: "--series-success",
	warning: "--series-warning",
	destructive: "--series-danger",
	info: "--info",
	muted: "--muted-foreground",
	subtle: "--subtle-foreground",
	categorical: "--chart-3",
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
		text: wrap(raw("--subtle-foreground")),
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
