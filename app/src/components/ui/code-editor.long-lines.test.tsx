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
 * A viewer draws every column of a line (#3140).
 *
 * Monaco stops painting a line after `stopRenderingLineAfter` columns (10,000
 * by default) and draws nothing past it, so a minified response, which is one
 * line, was cut off mid-token with no sign that text was missing. A read-only
 * editor passes -1 (no limit); an editable one keeps Monaco's default.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import type * as Monaco from "monaco-editor";
import { CodeEditor } from "./code-editor";

const monaco = {
	editor: { defineTheme: vi.fn() },
	KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 },
	KeyCode: { Enter: 3, Digit1: 22, KeyA: 31 },
} as unknown as typeof Monaco;

/** The options the wrapper passed to `<Editor>` on its last render. */
let lastOptions: Monaco.editor.IStandaloneEditorConstructionOptions | undefined;

vi.mock("@monaco-editor/react", () => ({
	Editor: ({ options }: { options?: Monaco.editor.IStandaloneEditorConstructionOptions }) => {
		lastOptions = options;
		return <div data-testid="editor" />;
	},
}));

vi.mock("@/lib/monaco-loader", () => ({
	useLoadedMonaco: () => monaco,
	ensureMonaco: () => Promise.resolve(monaco),
}));

async function renderEditor(props: { readOnly?: boolean; options?: typeof lastOptions }) {
	render(<CodeEditor value="" language="json" ariaLabel="Response body" {...props} />);
	await act(async () => {});
}

beforeEach(() => {
	lastOptions = undefined;
});

describe("CodeEditor long lines", () => {
	it("draws a read-only editor's lines in full", async () => {
		await renderEditor({ readOnly: true });
		expect(lastOptions?.stopRenderingLineAfter).toBe(-1);
	});

	it("leaves an editable editor on Monaco's default limit", async () => {
		await renderEditor({ readOnly: false });
		expect(lastOptions).toBeDefined();
		expect(lastOptions?.stopRenderingLineAfter).toBeUndefined();
	});

	it("lets a caller's options override either", async () => {
		await renderEditor({ readOnly: true, options: { stopRenderingLineAfter: 500 } });
		expect(lastOptions?.stopRenderingLineAfter).toBe(500);

		await renderEditor({ readOnly: false, options: { stopRenderingLineAfter: -1 } });
		expect(lastOptions?.stopRenderingLineAfter).toBe(-1);
	});
});
