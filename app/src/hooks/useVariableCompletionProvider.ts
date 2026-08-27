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
 * syntax - a script reaches variables through `pm.environment.get()`, its
 * sibling scope accessors, or the merged `pm.variables.get()`, and offering
 * brace completion there would teach the wrong thing.
 *
 * **Scoped to the active tab's collection.** A provider is registered once per
 * language, so unlike `VariableInput` it has no request builder context to take
 * a `collectionId` from - and without one `useVariableResolver` leaves every
 * collection-scope variable out. `useActiveCollectionId` supplies it, so the
 * list is globals + the whole ancestor chain + the active environment, which is
 * exactly the set `{{name}}` resolves against at compose time.
 *
 * **Declared data columns are offered too** (issue #600). `{{data.email}}` is
 * not a variable - the namespace is disjoint from the scopes - so the columns
 * come from the contract the collection chain declares rather than from the
 * resolver's map, and they are a group of their own between the variables and
 * the generators.
 *
 * **Each declared column offers both spellings a bound row answers** (issue
 * #1007): `{{data.email}}`, the collision-proof one that a scope can never
 * shadow, and bare `{{email}}`, the one an imported Postman collection is
 * already written with. Each carries its own `detail` naming which is which,
 * so picking one from the list is a deliberate choice rather than a guess.
 *
 * Called once, in App - a completion provider is global per language, so one
 * registration covers every editor instance. The same shape as
 * `useScriptCompletionProvider` beside it.
 */

import { useEffect } from "react";
import { useMonaco } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { useVariableResolver } from "./useVariableResolver";
import { useActiveCollectionId } from "./useActiveCollectionId";
import { useDataContract } from "./useDataContract";
import { variableCompletionContext } from "@/lib/variable-completion";
import { DYNAMIC_VARIABLES } from "@/lib/dynamic-variables";
import { DATA_NAMESPACE_PREFIX } from "@/lib/variable-resolution";

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

/**
 * Between the scopes and the generators: a declared column is workspace data
 * like a variable, so it outranks the table that exists everywhere, but it is
 * not a variable and must not push one down the list.
 */
const DATA_SORT_GROUP = 7;

/** Sorts after every scope above, so a generator never outranks a real variable. */
const DYNAMIC_SORT_GROUP = 8;

export function useVariableCompletionProvider() {
	const monaco = useMonaco();
	const collectionId = useActiveCollectionId();
	const { getAllVariables } = useVariableResolver({ collectionId });
	/*
	 * The declared columns of whichever collection in the chain declares them
	 * (issue #600). Offered from the contract rather than from the variable map
	 * because the namespace is disjoint from the scopes - `{{data.email}}` is
	 * never a variable, so nothing in `getAllVariables` can carry it.
	 */
	const dataColumns = useDataContract(collectionId);

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
				const suggestions: Monaco.languages.CompletionItem[] = Object.entries(
					variables
				).map(([name, info]) => ({
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

				/*
				 * Dynamic variables sort after every user variable: they are offered
				 * in every workspace, whatever it holds, so interleaving them would
				 * push a collection's own names down the list. `Function`, not
				 * `Variable` - the icon is the only thing in the list that says a
				 * value is generated per use rather than stored somewhere.
				 */
				for (const dynamic of DYNAMIC_VARIABLES) {
					if (dynamic.name in variables) continue; // a real variable shadows it
					suggestions.push({
						label: dynamic.name,
						kind: monaco.languages.CompletionItemKind.Function,
						insertText: `{{${dynamic.name}${closing}`,
						detail: dynamic.description,
						documentation: "Generated per use",
						sortText: `${DYNAMIC_SORT_GROUP}${dynamic.name}`,
						filterText: `{{${dynamic.name}`,
						range,
					});
				}

				/*
				 * Declared columns, from the contract in scope (issue #600). They
				 * come from the contract rather than from `variables` because the
				 * namespace is disjoint from the scopes - no variable can carry one.
				 */
				for (const column of dataColumns?.columns ?? []) {
					const name = `${DATA_NAMESPACE_PREFIX}${column}`;
					suggestions.push({
						label: name,
						// `Field`, not `Variable`: the icon is the only thing in the
						// list saying this is a column of a run's row rather than a
						// name some scope defines.
						kind: monaco.languages.CompletionItemKind.Field,
						insertText: `{{${name}${closing}`,
						detail: `Data column - ${dataColumns?.collectionName}`,
						documentation: "Bound per iteration by a collection run's data file",
						sortText: `${DATA_SORT_GROUP}${name}`,
						filterText: `{{${name}`,
						range,
					});
					// The bare spelling a bound row answers too (issue #1007) - Postman's
					// own spelling, and what an imported collection is already written
					// with. Same sort group as the prefixed form above so the two sit
					// together instead of scattering.
					suggestions.push({
						label: column,
						kind: monaco.languages.CompletionItemKind.Field,
						insertText: `{{${column}${closing}`,
						detail: `Data column (bare) - ${dataColumns?.collectionName}`,
						documentation:
							"Postman-style: a bound row answers this name directly, above the environment. Collides with a same-named variable while a row is bound - data.* never does.",
						sortText: `${DATA_SORT_GROUP}${name}`,
						filterText: `{{${column}`,
						range,
					});
				}

				return { suggestions };
			},
		};

		const disposables = BODY_LANGUAGES.map((language) =>
			monaco.languages.registerCompletionItemProvider(language, provider)
		);
		return () => disposables.forEach((d) => d.dispose());
	}, [monaco, getAllVariables, dataColumns]);
}
