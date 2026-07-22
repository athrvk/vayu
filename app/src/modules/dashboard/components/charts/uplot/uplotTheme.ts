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

/** Semantic color roles, mapped to CSS custom properties. */
export type ColorRole =
	| "primary"
	| "success"
	| "warning"
	| "destructive"
	| "info"
	| "muted"
	| "subtle"
	| "accent"
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

const ROLE_TOKEN: Record<ColorRole, string> = {
	primary: "--primary",
	success: "--success",
	warning: "--warning",
	destructive: "--destructive",
	info: "--info",
	muted: "--muted-foreground",
	subtle: "--subtle-foreground",
	accent: "--accent",
	categorical: "--chart-3",
	"status-success": "--status-success",
	"status-redirect": "--status-redirect",
	"status-client-error": "--status-warning",
	"status-server-error": "--status-error",
	"status-no-response": "--status-no-response",
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
