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
 * Monaco keeps its own right-click menu (#1359).
 *
 * The app's menu is composed in the main process and would otherwise open over
 * the editor's, which is the one place a right-click already worked. The marker
 * on the container is what says so, and it has to be on the box that wraps the
 * editor rather than on the editor itself: Monaco owns everything inside, and a
 * marker in there would move with an upgrade.
 *
 * Asserted on the rendered element rather than by scanning the source, because
 * a marker spread onto the wrong element still reads as present in the file.
 */

import { describe, it, expect, vi } from "vitest";
import { render, act, screen } from "@testing-library/react";
import { CONTEXT_ATTRIBUTE } from "@/lib/context-menu";

const fakeMonaco = {
	languages: {},
	editor: { defineTheme: () => {} },
} as unknown as typeof import("monaco-editor");

vi.mock("@monaco-editor/react", () => ({
	Editor: () => <div data-testid="editor" />,
}));

vi.mock("@/lib/monaco-setup", () => ({ monaco: fakeMonaco }));

vi.mock("@/stores", () => ({
	useClientSettingsStore: (select: (state: unknown) => unknown) =>
		select({
			editor: { fontSize: 13, wordWrap: true, minimap: false, lineNumbers: true, tabSize: 2 },
		}),
}));

vi.mock("@/stores/client-settings-store", () => ({
	selectMonoStack: () => "monospace",
}));

const { CodeEditor } = await import("./code-editor");

describe("the editor's context marker", () => {
	it("marks the container that holds the editor", async () => {
		const { container } = render(
			<CodeEditor value="{}" language="json" ariaLabel="Request body" />
		);
		await act(async () => {});

		// The guard's own input: without an editor on screen there is nothing for
		// the marker to be wrong about.
		expect(screen.getByTestId("editor")).toBeInTheDocument();

		const marked = container.querySelector(`[${CONTEXT_ATTRIBUTE}="monaco"]`);
		expect(marked, "the editor container should be marked for the context menu").toBeTruthy();
		expect(marked!.querySelector("[data-testid='editor']")).toBeTruthy();
	});
});
