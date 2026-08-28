/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which variable names a script mentions, and by which syntax.
 *
 * Two syntaxes, because a script can *name* a variable either way - but only
 * one of them reads it. `pm.environment.get("token")` resolves at run time;
 * `{{token}}` inside script text is literal characters, because the engine
 * never interpolates a script (`request_composer.cpp`, decision D16 - rewriting
 * `{{...}}` there cannot tell a string literal from code). Authors write it
 * anyway, out of habit from URLs and bodies, which is exactly why the surfaces
 * that chip these names have to keep the two apart (issue #659 item 3).
 *
 * Pulled out of the panel so it can be tested as logic. It was inline in both
 * script panels, twice over, with the regexes rebuilt on every render - and a
 * *third* time in the collection's script tab, which is why this now lives in
 * `lib/` rather than under `request-builder/`: it is read by two modules, and
 * a copy under one of them is what let the collection tab keep its own.
 *
 * The template matcher is the app's one `VARIABLE_PATTERN`; only `PM_GET` is
 * local, because nothing else looks for that syntax. Inner braces are excluded
 * by that pattern, so `{{a}}{{b}}` is two names and not one.
 *
 * **A reference carries what its accessor can see, not only how it was
 * spelled** (issue #1063). `PM_GET` matched three accessors and left
 * `pm.variables` and `pm.iterationData` out entirely, so a name read through
 * either was not merely painted wrong - it was chipped nowhere at all, the
 * quiet half of this repo's written-but-never-read defect. Since issue #1007 a
 * bound row answers bare column names through `pm.variables`, which makes the
 * accessor the difference between a column read and a variable read of the same
 * name, so the syntax alone can no longer decide what a chip may claim.
 */

import { VARIABLE_PATTERN } from "@/constants/variables";
import {
	describeBareColumnToken,
	describeColumnToken,
	type DataTokenDescription,
} from "./data-contract";
import type { DataContractScope } from "@/types/domain";

/**
 * `pm.<accessor>.get("x")`, for every accessor whose first argument is a name.
 *
 * Optional chaining counts as the dot it is, the same way `ACCESSOR_CALL` in
 * `script-variable-completion.ts` reads it: `pm.iterationData` is `undefined`
 * outside a data-driven run and its own documentation says to guard before
 * calling, so `pm.iterationData?.get("x")` is how the call is actually written.
 */
const PM_GET =
	/pm\??\.(environment|globals|collectionVariables|variables|iterationData)\??\.get\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * How a script named a variable.
 *
 * - `pm` - a `pm.*.get()` call. The script really reads the variable, so
 *   "defined" and "not defined" are both meaningful answers about it.
 * - `template` - a `{{name}}` in the script text. Nothing substitutes it, so no
 *   answer about whether the name resolves says anything true about this
 *   script.
 */
export type ReferenceSyntax = "pm" | "template";

/**
 * What the accessor that named it can actually see (issue #1063).
 *
 * The syntax alone stopped being enough once a bound data row began answering
 * bare column names (issue #1007): `pm.environment.get("email")` and
 * `pm.variables.get("email")` are the same syntax about the same name, and only
 * the second one can be reading a column. A surface that paints them alike is
 * guessing.
 *
 * - `scope` - `environment` / `globals` / `collectionVariables`. One scope, and
 *   never the row, whatever the collection declares.
 * - `merged` - `pm.variables`. The bound row's bare column names first, then the
 *   three scopes (issue #1007), so this one is a column read *or* a variable
 *   read and the name decides which.
 * - `row` - `pm.iterationData`. The row and nothing but the row, so no answer
 *   about the scopes says anything true about it.
 */
export type PmRead = "scope" | "merged" | "row";

const PM_READ_BY_ACCESSOR: Record<string, PmRead> = {
	environment: "scope",
	globals: "scope",
	collectionVariables: "scope",
	variables: "merged",
	iterationData: "row",
};

/**
 * Which mention of a name outranks which, when a script writes it more than one
 * way. Ascending, and the existing `pm`-beats-`template` rule is the bottom two
 * rungs of it.
 *
 * Above them, an accessor that can see the row outranks one that cannot, for
 * the same reason `pm` outranks `template`: it is the stronger claim about what
 * the script reads, and the row shadowing a same-named variable is the fact an
 * author most needs the chip to show. `row` tops `merged` because it reads
 * nothing else, so the column reading is the only one it can have.
 */
const CLAIM_RANK: Record<string, number> = { template: 0, scope: 1, merged: 2, row: 3 };

/**
 * What a `template` chip has to say for itself, in both script surfaces.
 *
 * Here rather than in either panel because the two would otherwise each own a
 * sentence about the same engine rule, and the repo has been bitten by exactly
 * that: a copy does not receive the original's corrections. It is the one string
 * in this module, and it belongs to the syntax the module distinguishes.
 */
export const TEMPLATE_IN_SCRIPT_NOTE =
	"Scripts are not interpolated: these characters reach the script verbatim. " +
	'Read the variable with pm.environment.get("name").';

export interface VariableReference {
	name: string;
	via: ReferenceSyntax;
	/** What the accessor that named it reads; `null` for a `template` mention. */
	reads: PmRead | null;
}

/**
 * Names, deduplicated, each with the syntax that earns it the stronger claim.
 *
 * A name written both ways is `pm`: the script does read it, and the `{{}}`
 * beside the call is decoration. That asymmetry is the whole point of carrying
 * the syntax - the weaker claim must never overwrite the stronger one.
 *
 * Grouped by syntax rather than by position in the script - which is what the
 * two panels did, and is kept deliberately so this stays a refactor. It is
 * worth knowing rather than assuming: the panel chips the first five and
 * counts the rest, so adding a `pm.globals.get()` below an existing `{{name}}`
 * pushes that name down the list even though it comes first in the file.
 */
export function referencedVariables(script: string): VariableReference[] {
	const byName = new Map<string, VariableReference>();
	const add = (name: string, via: ReferenceSyntax, reads: PmRead | null) => {
		if (name.length === 0) return;
		const existing = byName.get(name);
		// A repeat never downgrades what is there, so an equal claim keeps the
		// first - which is also what holds this name's place in the row's order.
		if (
			existing &&
			CLAIM_RANK[existing.reads ?? "template"] >= CLAIM_RANK[reads ?? "template"]
		) {
			return;
		}
		byName.set(name, { name, via, reads });
	};

	for (const match of script.matchAll(PM_GET)) {
		add(match[2], "pm", PM_READ_BY_ACCESSOR[match[1]]);
	}
	for (const match of script.matchAll(VARIABLE_PATTERN)) add(match[1].trim(), "template", null);

	return [...byName.values()];
}

/**
 * What a reference says about itself *as a data column*, or null when it is not
 * a column read and the caller's ordinary variable painting applies (#1063).
 *
 * Here rather than in the panels for the same reason `TEMPLATE_IN_SCRIPT_NOTE`
 * is: the rule is one engine fact, and a surface holding its own copy is how
 * two chips of the same name come to disagree. It takes a predicate rather than
 * the resolver's map so it stays a pure join of "what did the script write" and
 * "what does the contract declare".
 *
 * @param definesVariable whether any scope defines a variable of that name
 */
export function describeColumnReference(
	reference: VariableReference,
	contract: DataContractScope | null | undefined,
	definesVariable: (name: string) => boolean
): DataTokenDescription | null {
	const { name, reads } = reference;

	/*
	 * `pm.iterationData` reads the row and nothing else, so every state it can
	 * be in is a column state - including "no contract declared". Falling
	 * through would hand it the resolved/unresolved pair, and a column can never
	 * be in `allVariables`, so the answer would always be the destructive red
	 * issue #604 removed from exactly this row.
	 */
	if (reads === "row") return describeColumnToken(name, contract);

	/*
	 * `pm.variables` reads the row first and the scopes after, so it is a column
	 * read only while the name is a declared column that no scope answers -
	 * the same line `VariableInput` draws for a bare `{{name}}` (issue #1007).
	 * Where a scope does define it, the variable painting is still true and the
	 * question of which one wins on screen belongs to #1064, not here.
	 */
	if (reads !== "merged" || !contract) return null;
	if (!contract.columns.includes(name) || definesVariable(name)) return null;
	return describeBareColumnToken(contract);
}
