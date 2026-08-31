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
 * **Collection scope is the whole chain, the same as in a body.** The engine
 * fills a script's collection scope from the request's collection *chain*
 * (issue #234, leaf shadowing ancestor), so an ancestor's variable resolves
 * inside `pm.collectionVariables.get()` exactly as it does inside `{{name}}` -
 * and it belongs in this list for the same reason every other offered name
 * does. This list narrowed to the immediate collection while the engine did;
 * the two move together, or one of them offers names the other cannot read.
 * See docs/app/variable-resolution.md.
 *
 * **`pm.iterationData` completes columns, not variables** (issue #600). The row
 * it reads is bound from the collection's data file, so the names are the
 * declared columns of the contract in scope - the same list the `{{data.*}}`
 * tokens are validated against, so what an editor offers and what the builder
 * paints green cannot disagree.
 *
 * **`pm.variables` completes both** (issue #1063). It is the one accessor that
 * reads a bound row's bare column names *and* the three scopes (issue #1007),
 * so its list is the union - a column offered there is a name the call really
 * can return, which is the rule every other list here already follows.
 *
 * Call once (in App). A completion provider is global per language, so a single
 * registration covers every script editor instance. The same shape as
 * `useScriptCompletionProvider` and `useVariableCompletionProvider` beside it.
 */

import { useEffect } from "react";
import { useLoadedMonaco } from "@/lib/monaco-loader";
import type * as Monaco from "monaco-editor";
import { useVariableResolver } from "./useVariableResolver";
import { useActiveCollectionId } from "./useActiveCollectionId";
import { useDataContract } from "./useDataContract";
import { scriptVariableCompletionContext } from "@/lib/script-variable-completion";
import { DYNAMIC_VARIABLES } from "@/lib/dynamic-variables";
import { ITERATION_VARIABLES } from "@/lib/iteration-variables";
import { DATA_NAMESPACE_PREFIX } from "@/lib/variable-resolution";

/** Script editors mount with language="javascript". */
const SCRIPT_LANGUAGE = "javascript";

const CLOSE_BRACES = "}}";

/** The resolver's own precedence, so the winning definition sorts first. */
const SCOPE_ORDER: Record<string, number> = { environment: 0, collection: 1, global: 2 };

/**
 * Between the scopes and the data columns, the same slot
 * `useVariableCompletionProvider.ts` gives it: `$vu` / `$iteration` are a
 * reserved namespace like `data.*`, not a generator, so they sort with the
 * other reserved things rather than among the `$random*` table.
 */
const ITERATION_SORT_GROUP = 6;

/**
 * Columns sort after every scope and before the generators, the same grouping
 * the body editor's list uses - so a column never displaces a name the call
 * resolves today, and the two lists order the same things the same way.
 */
const DATA_SORT_GROUP = 7;

/** Sorts after every scope above, so a generator never outranks a real variable. */
const DYNAMIC_SORT_GROUP = 8;

export function useScriptVariableCompletionProvider() {
	// Passive by design: null until an editor has loaded Monaco, so registration
	// happens then. `@monaco-editor/react`'s `useMonaco` would load it from here,
	// at startup, and from the CDN - see `lib/monaco-loader.ts` (#1146).
	const monaco = useLoadedMonaco();
	/*
	 * The active tab's collection, since a provider registered per language has
	 * no request builder context to take one from and the resolver offers no
	 * collection variables without it. The resolver walks up from here, which is
	 * the same chain the engine hands the script.
	 */
	const collectionId = useActiveCollectionId();
	const { getAllVariables } = useVariableResolver({ collectionId });
	/*
	 * `pm.iterationData.get("` completes columns, not variables (issue #600) -
	 * the row is bound from the collection's data file, so the names come from
	 * the contract in scope and from nowhere else.
	 */
	const dataColumns = useDataContract(collectionId);

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

				/*
				 * A column list and a variable list share no rules: no scope filter
				 * applies, generators do not exist there, and the declaring
				 * collection is the useful detail rather than a resolved value. So
				 * it answers here rather than threading a third case through the
				 * mapping below.
				 */
				if (context.scope === "data") {
					return {
						suggestions: (dataColumns?.columns ?? []).map((column) => ({
							label: column,
							kind: monaco.languages.CompletionItemKind.Field,
							insertText: column,
							detail: `Data column - ${dataColumns?.collectionName}`,
							documentation: "Bound per iteration by a collection run's data file",
							filterText: column,
							range,
						})),
					};
				}

				const template = context.mode === "template";

				// Whatever already follows the caret decides if we owe a `}}`, so
				// completing inside a pre-typed `{{}}` does not produce `{{name}}}}`.
				const rest = line.slice(position.column - 1);
				const closing = !template || rest.startsWith(CLOSE_BRACES) ? "" : CLOSE_BRACES;
				const wrap = (name: string) => (template ? `{{${name}${closing}` : name);

				const variables = getAllVariables();
				const suggestions: Monaco.languages.CompletionItem[] = Object.entries(variables)
					// `pm.environment.get` reads one scope; only the merged
					// `pm.variables` sees them all.
					.filter(([, info]) => context.scope === "all" || info.scope === context.scope)
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
				 * Declared columns, blended into the merged accessor and nowhere
				 * else (issue #1063). A bound row answers bare column names
				 * through `pm.variables` above every scope (issue #1007), so a
				 * column is one of the names that call can return - and it was
				 * the one such name the list never offered, which makes it a
				 * column you have to already know to use.
				 *
				 * The single-scope accessors never see the row, and
				 * `pm.iterationData` answered from the branch above, so neither
				 * reaches here. `replaceIn` does, and belongs:
				 * `resolve_template_with_data` resolves a bare `{{email}}` from
				 * the row for it too, so leaving it out would take a condition
				 * written only to preserve the gap.
				 *
				 * The columns come from the contract rather than from `variables`
				 * because the namespace is disjoint from the scopes - no variable
				 * can carry one. A name that is both a column and a variable is
				 * offered twice on purpose: the row wins while one is bound and
				 * the scope answers when none is, and a single entry would have
				 * to hide one of those.
				 *
				 * **Only `replaceIn` gets the prefixed spelling** (issue #1077), and
				 * the asymmetry is the rule rather than an oversight: `replaceIn`
				 * resolves `{{data.email}}` and `{{email}}` from the same row, so
				 * withholding one of two spellings that work would be the same gap
				 * this fixes; `pm.variables.get("data.email")` reads no column at
				 * all, the namespace being disjoint from the scopes there, so
				 * offering it in a name argument would teach a call that returns
				 * `undefined`.
				 */
				if (context.scope === "all") {
					for (const column of dataColumns?.columns ?? []) {
						if (template) {
							const prefixed = `${DATA_NAMESPACE_PREFIX}${column}`;
							suggestions.push({
								label: prefixed,
								kind: monaco.languages.CompletionItemKind.Field,
								insertText: wrap(prefixed),
								detail: `Data column - ${dataColumns?.collectionName}`,
								documentation:
									"Bound per iteration by a collection run's data file. The prefixed spelling can never collide with a variable.",
								// The same group as the bare spelling below, so one column's
								// two entries sit together rather than scattering.
								sortText: `${DATA_SORT_GROUP}${column}`,
								filterText: wrap(prefixed),
								range,
							});
						}
						suggestions.push({
							label: column,
							// `Field`, not `Variable`: the icon is the only thing in
							// the list saying this is a column of a run's row rather
							// than a name some scope defines.
							kind: monaco.languages.CompletionItemKind.Field,
							insertText: wrap(column),
							/*
							 * `(bare)` only where the prefixed entry is beside it: the
							 * word exists to tell two adjacent spellings apart, and in
							 * the `get` / `has` list - which offers one - it would draw
							 * a contrast that list does not contain.
							 */
							detail: template
								? `Data column (bare) - ${dataColumns?.collectionName}`
								: `Data column - ${dataColumns?.collectionName}`,
							documentation:
								"Bound per iteration by a collection run's data file. A bound row answers this name above every scope; with no row bound, the scopes answer it.",
							sortText: `${DATA_SORT_GROUP}${column}`,
							filterText: wrap(column),
							range,
						});
					}
				}

				/*
				 * The reserved identity namespace (issue #1057). `replaceIn` resolves
				 * `{{$vu}}` / `{{$iteration}}` against the identity the request beside
				 * the script was bound with - whatever the run's shape gives it, down
				 * to `1` / `0` on a plain Send, since `POST /execute` binds those into
				 * every send that carries no row (a single send is a run of one). That
				 * is a different question from `pm.info.vu` / `pm.info.iteration`, which
				 * stay `undefined` on that same plain Send: `pm.info` answers which
				 * iteration of which run this is, and there is no run, while a token
				 * answers what it resolves to here, and here it resolves to what the
				 * request beside it carried. Never withheld for a same-named scope
				 * variable, unlike the generators below: the engine resolves these two
				 * names ahead of every scope, so a variable called `$vu` shadows
				 * nothing and offering the name is still offering what resolves.
				 */
				if (template) {
					for (const identity of ITERATION_VARIABLES) {
						suggestions.push({
							label: identity.name,
							kind: monaco.languages.CompletionItemKind.Constant,
							insertText: wrap(identity.name),
							detail: identity.description,
							documentation:
								"Resolves to what the request beside the script was bound with - 1 / 0 on a plain Send, not generated here",
							sortText: `${ITERATION_SORT_GROUP}${identity.name}`,
							filterText: wrap(identity.name),
							range,
						});
					}
				}

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
	}, [monaco, getAllVariables, collectionId, dataColumns]);
}
