/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Monaco's widgets, painted from the app's own tokens (#1321).
 *
 * The editor text is Monaco's syntax palette and stays that way - `inherit`
 * below keeps it. What this module replaces is the *chrome* Monaco draws
 * around it: the suggest list the three completion providers open, the find
 * and replace widget, the hover card, the context menu. Those shipped in VS
 * Code's colours (`#252526` panels on `#454545` borders in dark, white on
 * white in light) next to Radix popovers on `--popover`, because
 * `CodeEditor` handed Monaco the built-in theme names and the app defined
 * none of its own.
 *
 * **Only the active mode is defined.** `getComputedStyle` reports the values
 * that are live on the element, so the light palette is unreadable while the
 * `dark` class is on `<html>` and the reverse. `registerMonacoTheme` therefore
 * defines the one theme the app is wearing, and is called again whenever the
 * mode or the accent scheme changes - see `useMonacoTheme`, which also
 * explains why that call cannot wait for a React effect.
 *
 * The rejected alternative was CSS: a `defineTheme`-free stylesheet over
 * `.monaco-hover` and `.suggest-widget`. Monaco writes the theme's colours
 * onto those nodes as inline styles and paints selection and find matches on
 * its own canvas, where no rule reaches them at all, so the CSS answer covers
 * part of one widget and needs `!important` to do it. Colours that come from
 * the theme data are colours the tokens actually own.
 */

import type * as Monaco from "monaco-editor";
import type { MonacoApi } from "./monaco-api";

export type EditorMode = "light" | "dark";

/** The theme names the app registers, one per mode. */
export const MONACO_THEME_NAMES = {
	light: "vayu-light",
	dark: "vayu-dark",
} as const satisfies Record<EditorMode, string>;

export type MonacoThemeName = (typeof MONACO_THEME_NAMES)[EditorMode];

/** Monaco keeps the syntax colours; only the chrome is ours. */
const BASE_THEME = {
	light: "vs",
	dark: "vs-dark",
} as const satisfies Record<EditorMode, Monaco.editor.BuiltinTheme>;

/** A token name (without the `--`) and the alpha the colour is used at. */
interface TokenRef {
	token: string;
	/** 0-1. Omitted means opaque. */
	alpha?: number;
}

/**
 * The app's scrollbar thumb, from `::-webkit-scrollbar-thumb` in `index.css`
 * (`bg-muted-foreground/30`, `/50` on hover). Monaco draws its bars as its own
 * DOM and no stylesheet rule reaches them - the same reason `SCROLLBAR_SIZE`
 * in `code-editor.tsx` exists - so the two alphas are restated here and the
 * third is the pressed state Monaco has and the native bar does not.
 */
const SLIDER_ALPHA = { rest: 0.3, hover: 0.5, active: 0.65 } as const;

/**
 * Every widget colour the app owns, and the token behind it.
 *
 * A key absent from here keeps whatever the base theme says, which is the
 * right answer for anything the tokens have no opinion about (bracket pair
 * colours, the diff editor). A key present here and missing a token at runtime
 * is dropped rather than defaulted - see `buildMonacoTheme`.
 */
export const WIDGET_COLORS = {
	// The editor surface itself, so the canvas under the widgets is the app's
	// and not Monaco's near-black `#1e1e1e`.
	"editor.background": { token: "background" },
	"editor.foreground": { token: "foreground" },
	"editorGutter.background": { token: "background" },
	"editorLineNumber.foreground": { token: "muted-foreground" },
	"editorLineNumber.activeForeground": { token: "foreground" },
	"editorCursor.foreground": { token: "foreground" },

	// Selection and find matches are canvas-painted, which is why they have to
	// come from the theme data rather than from a stylesheet.
	"editor.selectionBackground": { token: "primary", alpha: 0.3 },
	"editor.inactiveSelectionBackground": { token: "primary", alpha: 0.18 },
	"editor.selectionHighlightBackground": { token: "primary", alpha: 0.14 },
	"editor.findMatchBackground": { token: "primary", alpha: 0.45 },
	"editor.findMatchHighlightBackground": { token: "primary", alpha: 0.22 },

	// The floating surfaces: one fill, one foreground, one border, the same
	// three a Radix popover uses.
	focusBorder: { token: "primary" },
	"editorWidget.background": { token: "popover" },
	"editorWidget.foreground": { token: "popover-foreground" },
	"editorWidget.border": { token: "border" },
	"editorSuggestWidget.background": { token: "popover" },
	"editorSuggestWidget.foreground": { token: "popover-foreground" },
	"editorSuggestWidget.border": { token: "border" },
	"editorSuggestWidget.selectedBackground": { token: "accent" },
	"editorSuggestWidget.selectedForeground": { token: "foreground" },
	"editorSuggestWidget.highlightForeground": { token: "primary" },
	"editorSuggestWidget.focusHighlightForeground": { token: "primary" },
	"editorHoverWidget.background": { token: "popover" },
	"editorHoverWidget.foreground": { token: "popover-foreground" },
	"editorHoverWidget.border": { token: "border" },
	"menu.background": { token: "popover" },
	"menu.foreground": { token: "popover-foreground" },
	"menu.border": { token: "border" },
	"menu.selectionBackground": { token: "accent" },
	"menu.selectionForeground": { token: "foreground" },

	// The rows inside them - the suggest list and the context menu are both
	// Monaco lists.
	"list.hoverBackground": { token: "accent" },
	"list.hoverForeground": { token: "foreground" },
	"list.focusBackground": { token: "accent" },
	"list.focusForeground": { token: "foreground" },
	"list.highlightForeground": { token: "primary" },

	// The find widget's input, which is a plain box in VS Code's palette.
	"input.background": { token: "background" },
	"input.foreground": { token: "foreground" },
	"input.border": { token: "border" },
	"inputOption.activeBorder": { token: "primary" },

	"scrollbarSlider.background": { token: "muted-foreground", alpha: SLIDER_ALPHA.rest },
	"scrollbarSlider.hoverBackground": { token: "muted-foreground", alpha: SLIDER_ALPHA.hover },
	"scrollbarSlider.activeBackground": { token: "muted-foreground", alpha: SLIDER_ALPHA.active },
} as const satisfies Record<string, TokenRef>;

