/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The wrapper hands Monaco the app's theme, and keeps handing it one (#1321).
 *
 * Two failures this pins, both invisible from the editor's own code: the theme
 * name going back to `vs`/`vs-dark`, which puts VS Code's palette on every
 * widget, and the name being handed over without the theme ever being defined,
 * which Monaco answers by silently falling back to `vs` and never revisiting.
 *
 * The mode is stubbed on `<html>` in both directions rather than read from the
 * host: a case that only ever runs light asserts nothing about the half of the
 * app that is dark.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import type * as Monaco from "monaco-editor";
import { CodeEditor } from "./code-editor";

const defineTheme = vi.fn();

const monaco = {
	editor: { defineTheme },
	KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 },
	KeyCode: { Enter: 3, Digit1: 22, KeyA: 31 },
} as unknown as typeof Monaco;

/** The theme name the wrapper passed on the last render. */
let lastTheme: string | undefined;

vi.mock("@monaco-editor/react", () => ({
	Editor: ({ theme }: { theme?: string }) => {
		lastTheme = theme;
		return <div data-testid="editor" />;
	},
}));

vi.mock("@/lib/monaco-loader", () => ({
	useLoadedMonaco: () => monaco,
	ensureMonaco: () => Promise.resolve(monaco),
}));

function setMode(dark: boolean) {
	document.documentElement.classList.toggle("dark", dark);
}

beforeEach(() => {
	defineTheme.mockClear();
	lastTheme = undefined;
});

afterEach(() => {
	document.documentElement.classList.remove("dark");
	document.documentElement.removeAttribute("data-color-scheme");
});

describe("CodeEditor theme", () => {
	it("uses the app's dark theme, not Monaco's", () => {
		setMode(true);
		render(<CodeEditor value="" language="json" ariaLabel="Request body" />);
		expect(lastTheme).toBe("vayu-dark");
		expect(defineTheme).toHaveBeenCalledWith(
			"vayu-dark",
			expect.objectContaining({ base: "vs-dark" })
		);
	});

	it("uses the app's light theme, not Monaco's", () => {
		setMode(false);
		render(<CodeEditor value="" language="json" ariaLabel="Request body" />);
		expect(lastTheme).toBe("vayu-light");
		expect(defineTheme).toHaveBeenCalledWith(
			"vayu-light",
			expect.objectContaining({ base: "vs" })
		);
	});

	it("follows a mode switch with the definition, then the name", async () => {
		setMode(false);
		render(<CodeEditor value="" language="json" ariaLabel="Request body" />);
		defineTheme.mockClear();

		await act(async () => {
			setMode(true);
			// The observer runs as a microtask; the state update it makes is what
			// re-renders `<Editor>` with the new name.
			await Promise.resolve();
		});

		expect(defineTheme).toHaveBeenCalledWith("vayu-dark", expect.anything());
		expect(lastTheme).toBe("vayu-dark");
	});

	it("redefines the theme when the accent scheme changes, without a remount", async () => {
		setMode(true);
		render(<CodeEditor value="" language="json" ariaLabel="Request body" />);
		defineTheme.mockClear();

		await act(async () => {
			// What Settings > Appearance writes. It moves `--primary`, which is the
			// editor's selection colour, and it never touches the `dark` class - so
			// a hook watching the class alone would leave the old selection in place.
			document.documentElement.setAttribute("data-color-scheme", "forest");
			await Promise.resolve();
		});

		expect(defineTheme).toHaveBeenCalledWith("vayu-dark", expect.anything());
		expect(lastTheme).toBe("vayu-dark");
	});
});
