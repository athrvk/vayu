/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Variable-name autocomplete inside the script editors.
 *
 * The `{{name}}` list is registered for the body languages and deliberately not
 * for `javascript`, because a script reaches variables through
 * `pm.environment.get()` rather than braces. That reasoning is right and this
 * hook keeps it: it offers the same names in the place a script actually names
 * them - the string argument of a `pm.*` accessor - so nothing here teaches
 * brace syntax where it does not apply.
 *
 * Until now the names were visible only in the panel *above* the editor, which
 * you had to read off and retype into the call. A misremembered name is silent:
 * `pm.environment.get()` returns `undefined` for a name that does not exist, so
 * the script carries on and fails somewhere else entirely.
 *
 * **The scope comes from the accessor.** `pm.environment.get` only reads the
 * environment, so a collection variable offered there would be a name that
 * resolves to `undefined`. `scriptVariableCompletionContext` decides which set
 * applies; this hook only renders it.
 *
 * Call once (in App). A completion provider is global per language, so a single
 * registration covers every script editor instance. The same shape as
 * `useScriptCompletionProvider` and `useVariableCompletionProvider` beside it.
 */

import { useCallback, useEffect } from "react";
import { useMonaco } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { useVariableResolver } from "./useVariableResolver";
import { useSessionStore } from "@/stores";
import { scriptVariableCompletionContext } from "@/lib/script-variable-completion";
import { DYNAMIC_VARIABLES } from "@/lib/dynamic-variables";

/** Script editors mount with language="javascript". */
const SCRIPT_LANGUAGE = "javascript";

const CLOSE_BRACES = "}}";

/** The resolver's own precedence, so the winning definition sorts first. */
const SCOPE_ORDER: Record<string, number> = { environment: 0, collection: 1, global: 2 };

/** Sorts after every scope above, so a generator never outranks a real variable. */
const DYNAMIC_SORT_GROUP = 8;

export function useScriptVariableCompletionProvider() {
	const monaco = useMonaco();
	const { getAllVariables, getVariableOrigins } = useVariableResolver();
	const activeCollectionId = useSessionStore((s) => s.activeCollectionId);

	/**
	 * The one place this list must be narrower than the `{{name}}` one.
	 *
	 * The engine fills the script's single collection scope from the request's
	 * **immediate parent collection only** (#226, decision D2), while this
	 * resolver merges the whole chain root→leaf. So a variable defined on an
	 * *ancestor* collection resolves for `{{name}}` and is `undefined` to
	 * `pm.collectionVariables.get` and `pm.variables.get` alike - precisely the
	 * name this list exists to stop you guessing at.
	 */
	const readableByScript = useCallback(
		(name: string, scope: string) => {
			if (scope !== "collection") return true;
			return getVariableOrigins(name).some(
				(origin) =>
					origin.scope === "collection" &&
					origin.sourceId === activeCollectionId &&
					origin.enabled
			);
		},
		[getVariableOrigins, activeCollectionId]
	);

	useEffect(() => {
		if (!monaco) return;

		const disposable = monaco.languages.registerCompletionItemProvider(SCRIPT_LANGUAGE, {
			/*
			 * The quotes open the argument, `{` covers `replaceIn`'s braces, and `$`
			 * re-triggers on a generator name. Monaco re-queries as you keep typing,
			 * which is what filters the list.
			 */
			triggerCharacters: ['"', "'", "`", "{", "$"],
			provideCompletionItems(model, position) {
				const line = model.getLineContent(position.lineNumber);
				const context = scriptVariableCompletionContext(line.slice(0, position.column - 1));
				if (!context) return { suggestions: [] };

				const range: Monaco.IRange = {
					startLineNumber: position.lineNumber,
					endLineNumber: position.lineNumber,
					startColumn: context.startIndex + 1,
					endColumn: position.column,
				};

				const template = context.mode === "template";

				// Whatever already follows the caret decides if we owe a `}}`, so
				// completing inside a pre-typed `{{}}` does not produce `{{name}}}}`.
				const rest = line.slice(position.column - 1);
				const closing = !template || rest.startsWith(CLOSE_BRACES) ? "" : CLOSE_BRACES;
				const wrap = (name: string) => (template ? `{{${name}${closing}` : name);

				const variables = getAllVariables();
				const suggestions: Monaco.languages.CompletionItem[] = Object.entries(variables)
					// `pm.environment.get` reads one scope; only the merged
					// `pm.variables` sees them all - and neither sees an ancestor
					// collection's variables.
					.filter(
						([name, info]) =>
							(context.scope === "all" || info.scope === context.scope) &&
							readableByScript(name, info.scope)
					)
					.map(([name, info]) => ({
						label: name,
						kind: monaco.languages.CompletionItemKind.Variable,
						insertText: wrap(name),
						// The resolved value, which is the thing you are actually
						// checking when you reach for the list.
						detail: info.secret ? "secret" : info.value || "(empty)",
						documentation: info.sourceName
							? `${info.scope} - ${info.sourceName}`
							: info.scope,
						sortText: `${SCOPE_ORDER[info.scope] ?? 9}${name}`,
						filterText: wrap(name),
						range,
					}));

				/*
				 * Generators only exist during interpolation, so they belong to
				 * `replaceIn` and nowhere else here: `pm.variables.get("$guid")` is
				 * not a lookup that resolves, it returns `undefined`.
				 */
				if (template) {
					for (const dynamic of DYNAMIC_VARIABLES) {
						if (dynamic.name in variables) continue; // a real variable shadows it
						suggestions.push({
							label: dynamic.name,
							kind: monaco.languages.CompletionItemKind.Function,
							insertText: wrap(dynamic.name),
							detail: dynamic.description,
							documentation: "Generated per use",
							sortText: `${DYNAMIC_SORT_GROUP}${dynamic.name}`,
							filterText: wrap(dynamic.name),
							range,
						});
					}
				}

				return { suggestions };
			},
		});

		return () => disposable.dispose();
	}, [monaco, getAllVariables, readableByScript]);
}
