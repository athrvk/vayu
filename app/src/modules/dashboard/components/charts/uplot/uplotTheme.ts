/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * uplotTheme — bridges Vayu's CSS design tokens into uPlot's Canvas world.
 *
 * SPIKE (N3): the open question with a Canvas charting lib is "can it stay
 * theme-driven like our SVG charts, which use `hsl(var(--token))` everywhere?"
 * Answer: yes. uPlot takes concrete color strings, and our tokens hold raw HSL
 * channels (e.g. `--primary: 222 47% 11%`), so we resolve them at build time via
 * getComputedStyle and hand uPlot real `hsl(...)` strings. Re-resolve whenever
 * the theme flips (light/dark) by re-creating the chart with a new themeKey.
 */

/** Resolve a CSS custom property to a usable `hsl(...)` string. */
function token(root: Element, name: string, alpha = 1): string {
	const raw = getComputedStyle(root).getPropertyValue(name).trim();
	// Tokens store bare HSL channels ("222 47% 11%"); wrap them. Fall back to the
	// raw value if a token is already a full color (defensive).
	if (!raw) return "transparent";
	return alpha < 1 ? `hsl(${raw} / ${alpha})` : `hsl(${raw})`;
}

export interface UplotTheme {
	axis: string;
	grid: string;
	text: string;
	font: string;
	/** Series stroke palette, keyed by semantic role. */
	series: {
		primary: string;
		success: string;
		warning: string;
		destructive: string;
		muted: string;
	};
	/** Translucent fills for area/band series. */
	fill: {
		primary: string;
		destructive: string;
	};
	/** Cursor crosshair + zoom-selection styling. */
	cursor: string;
	selection: string;
}

/**
 * Build a theme snapshot from the live CSS variables on :root. Call at chart
 * creation and after a light/dark toggle (the tokens change value, not name).
 */
export function readUplotTheme(root: Element = document.documentElement): UplotTheme {
	return {
		axis: token(root, "--border"),
		grid: token(root, "--border", 0.5),
		text: token(root, "--subtle-foreground"),
		// Match the SVG charts' JetBrains Mono tick labels for visual continuity.
		font: '10px "JetBrains Mono", ui-monospace, monospace',
		series: {
			primary: token(root, "--primary"),
			success: token(root, "--success"),
			warning: token(root, "--warning"),
			destructive: token(root, "--destructive"),
			muted: token(root, "--muted-foreground"),
		},
		fill: {
			primary: token(root, "--primary", 0.12),
			destructive: token(root, "--destructive", 0.12),
		},
		cursor: token(root, "--muted-foreground", 0.55),
		selection: token(root, "--primary", 0.12),
	};
}

/** A stable key that changes when the active theme changes, to force a re-theme. */
export function currentThemeKey(root: Element = document.documentElement): string {
	return root.getAttribute("data-theme") ?? "default";
}