/** The tokens `WIDGET_COLORS` reads, each named once. */
export const THEME_TOKENS: readonly string[] = [
	...new Set(Object.values(WIDGET_COLORS).map((ref: TokenRef) => ref.token)),
];

/** Token name (without the `--`) to its declared value, as the DOM reports it. */
export type TokenValues = Readonly<Record<string, string>>;

function channel(value: number): string {
	return Math.round(Math.min(1, Math.max(0, value)) * 255)
		.toString(16)
		.padStart(2, "0");
}

/**
 * One of the app's HSL triples (`240 6% 11%`, the shape every colour token is
 * declared in) as the hex Monaco's theme data requires. Returns null for a
 * value that is not a triple, including the empty string `getComputedStyle`
 * gives for a token that does not exist.
 */
export function hslTokenToHex(value: string, alpha?: number): string | null {
	const parsed = /^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/.exec(value.trim());
	if (!parsed) return null;

	const hue = Number(parsed[1]) / 60;
	const saturation = Number(parsed[2]) / 100;
	const lightness = Number(parsed[3]) / 100;

	const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
	const second = chroma * (1 - Math.abs((hue % 2) - 1));
	const sector = Math.floor(hue) % 6;
	const [r, g, b] = (
		[
			[chroma, second, 0],
			[second, chroma, 0],
			[0, chroma, second],
			[0, second, chroma],
			[second, 0, chroma],
			[chroma, 0, second],
		] as const
	)[sector < 0 ? 0 : sector];

	const base = lightness - chroma / 2;
	const rgb = `#${channel(r + base)}${channel(g + base)}${channel(b + base)}`;
	return alpha === undefined ? rgb : `${rgb}${channel(alpha)}`;
}

/**
 * The theme data for one mode. Pure: the tokens come in, so a test can drive
 * it without a stylesheet (vitest stubs a CSS import to `""`, and jsdom
 * computes nothing from one that was never loaded).
 */
export function buildMonacoTheme(
	mode: EditorMode,
	tokens: TokenValues
): Monaco.editor.IStandaloneThemeData {
	const colors: Record<string, string> = {};
	for (const [key, ref] of Object.entries(WIDGET_COLORS) as [string, TokenRef][]) {
		const hex = hslTokenToHex(tokens[ref.token] ?? "", ref.alpha);
		// A token the stylesheet stopped declaring leaves its key out, so the
		// base theme's own colour stands. A fallback constant here would paint
		// black over a widget and read as a decision someone made.
		if (hex) colors[key] = hex;
	}
	return { base: BASE_THEME[mode], inherit: true, rules: [], colors };
}

/** What the document is wearing right now. */
export function currentEditorMode(root: HTMLElement = document.documentElement): EditorMode {
	return root.classList.contains("dark") ? "dark" : "light";
}

/** The tokens as the document currently resolves them, accent scheme included. */
export function readTokenValues(root: HTMLElement = document.documentElement): TokenValues {
	const computed = getComputedStyle(root);
	const values: Record<string, string> = {};
	for (const token of THEME_TOKENS)
		values[token] = computed.getPropertyValue(`--${token}`).trim();
	return values;
}

/**
 * Define the theme for the mode the document is in, and name it.
 *
 * Idempotent, and the only way the themes are registered: `monaco-setup` calls
 * it once as it composes Monaco (before any editor can be created with a name
 * Monaco does not know), and `useMonacoTheme` calls it again on every mode or
 * accent change. Redefining the *active* theme is how a scheme change reaches
 * an open editor - Monaco re-applies a theme that is redefined under the name
 * it is already showing.
 */
export function registerMonacoTheme(
	monaco: MonacoApi,
	root: HTMLElement = document.documentElement
): MonacoThemeName {
	const mode = currentEditorMode(root);
	const name = MONACO_THEME_NAMES[mode];
	monaco.editor.defineTheme(name, buildMonacoTheme(mode, readTokenValues(root)));
	return name;
}
