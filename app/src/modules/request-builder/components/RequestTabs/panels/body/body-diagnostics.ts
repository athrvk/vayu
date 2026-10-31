/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The request body editor's JSON diagnostics (#3137).
 *
 * A `{{variable}}` outside a string is not JSON, and the engine resolves it
 * before the body is sent, so Monaco's JSON worker must not mark it - and must
 * not stop at it, which hides every real error after it. The masked twin in
 * `lib/graphql/variables-diagnostics.ts` is what gives the worker a document it
 * can read.
 *
 * **The twin follows the model's language, not the body mode.** Every
 * non-GraphQL body mode shares one model path per request, so choosing XML
 * changes the language of the model the JSON worker was validating. A twin kept
 * across that would publish JSON-owner markers onto an XML document. The twin is
 * therefore attached while the editor's model is JSON (the `json` and `jsonrpc`
 * modes), dropped when it is not, and re-decided on each of the three events that
 * can change the answer: mount, a request switch (`setModel`), and a language
 * change. `@monaco-editor/react` applies a path change before a language change
 * when both land in one render, so the final state is the right one either way.
 */

import type { OnMount } from "@monaco-editor/react";
import { attachVariablesDiagnostics } from "@/lib/graphql/variables-diagnostics";

const JSON_LANGUAGE_ID = "json";

/**
 * `CodeEditor`'s `onMount` for the body editor. The twin belongs to the editor
 * instance, which `CodeEditor` tears down when the Source / Resolved swap hides
 * it and when the panel unmounts, so its lifetime is held in this closure and
 * ended by the editor's own disposal.
 */
export const mountBodyDiagnostics: OnMount = (editor, monaco) => {
	let twin: { dispose: () => void } | null = null;

	const sync = () => {
		twin?.dispose();
		twin = null;
		const model = editor.getModel();
		if (model?.getLanguageId() === JSON_LANGUAGE_ID) {
			twin = attachVariablesDiagnostics(monaco, model);
		}
	};

	sync();
	editor.onDidChangeModel(sync);
	editor.onDidChangeModelLanguage(sync);
	editor.onDidDispose(() => {
		twin?.dispose();
		twin = null;
	});
};
