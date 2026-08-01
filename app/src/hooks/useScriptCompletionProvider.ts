/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * useScriptCompletionProvider Hook
 *
 * Registers the engine-provided `pm.*` completions with Monaco's JavaScript
 * language so the script editors get `pm.` autocomplete. The completion set is
 * fetched and cached by useScriptCompletionsQuery; this hook is the consumer
 * that wires that data into Monaco.
 *
 * Call once (in App). The provider is global per language, so a single
 * registration covers every JavaScript editor instance.
 */

import { useEffect } from "react";
import { useMonaco } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { useScriptCompletionsQuery } from "@/queries";
import { completionReplaceStartColumn } from "@/lib/script-completion-range";
import { calleeOnlyInsertText } from "@/lib/script-completion-insert";
import { openStringLiteral } from "@/lib/script-variable-completion";

/** Script editors mount with language="javascript". */
const SCRIPT_LANGUAGE = "javascript";

export function useScriptCompletionProvider() {
	const monaco = useMonaco();
	const { data } = useScriptCompletionsQuery();
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
				 * Nothing in this list belongs inside a string literal. The chain
				 * regex is happy to match the word under the caret wherever it sits,
				 * so `pm.environment.get("ba` offered the whole dotted `pm.*` surface
				 * and accepting one replaced the half-typed variable name with
				 * `pm.response.body`. A string argument is exactly where the
				 * *variable* list belongs (`useScriptVariableCompletionProvider`), so
				 * yielding here is what leaves the right list showing alone.
				 */
				if (openStringLiteral(linePrefix)) return { suggestions: [] };

				const range: Monaco.IRange = {
					startLineNumber: position.lineNumber,
					endLineNumber: position.lineNumber,
					startColumn: completionReplaceStartColumn(linePrefix, position.column),
					endColumn: position.column,
				};

				/*
				 * Most `pm.*` completions are snippets carrying their own argument
				 * list, which is the wrong shape when the call is already written:
				 * completing `pm.variables.rep|("$guid")` left
				 * `pm.variables.replaceIn("template")("$guid")` behind. Where the
				 * line already opens a call, insert the callee alone.
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
									| Monaco.languages.CompletionItemInsertTextRule
									| undefined),
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
