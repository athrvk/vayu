/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Registers the engine-provided `pm.*` completions with Monaco's JavaScript language, so the script
 * editors get `pm.` autocomplete; `useScriptCompletionsQuery` fetches and caches the set. Call once
 * (in App): the provider is global per language, so one registration covers every JavaScript
 * editor.
 */

import { useEffect } from "react";
import { useLoadedMonaco } from "@/lib/monaco-loader";
import type * as Monaco from "monaco-editor";
import { useScriptCompletionsQuery } from "@/queries";
import { completionReplaceStartColumn } from "@/lib/script-completion-range";
import { calleeOnlyInsertText } from "@/lib/script-completion-insert";
import { openStringLiteral } from "@/lib/script-variable-completion";

/** Script editors mount with language="javascript". */
const SCRIPT_LANGUAGE = "javascript";

export function useScriptCompletionProvider() {
	// Passive by design: null until an editor has loaded Monaco, so registration
	// happens then. `@monaco-editor/react`'s `useMonaco` would load it from here,
	// at startup, and from the CDN - see `lib/monaco-loader.ts` (#1146).
	const monaco = useLoadedMonaco();
	// Fetched once there is an editor to register with: `App` mounts this at
	// launch, and until then the list would be one more request in the boot
	// burst for nothing to read it.
	const { data } = useScriptCompletionsQuery({ enabled: monaco !== null });
	const completions = data?.completions;

	useEffect(() => {
		if (!monaco || !completions?.length) return;

		const disposable = monaco.languages.registerCompletionItemProvider(SCRIPT_LANGUAGE, {
			triggerCharacters: ["."],
			provideCompletionItems(model, position) {
				// Replace the entire dotted identifier chain before the cursor
				// (e.g. "pm.", "pm.res") rather than just the word after the last
				// dot - Monaco treats "." as a word separator, so replacing only
				// the word would leave "pm." in place and duplicate it.
				const linePrefix = model
					.getLineContent(position.lineNumber)
					.slice(0, position.column - 1);

				/*
				 * Nothing in this list belongs inside a string literal. The chain regex matches the
				 * word under the caret wherever it sits, so `pm.environment.get("ba` would offer
				 * the whole dotted `pm.*` surface, and accepting one would replace the half-typed
				 * variable name with `pm.response.body`. A string argument is where the *variable*
				 * list belongs (`useScriptVariableCompletionProvider`), so yielding here leaves the
				 * right list showing alone.
				 */
				if (openStringLiteral(linePrefix)) return { suggestions: [] };

				const range: Monaco.IRange = {
					startLineNumber: position.lineNumber,
					endLineNumber: position.lineNumber,
					startColumn: completionReplaceStartColumn(linePrefix, position.column),
					endColumn: position.column,
				};

				/*
				 * Most `pm.*` completions are snippets carrying their own argument list, the wrong
				 * shape when the call is already written: completing `pm.variables.rep|("$guid")`
				 * would leave `pm.variables.replaceIn("template")("$guid")`. Where the line already
				 * opens a call, insert the callee alone.
				 */
				const lineSuffix = model
					.getLineContent(position.lineNumber)
					.slice(position.column - 1);

				const suggestions: Monaco.languages.CompletionItem[] = completions.map((c) => {
					const callee = calleeOnlyInsertText(c.insertText, lineSuffix);
					return {
						label: c.label,
						kind: c.kind as Monaco.languages.CompletionItemKind,
						insertText: callee ?? c.insertText,
						// A bare path holds no placeholders, and keeping the snippet
						// rule would have Monaco read a `$` in one as the start of one.
						insertTextRules: callee
							? undefined
							: (c.insertTextRules as
									Monaco.languages.CompletionItemInsertTextRule | undefined),
						detail: c.detail,
						documentation: c.documentation,
						sortText: c.sortText,
						filterText: c.filterText,
						range,
					};
				});

				return { suggestions };
			},
		});

		return () => disposable.dispose();
	}, [monaco, completions]);
}
