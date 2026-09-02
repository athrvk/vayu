/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a `{{` offers, in the order it is offered.
 *
 * Two components need this list and they need the *same* one:
 * `VariableAutocomplete` draws it, and `VariableInput` steps through it with
 * the arrow keys. While the ordering lived inside the drawing component the
 * input had no way to know what "the next item" was, so it faked navigation by
 * dispatching a synthetic keydown at `document.querySelector("[cmdk-root]")` -
 * the first `cmdk` list in the whole document, which is not necessarily the one
 * hanging off the field the user is typing in (issue #1215).
 *
 * The list is flat and ordered; `group` says which heading an entry falls
 * under. Flat rather than nested because the input navigates positions and the
 * renderer draws headings - one shape serves both, and the order is the shape.
 */

import type { DataContractScope, ResolvedVariable, VariableScope } from "@/types";
import { DATA_NAMESPACE_PREFIX } from "@/lib/variable-resolution";
import { DYNAMIC_VARIABLES } from "@/lib/dynamic-variables";
import { ITERATION_VARIABLES } from "@/lib/iteration-variables";

export type VariableSuggestionGroup = "variables" | "iteration" | "columns" | "dynamic";

/**
 * The headings, and the order the groups appear in.
 *
 * Declared once, here, because the renderer reads both the label and the order
 * from it - a second copy of the order is how a group ends up drawn in one
 * place and navigated in another.
 */
export const VARIABLE_SUGGESTION_GROUPS: ReadonlyArray<{
	group: VariableSuggestionGroup;
	heading: string;
}> = [
	{ group: "variables", heading: "Variables" },
	{ group: "iteration", heading: "Iteration" },
	{ group: "columns", heading: "Data columns" },
	{ group: "dynamic", heading: "Dynamic" },
];

export interface VariableSuggestion {
	/** The name a selection writes between the braces. Unique across the list. */
	name: string;
	group: VariableSuggestionGroup;
	/** `variables` only: the scope the winning definition came from. */
	scope?: VariableScope;
	/** `iteration` and `dynamic`: what the token stands for. */
	description?: string;
	/** `columns` only: the collection that declared the contract. */
	collectionName?: string;
	/** `columns` only: true for the bare spelling, false for the `data.` one. */
	bare?: boolean;
}

/**
 * A suggestion's identity, distinct from the name it writes.
 *
 * The name is not unique: a data file's column is offered bare as well as
 * prefixed (issue #1007), and a workspace variable may be named the same thing
 * - so two entries can write `{{email}}` while meaning different rows. `cmdk`
 * keys its highlight by an item's `value`, and `VariableInput` steps through
 * these keys, so both would otherwise treat the pair as one item: the highlight
 * would paint on both and an arrow press would appear to stick.
 */
export function variableSuggestionKey(suggestion: VariableSuggestion): string {
	return `${suggestion.group}:${suggestion.name}`;
}

export interface VariableSuggestionInput {
	/** Everything the workspace defines, by name. */
	variables: Record<string, ResolvedVariable>;
	/** What the user has typed after the `{{`. */
	searchQuery?: string;
	/** The data contract in scope, when the collection chain declares one. */
	dataColumns?: DataContractScope;
}

export function buildVariableSuggestions({
	variables,
	searchQuery = "",
	dataColumns,
}: VariableSuggestionInput): VariableSuggestion[] {
	const query = searchQuery.toLowerCase();
	const matches = (name: string) => name.toLowerCase().includes(query);

	const stored: VariableSuggestion[] = Object.entries(variables)
		.filter(([name]) => matches(name))
		.map(([name, info]) => ({ name, group: "variables" as const, scope: info.scope }));

	/*
	 * The reserved identity namespace (issue #994) is a group of its own for the
	 * same reason `data.*` is: it is not a name a scope could ever define, so -
	 * unlike the generators below - there is no shadowing check to make here.
	 */
	const iteration: VariableSuggestion[] = ITERATION_VARIABLES.filter((v) => matches(v.name)).map(
		(v) => ({ name: v.name, group: "iteration" as const, description: v.description })
	);

	/*
	 * Columns are offered from the contract rather than from `variables`, because
	 * the namespace is disjoint from the scopes - a stored variable named
	 * `data.email` cannot shadow the column.
	 *
	 * Each column offers both spellings a bound row answers (issue #1007): the
	 * prefixed one first, then bare.
	 */
	const columns: VariableSuggestion[] = [];
	for (const column of dataColumns?.columns ?? []) {
		const prefixed = `${DATA_NAMESPACE_PREFIX}${column}`;
		if (matches(prefixed))
			columns.push({
				name: prefixed,
				group: "columns",
				collectionName: dataColumns?.collectionName,
				bare: false,
			});
		if (matches(column))
			columns.push({
				name: column,
				group: "columns",
				collectionName: dataColumns?.collectionName,
				bare: true,
			});
	}

	/*
	 * Generators come last and are dropped where a real variable shadows one:
	 * the resolver would ignore the generator there, so offering it would name a
	 * value the request will not carry.
	 */
	const dynamic: VariableSuggestion[] = DYNAMIC_VARIABLES.filter(
		(v) => !(v.name in variables) && matches(v.name)
	).map((v) => ({ name: v.name, group: "dynamic" as const, description: v.description }));

	return [...stored, ...iteration, ...columns, ...dynamic];
}
