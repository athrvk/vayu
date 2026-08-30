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
 * `CodeEditor` is where Monaco is loaded, and the order is the requirement
 * (#1146).
 *
 * `@monaco-editor/loader`'s `init()` injects a `cdn.jsdelivr.net` script tag
 * when no instance has been configured, and it latches on the first call - so
 * an `<Editor>` mounted before `ensureMonaco()` resolves would reach for a
 * copy of Monaco over the network, in a desktop app that ships one and may be
 * offline. Rendering the placeholder instead of the editor is what prevents
 * that, which is why it is asserted rather than left to the comment.
 *
 * The failure path is here for the same reason: a rejected chunk load used to
 * be indistinguishable from a slow one, and a skeleton that never resolves is
 * the worst of the two.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

const fakeMonaco = { languages: {} } as unknown as typeof import("monaco-editor");

vi.mock("@monaco-editor/react", () => ({
	Editor: () => <div data-testid="editor" />,
}));

vi.mock("@/stores", () => ({
	useClientSettingsStore: (select: (state: unknown) => unknown) =>
		select({
			editor: {
				fontSize: 13,
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

type CodeEditorModule = typeof import("./code-editor");

/**
 * A `CodeEditor` whose Monaco load resolves or rejects on demand, with no
 * state carried over from the previous case (the loader memoizes per module
 * instance, and a resolved load would make the next case's placeholder
 * unreachable).
 */
async function freshEditor(setup: () => { monaco: typeof fakeMonaco }): Promise<CodeEditorModule> {
	vi.resetModules();
	vi.doMock("@/lib/monaco-setup", setup);
	return import("./code-editor");
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("the editor waits for Monaco", () => {
	it("shows the placeholder, and no editor, until the load resolves", async () => {
		const { CodeEditor } = await freshEditor(() => ({ monaco: fakeMonaco }));

		render(<CodeEditor value="" language="json" />);

		// The mutation check: render `<Editor>` without the `useLoadedMonaco`
		// gate and this passes an editor straight through, which is the
		// `init()`-before-`config()` CDN fetch the gate exists to prevent.
		expect(screen.queryByTestId("editor")).toBeNull();
		expect(screen.getByRole("status", { name: "Loading editor" })).toBeInTheDocument();

		// The assertions above are the point of the case and belong before the
		// load lands. Flushing it afterwards is what keeps the state update it
		// causes inside `act` instead of arriving during teardown as a warning.
		await act(async () => {});
	});

	it("swaps the placeholder for the editor once Monaco is there", async () => {
		const { CodeEditor } = await freshEditor(() => ({ monaco: fakeMonaco }));

		render(<CodeEditor value="" language="json" />);
		await act(async () => {});

		expect(screen.getByTestId("editor")).toBeInTheDocument();
		expect(screen.queryByRole("status", { name: "Loading editor" })).toBeNull();
	});
});

describe("a failed load says so", () => {
	it("replaces the placeholder with an alert instead of waiting forever", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const { CodeEditor } = await freshEditor(() => {
			throw new Error("chunk load failed");
		});

		render(<CodeEditor value="" language="json" />);
		await act(async () => {});

		expect(screen.getByRole("alert")).toHaveTextContent(/editor failed to load/i);
		expect(screen.queryByRole("status", { name: "Loading editor" })).toBeNull();
		expect(consoleError).toHaveBeenCalled();
	});
});
