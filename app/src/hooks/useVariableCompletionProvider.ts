/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * useVariableCompletionProvider Hook
 *
 * `{{variable}}` autocomplete inside the Monaco editors.
 *
 * Every plain field in the request builder has had this for a long time -
 * `VariableInput` pops a list the moment you type `{{`. The body editors never
 * did, so the one place you write the *longest* payloads was also the only
 * place you had to remember a variable's name and spell it yourself.
 *
 * **Registered for the body languages only.** `json`, `plaintext` and `graphql`
 * are what `CodeEditor` mounts for a request body. Deliberately *not*
 * `javascript`: the script editors are the one place `{{name}}` is not the
 * syntax - a script reaches variables through `pm.environment.get()` and its
 * sibling scope accessors (there is no `pm.variables`), and
 * offering brace completion there would teach the wrong thing.
 *
 * Called once, in App - a completion provider is global per language, so one
 * registration covers every editor instance. The same shape as
 * `useScriptCompletionProvider` beside it.
 */

import { useEffect } from "react";
import { useMonaco } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { useVariableResolver } from "./useVariableResolver";
import { variableCompletionContext } from "@/lib/variable-completion";

const CLOSE_BRACES = "}}";

/**
 * What `CodeEditor` mounts for a request body. Scripts are excluded - see above.
 *
 * Exported so `body-editor-completion.test.tsx` can render every body mode and
 * check this list still covers the `language` each editor asks for. The two are
 * wired only by matching strings, several files apart, so a new body mode with
 * a new language would lose completion silently.
 */
export const BODY_LANGUAGES = ["json", "plaintext", "graphql"];

/** The resolver's own precedence, so the winning definition sorts first. */
const SCOPE_ORDER: Record<string, number> = { environment: 0, collection: 1, global: 2 };

export function useVariableCompletionProvider() {
	const monaco = useMonaco();
	const { getAllVariables } = useVariableResolver();

	useEffect(() => {
		if (!monaco) return;

		const provider: Monaco.languages.CompletionItemProvider = {
			// `{` so the list appears on the second brace. Monaco also re-queries
			// as you keep typing, which is what filters it.
			triggerCharacters: ["{"],
			provideCompletionItems(model, position) {
				const linePrefix = model
					.getLineContent(position.lineNumber)
					.slice(0, position.column - 1);
				const context = variableCompletionContext(linePrefix);
				if (!context) return { suggestions: [] };

				/*
				 * Replace from the `{{` itself, not from the partial word. Monaco
				 * treats `{` as a word separator, so replacing only the word would
				 * leave the braces behind and produce `{{{{name}}`.
				 */
				const range: Monaco.IRange = {
					startLineNumber: position.lineNumber,
					endLineNumber: position.lineNumber,
					startColumn: context.openIndex + 1,
					endColumn: position.column,
				};

				// Whatever already follows the caret decides if we owe a `}}`, so
				// completing inside a pre-typed `{{}}` does not produce `{{name}}}}`.
				const rest = model.getLineContent(position.lineNumber).slice(position.column - 1);
				const closing = rest.startsWith(CLOSE_BRACES) ? "" : CLOSE_BRACES;

				const variables = getAllVariables();
				const suggestions = Object.entries(variables).map(([name, info]) => ({
					label: name,
					kind: monaco.languages.CompletionItemKind.Variable,
					insertText: `{{${name}${closing}`,
					// The resolved value, which is the thing you are actually
					// checking when you reach for the list.
					detail: info.secret ? "secret" : info.value || "(empty)",
					documentation: info.sourceName
						? `${info.scope} - ${info.sourceName}`
						: info.scope,
					// Environment beats collection beats global, matching the order
					// the resolver itself applies.
					sortText: `${SCOPE_ORDER[info.scope] ?? 9}${name}`,
					filterText: `{{${name}`,
					range,
				}));

				return { suggestions };
			},
		};

		const disposables = BODY_LANGUAGES.map((language) =>
			monaco.languages.registerCompletionItemProvider(language, provider)
		);
		return () => disposables.forEach((d) => d.dispose());
	}, [monaco, getAllVariables]);
}
