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
				const range: Monaco.IRange = {
					startLineNumber: position.lineNumber,
					endLineNumber: position.lineNumber,
					startColumn: completionReplaceStartColumn(linePrefix, position.column),
					endColumn: position.column,
				};

				const suggestions: Monaco.languages.CompletionItem[] = completions.map((c) => ({
					label: c.label,
					kind: c.kind as Monaco.languages.CompletionItemKind,
					insertText: c.insertText,
					insertTextRules: c.insertTextRules as
						| Monaco.languages.CompletionItemInsertTextRule
						| undefined,
					detail: c.detail,
					documentation: c.documentation,
					sortText: c.sortText,
					filterText: c.filterText,
					range,
				}));

				return { suggestions };
			},
		});

		return () => disposable.dispose();
	}, [monaco, completions]);
}
