/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The real Monaco editor core under jsdom, for the one thing a stub cannot
 * answer: what the editor does with a model, an undo stack and a changed
 * `value` (#3136).
 *
 * `monaco-editor/editor` is the API with no contributions and no language
 * services, which is all the model and undo machinery needs and is why it loads
 * where `lib/monaco-setup.ts` (its `register.all` calls
 * `document.queryCommandSupported`) does not.
 *
 * A suite mocks the loader with it, because the factory has to be hoisted:
 *
 * ```ts
 * vi.mock("@/lib/monaco-loader", async () =>
 *   (await import("@/test/real-monaco.testkit")).realMonacoLoader()
 * );
 * ```
 */

import type * as Monaco from "monaco-editor";

type Core = typeof import("monaco-editor/editor");

/** What `@/lib/monaco-loader` exports, answered by the real editor core. */
export async function realMonacoLoader() {
	const core: Core = await import("monaco-editor/editor");
	// The JSON language service is not part of the core; the GraphQL variables
	// pane writes its schema to it, and nothing here reads the answer.
	const monaco = {
		...core,
		json: { jsonDefaults: { diagnosticsOptions: {}, setDiagnosticsOptions: () => {} } },
	};
	const { loader } = await import("@monaco-editor/react");
	// Without this `@monaco-editor/react` fetches its own copy from a CDN.
	loader.config({ monaco });
	return { ensureMonaco: async () => monaco, useLoadedMonaco: () => monaco };
}

/** The editor core, the way a test reads models and editors back from it. */
export async function realMonaco(): Promise<Core> {
	return import("monaco-editor/editor");
}

/** Type at the caret the way the keyboard does: one undoable edit. */
export function typeInto(editor: Monaco.editor.ICodeEditor, text: string): void {
	editor.trigger("test", "type", { text });
}

/** Ctrl/Cmd+Z, as the editor's own action. */
export function undo(editor: Monaco.editor.ICodeEditor): void {
	editor.trigger("test", "undo", null);
}
