/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * "Is the caret inside the name argument of a `pm.*` variable accessor?"
 *
 * A script does not reach variables through `{{name}}` - it calls
 * `pm.environment.get("name")` and its siblings - so the body editors'
 * brace completion is deliberately not registered for `javascript`
 * (see `useVariableCompletionProvider`). That left the script editors with no
 * way to see what is in scope at all: the names live in the panel above the
 * editor, and you had to read them off it and spell them yourself.
 *
 * This is the rule that fills that gap without teaching brace syntax where it
 * does not apply. It is pure and single-line, which is all a variable name
 * needs - the caret is inside one string literal on one line.
 *
 * **The accessor decides the scope, not a merged list.** `pm.environment.get`
 * only ever reads the environment, so offering a collection variable there
 * would offer a name that resolves to `undefined` at run time. Only
 * `pm.variables` (the merged read) gets everything.
 */

import { variableCompletionContext } from "./variable-completion";

/** Which names belong in the list. `all` is the merged read - `pm.variables`. */
export type ScriptVariableScope = "environment" | "collection" | "global" | "all";

export interface ScriptVariableCompletionContext {
	scope: ScriptVariableScope;
	/**
	 * `name` - a bare variable name, the argument to `get`/`set`/`has`/`unset`.
	 * `template` - `{{name}}` inside `pm.variables.replaceIn`, which interpolates
	 * its argument exactly as a URL or body is interpolated, so the braces *are*
	 * the syntax there and generators (`{{$guid}}`) resolve too.
	 */
	mode: "name" | "template";
	/** 0-based index in the line where the replacement starts. */
	startIndex: number;
	/** What has been typed so far, for filtering. */
	query: string;
}

/** The open quote the caret sits inside, or null when it sits in code. */
export interface OpenString {
	quote: string;
	/** 0-based index of the opening quote character. */
	index: number;
}

/**
 * Scans a single line for a string literal left open at the caret.
 *
 * Exported because the `pm.*` completion provider needs the same answer for the
 * opposite reason: a dotted member list has no business appearing *inside* a
 * string, where the only useful suggestion is a variable name.
 */
export function openStringLiteral(textBeforeCaret: string): OpenString | null {
	let quote: string | null = null;
	let index = -1;

	for (let i = 0; i < textBeforeCaret.length; i++) {
		const ch = textBeforeCaret[i];
		if (quote) {
			// A backslash escapes the next character, including the closing quote,
			// so `"a\""` is still one open-then-closed string.
			if (ch === "\\") {
				i++;
				continue;
			}
			if (ch === quote) {
				quote = null;
				index = -1;
			}
		} else if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			index = i;
		}
	}

	return quote ? { quote, index } : null;
}

/** Accessor object -> the scope its reads and writes actually touch. */
const SCOPE_BY_ACCESSOR: Record<string, ScriptVariableScope> = {
	environment: "environment",
	globals: "global",
	collectionVariables: "collection",
	variables: "all",
};

/**
 * Methods whose *first* argument is a variable name.
 *
 * `pm.variables` is the odd one: it is the merged read, so it has no `unset`,
 * and its `set` throws by design (the merged view has no scope to write to).
 * Offering a name inside a call that always throws would teach the wrong thing,
 * so those spellings are simply absent here.
 */
const NAME_METHODS: Record<string, readonly string[]> = {
	environment: ["get", "set", "has", "unset"],
	globals: ["get", "set", "has", "unset"],
	collectionVariables: ["get", "set", "has", "unset"],
	variables: ["get", "has"],
};

/**
 * `pm.<accessor>.<method>(` immediately before the caret's string, allowing the
 * whitespace a formatter might leave. Anchored to the end so only the *first*
 * argument matches - `set`'s second argument is a value, not a name.
 */
const ACCESSOR_CALL = /pm\s*\.\s*(\w+)\s*\.\s*(\w+)\s*\(\s*$/;

/**
 * Returns null when the caret is not inside a `pm.*` variable name argument.
 *
 * @param textBeforeCaret line content from column 1 up to (not including) the caret
 */
export function scriptVariableCompletionContext(
	textBeforeCaret: string
): ScriptVariableCompletionContext | null {
	const open = openStringLiteral(textBeforeCaret);
	if (!open) return null;

	const call = textBeforeCaret.slice(0, open.index).match(ACCESSOR_CALL);
	if (!call) return null;

	const [, accessor, method] = call;
	const scope = SCOPE_BY_ACCESSOR[accessor];
	if (!scope) return null;

	const contents = textBeforeCaret.slice(open.index + 1);

	/*
	 * `replaceIn` takes a template, not a name, so its list is the brace one -
	 * and the same rule the body editors use decides whether the caret is inside
	 * an open `{{`. Reusing it keeps one definition of "inside a marker".
	 */
	if (accessor === "variables" && method === "replaceIn") {
		const braces = variableCompletionContext(contents);
		if (!braces) return null;
		return {
			scope: "all",
			mode: "template",
			startIndex: open.index + 1 + braces.openIndex,
			query: braces.query,
		};
	}

	if (!NAME_METHODS[accessor]?.includes(method)) return null;

	// A name is a plain identifier-ish token; a `{{` typed here is a mistake the
	// list should not encourage, and a quote cannot appear unescaped anyway.
	return {
		scope,
		mode: "name",
		startIndex: open.index + 1,
		query: contents,
	};
}
