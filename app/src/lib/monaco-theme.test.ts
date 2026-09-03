/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The theme data Monaco's widgets are painted from (#1321).
 *
 * Driven with a stub token map rather than through a rendered editor: vitest
 * stubs a CSS import to `""` and jsdom computes nothing from a stylesheet that
 * was never loaded, so a test that read the real tokens would assert on empty
 * strings and pass whatever the builder did with them.
 *
 * The last concern is the one that keeps this module the single source of the
 * theme name: a `"vs-dark"` written at any other call site is a widget back in
 * VS Code's palette, and nothing on screen says which file did it.
 */

import { describe, it, expect } from "vitest";
import {
	MONACO_THEME_NAMES,
	THEME_TOKENS,
	WIDGET_COLORS,
	buildMonacoTheme,
	hslTokenToHex,
} from "./monaco-theme";

/**
 * Round values, so an expectation reads as a colour rather than as arithmetic.
 * Every token `WIDGET_COLORS` names has an entry; cases that test a gap remove
 * one from a copy.
 */
const TOKENS: Record<string, string> = {
	background: "0 0% 100%",
	foreground: "0 0% 0%",
	popover: "240 100% 50%",
	"popover-foreground": "0 0% 100%",
	border: "0 0% 50%",
	accent: "120 100% 25%",
	primary: "0 100% 50%",
	"muted-foreground": "0 0% 50%",
};

describe("hslTokenToHex", () => {
	it("converts the triple shape every colour token is declared in", () => {
		expect(hslTokenToHex("0 0% 100%")).toBe("#ffffff");
		expect(hslTokenToHex("0 0% 0%")).toBe("#000000");
		expect(hslTokenToHex("240 100% 50%")).toBe("#0000ff");
		expect(hslTokenToHex("120 100% 25%")).toBe("#008000");
		// The shape as `getComputedStyle` reports it, with the leading space a
		// declaration written `--x: 240 6% 11%` keeps.
		expect(hslTokenToHex(" 240 6% 11% ")).toBe("#1a1a1e");
	});

	it("appends the alpha byte Monaco's canvas colours need", () => {
		expect(hslTokenToHex("0 100% 50%", 0.3)).toBe("#ff00004d");
		expect(hslTokenToHex("0 100% 50%", 1)).toBe("#ff0000ff");
	});

	it("returns null for anything that is not a triple", () => {
		// What a token that no longer exists resolves to.
		expect(hslTokenToHex("")).toBeNull();
		expect(hslTokenToHex("#1e1e1e")).toBeNull();
		expect(hslTokenToHex("var(--primary)")).toBeNull();
	});
});

describe("buildMonacoTheme", () => {
	it("inherits the base theme's syntax colours in both modes", () => {
		expect(buildMonacoTheme("light", TOKENS)).toMatchObject({ base: "vs", inherit: true });
		expect(buildMonacoTheme("dark", TOKENS)).toMatchObject({ base: "vs-dark", inherit: true });
	});

	it("paints the widget surfaces from the tokens, in both modes", () => {
		for (const mode of ["light", "dark"] as const) {
			const { colors } = buildMonacoTheme(mode, TOKENS);
			// The floating surface, the row under the cursor, and the selection
			// the accent scheme moves.
			expect(colors["editorWidget.background"]).toBe("#0000ff");
			expect(colors["editorSuggestWidget.selectedBackground"]).toBe("#008000");
			expect(colors["editor.selectionBackground"]).toBe("#ff00004d");
		}
	});

	it("leaves a key out when its token is gone, rather than defaulting it", () => {
		// A dropped key means "keep what `vs-dark` says". A fallback constant
		// would paint a real colour - black, usually - and read as a decision.
		const without = { ...TOKENS };
		delete without.accent;
		const { colors } = buildMonacoTheme("dark", without);
		expect(colors["editorSuggestWidget.selectedBackground"]).toBeUndefined();
		expect(colors["editorWidget.background"]).toBe("#0000ff");
	});

	it("names every token it reads, so the DOM read collects them", () => {
		const named = new Set(THEME_TOKENS);
		const read = Object.values(WIDGET_COLORS).map((ref) => ref.token);
		expect(read.length).toBeGreaterThan(10);
		expect(read.every((token) => named.has(token))).toBe(true);
		// And the stub above covers all of them, so the assertions here are not
		// passing over keys the builder silently dropped.
		expect(THEME_TOKENS.filter((token) => !(token in TOKENS))).toEqual([]);
	});
});

describe("the theme name has one source", () => {
	const sources = Object.entries(
		import.meta.glob("/src/**/*.{ts,tsx}", {
			query: "?raw",
			import: "default",
			eager: true,
		}) as Record<string, string>
	).filter(([path]) => !path.includes(".test.") && !path.endsWith("/monaco-theme.ts"));

	it("finds the files it is meant to be guarding", () => {
		// A broken glob matches nothing and the assertion below passes for free.
		expect(sources.length).toBeGreaterThan(100);
	});

	it("passes no built-in Monaco theme name outside this module", () => {
		const offenders = sources
			.filter(([, source]) => /["']vs(-dark)?["']/.test(source))
			.map(([path]) => path);
		expect(offenders).toEqual([]);
	});

	it("registers a name Monaco accepts", () => {
		// `defineTheme` throws on anything outside this shape, and it would throw
		// inside `monaco-setup`, where the whole editor is being composed.
		for (const name of Object.values(MONACO_THEME_NAMES)) expect(name).toMatch(/^[a-z0-9-]+$/i);
	});
});
