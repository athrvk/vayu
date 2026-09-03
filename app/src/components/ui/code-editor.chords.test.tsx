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
 * Every editor gets the window chords, and the caller keeps its own `onMount`.
 *
 * The binding lives in the wrapper rather than at the dozen call sites, so the
 * thing that can silently stop being true is the wiring: `registerEditorChords`
 * existing and nobody calling it is exactly the "written but never read" defect
 * this repo keeps finding. Asserting the registration through a rendered
 * `CodeEditor` is what makes deleting the call a failing test.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type * as Monaco from "monaco-editor";
import { CodeEditor } from "./code-editor";
import {
	SEND_CHORD,
	LOAD_TEST_CHORD,
	TOGGLE_CONTEXT_BAR_CHORD,
	FOCUS_URL_CHORD,
	LEAVE_EDITOR_CHORD,
} from "@/constants/shortcuts";
import { chordKeybinding } from "@/lib/editor-chords";
import { chordKeys } from "@/lib/platform";

const addCommand = vi.fn();
const getContainerDomNode = vi.fn(() => document.createElement("div"));

/**
 * Monaco's two enums, with the real values for the keys in play, plus the one
 * `editor` member the wrapper reaches for: it registers the app's theme on the
 * instance it is handed (#1321). `code-editor.theme.test.tsx` is what asserts
 * on that call; here it only has to exist.
 */
const monaco = {
	KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 },
	KeyCode: { Enter: 3, Digit1: 22, KeyA: 31 },
	editor: { defineTheme: vi.fn() },
} as unknown as typeof Monaco;

/** Options the wrapper handed Monaco on the last render. */
let lastOptions: Record<string, unknown> = {};

vi.mock("@monaco-editor/react", () => ({
	Editor: ({
		onMount,
		options,
	}: {
		onMount?: (e: unknown, m: unknown) => void;
		options?: Record<string, unknown>;
	}) => {
		lastOptions = options ?? {};
		onMount?.({ addCommand, getContainerDomNode }, monaco);
		return <div data-testid="editor" />;
	},
}));

/*
 * `CodeEditor` gates rendering `<Editor>` on `useLoadedMonaco` since #1146,
 * showing a loading skeleton until it resolves. This suite is about chord
 * registration, not that loading boundary, so the loader is mocked resolved
 * and the editor mounts synchronously.
 */
vi.mock("@/lib/monaco-loader", () => ({
	useLoadedMonaco: () => monaco,
	ensureMonaco: () => Promise.resolve(monaco),
}));

describe("CodeEditor keyboard wiring", () => {
	it("registers the send, load-test, context-bar, focus-URL and leave chords on every instance", () => {
		addCommand.mockClear();
		render(<CodeEditor value="" language="json" ariaLabel="Request body" />);
		// ⌘I is in the list because Monaco binds it for `triggerSuggest` and
		// stops it: drop it and the context bar stops toggling from an editor,
		// which is invisible from `Shell`, where the handler still looks correct.
		// ⌘L is there for the same reason - Monaco binds it to
		// `expandLineSelection`, so the URL bar became unreachable from a body.
		expect(addCommand.mock.calls.map((c) => c[0])).toEqual([
			chordKeybinding(SEND_CHORD, monaco),
			chordKeybinding(LOAD_TEST_CHORD, monaco),
			chordKeybinding(TOGGLE_CONTEXT_BAR_CHORD, monaco),
			chordKeybinding(FOCUS_URL_CHORD, monaco),
			chordKeybinding(LEAVE_EDITOR_CHORD, monaco),
		]);
	});

	it("still runs the caller's own onMount", () => {
		addCommand.mockClear();
		const onMount = vi.fn();
		render(<CodeEditor value="" language="json" ariaLabel="Request body" onMount={onMount} />);
		expect(onMount).toHaveBeenCalledTimes(1);
		expect(addCommand).toHaveBeenCalledTimes(5);
	});
});

describe("CodeEditor accessibility options", () => {
	it("names the editor for a screen reader, instead of Monaco's default", () => {
		render(<CodeEditor value="" language="json" ariaLabel="GraphQL variables" />);
		expect(lastOptions.ariaLabel).toBe("GraphQL variables");
	});

	it("lets Tab leave a read-only editor, where it has nothing to indent", () => {
		render(<CodeEditor value="" language="json" ariaLabel="Response body" readOnly />);
		expect(lastOptions.tabFocusMode).toBe(true);
	});

	it("keeps Tab indenting an editable one, which has the chord and the hint instead", () => {
		render(<CodeEditor value="" language="json" ariaLabel="Request body" />);
		expect(lastOptions.tabFocusMode).toBe(false);
	});
});

/**
 * A chord nothing advertises is a chord nobody presses.
 *
 * On focus rather than always: the hint is worth its place over the content
 * only while someone is in the editor it is the way out of, and every editable
 * pane in the app would otherwise carry a standing badge.
 */
describe("the leave-editor hint", () => {
	const hint = () => screen.queryByText("Leave editor");

	it("stays out of the way until the editor has focus", () => {
		render(<CodeEditor value="" language="json" ariaLabel="Request body" />);
		expect(hint()).toBeNull();
	});

	it("appears when focus enters, spelling the chord from the registry", () => {
		render(<CodeEditor value="" language="json" ariaLabel="Request body" />);
		fireEvent.focus(screen.getByTestId("editor"));
		expect(hint()).toBeInTheDocument();
		for (const cap of chordKeys(LEAVE_EDITOR_CHORD)) {
			expect(screen.getByText(cap)).toBeInTheDocument();
		}
	});

	it("goes again when focus leaves", () => {
		render(<CodeEditor value="" language="json" ariaLabel="Request body" />);
		fireEvent.focus(screen.getByTestId("editor"));
		fireEvent.blur(screen.getByTestId("editor"));
		expect(hint()).toBeNull();
	});

	it("never shows on a read-only editor, which Tab already leaves", () => {
		render(<CodeEditor value="" language="json" ariaLabel="Response body" readOnly />);
		fireEvent.focus(screen.getByTestId("editor"));
		expect(hint()).toBeNull();
	});
});
