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
import { render } from "@testing-library/react";
import type * as Monaco from "monaco-editor";
import { CodeEditor } from "./code-editor";
import { SEND_CHORD, LOAD_TEST_CHORD } from "@/constants/shortcuts";
import { chordKeybinding } from "@/lib/editor-chords";

const addCommand = vi.fn();

/** Monaco's two enums, with the real values for the keys in play. */
const monaco = {
	KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 },
	KeyCode: { Enter: 3, Digit1: 22, KeyA: 31 },
} as unknown as typeof Monaco;

vi.mock("@monaco-editor/react", () => ({
	Editor: ({ onMount }: { onMount?: (e: unknown, m: unknown) => void }) => {
		onMount?.({ addCommand }, monaco);
		return <div data-testid="editor" />;
	},
}));

describe("CodeEditor keyboard wiring", () => {
	it("registers the send and load-test chords on every instance", () => {
		addCommand.mockClear();
		render(<CodeEditor value="" language="json" />);
		expect(addCommand.mock.calls.map((c) => c[0])).toEqual([
			chordKeybinding(SEND_CHORD, monaco),
			chordKeybinding(LOAD_TEST_CHORD, monaco),
		]);
	});

	it("still runs the caller's own onMount", () => {
		addCommand.mockClear();
		const onMount = vi.fn();
		render(<CodeEditor value="" language="json" onMount={onMount} />);
		expect(onMount).toHaveBeenCalledTimes(1);
		expect(addCommand).toHaveBeenCalledTimes(2);
	});
});
