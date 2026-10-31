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
 * The response body follows Settings > Editor > Font size (#3139).
 *
 * `CodeEditor` lets an explicit `fontSize` prop win over the preference, so a
 * size hardcoded at this call site (it was 12 in the `compact` pane, 13
 * otherwise) silently ignored the setting. The real `CodeEditor` is rendered under a stub Monaco
 * `Editor` that records the options it receives, because a mock of
 * `CodeEditor` would only see the prop and never what the editor is given.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const PREFERRED_FONT_SIZE = 18;

const received = vi.hoisted(() => ({ options: undefined as { fontSize?: number } | undefined }));

const fakeMonaco = {
	languages: {},
	editor: { defineTheme: () => {} },
} as unknown as typeof import("monaco-editor");

vi.mock("@monaco-editor/react", () => ({
	Editor: (props: { options: { fontSize?: number } }) => {
		received.options = props.options;
		return <div data-testid="editor" />;
	},
}));

vi.mock("@/lib/monaco-setup", () => ({ monaco: fakeMonaco }));

vi.mock("@/stores", () => ({
	useClientSettingsStore: (select: (state: unknown) => unknown) =>
		select({
			editor: {
				fontSize: PREFERRED_FONT_SIZE,
				wordWrap: true,
				minimap: false,
				lineNumbers: true,
				tabSize: 2,
			},
		}),
}));

vi.mock("@/stores/client-settings-store", () => ({
	selectMonoStack: () => "monospace",
}));

const { default: ResponseBody } = await import("./ResponseBody");

describe("the response body's editor font size", () => {
	beforeEach(() => {
		received.options = undefined;
	});

	it.each(["pretty", "raw"] as const)("is the editor setting in %s mode", async (defaultMode) => {
		render(
			<ResponseBody
				body='{"a":1}'
				bodyRaw='{"a":1}'
				headers={{ "content-type": "application/json" }}
				defaultMode={defaultMode}
			/>
		);

		await screen.findByTestId("editor");
		expect(received.options?.fontSize).toBe(PREFERRED_FONT_SIZE);
	});
});
