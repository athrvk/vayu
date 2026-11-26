/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The request body editor's JSON diagnostics (#3137). A `{{variable}}` outside a string is not
 * JSON, and the engine resolves it before sending, so Monaco's JSON worker must neither mark it nor
 * stop at it, which hides every real error after it. The masked twin in
 * `lib/graphql/variables-diagnostics.ts` gives the worker a document it can read.
 *
 * **The twin follows the model's language, not the body mode.** Every non-GraphQL mode shares one
 * model path per request, so choosing XML changes the language of the model the JSON worker
 * validated, and a twin kept across it would publish JSON markers onto XML. So it is attached while
 * the model is JSON (`json`, `jsonrpc`), dropped otherwise, and re-decided on the three events that
 * change the answer: mount, a request switch (`setModel`), a language change.
 * `@monaco-editor/react` applies a path change before a language change in one render, so the end
 * state is right either way.
 */

import type { OnMount } from "@monaco-editor/react";
import { attachVariablesDiagnostics } from "@/lib/graphql/variables-diagnostics";

const JSON_LANGUAGE_ID = "json";

/**
 * `CodeEditor`'s `onMount` for the body editor. The twin belongs to the editor instance, which
 * `CodeEditor` disposes when the Source / Resolved swap hides it or the panel unmounts, so its
 * lifetime is held in this closure and ended by the editor's disposal.
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
