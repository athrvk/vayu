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
	| "categorical";

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
