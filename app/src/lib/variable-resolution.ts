/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The pure core of `{{variable}}` resolution, as the renderer *previews* it.
 *
 * Since issue #226 the engine owns execution-time resolution (`POST /compose`
 * - interpolation, precedence, the `inherit` auth walk). What the renderer
 * keeps is preview: resolved-URL tab titles, key/value and body previews, the
 * unresolved-token painting, and the "why this value" popover. A preview that
 * disagrees with what the engine will send is worse than none, so this module
 * restates the engine's rules exactly and is held to them by the shared
 * conformance fixture (`engine/tests/fixtures/variable-resolution-conformance
 * .json`), which the engine's gtest suite and this module's vitest suite both
 * drive.
 *
 * The rules (issue #226, "Behaviour that must not change" + D17):
 *  - precedence: environment > collection chain (leaf over root) > globals
 *  - a definition is disabled only by an explicit `enabled: false`; absent or
 *    malformed counts as enabled (D17 - matches the importers and the engine)
 *  - a non-string stored `value` reads as "" (D17)
 *  - a name nothing defines keeps its braces, plain or `$name` (issue #1009)
 *  - a `data.*` name keeps its braces too: it addresses the reserved data
 *    namespace (issue #402), which only a scenario run's iteration can bind
 *  - `$vu` and `$iteration` keep their braces too: they address the reserved
 *    identity namespace (issue #994), which only the iteration that sends can
 *    bind - a variable defined with either name never answers for it
 *  - so does a bare name a bound data row will substitute (issue #1007) - the
 *    same deferral for the same reason, spelled the way Postman's data
 *    variables are. A caller that already holds the row is the one exception,
 *    and it reads `resolveTemplateWithRow`: it previews the bind that follows
 *    composition rather than composition alone (issue #1062)
 *  - a user-defined variable named `$guid` beats the generator; generators run
 *    once per occurrence
 *  - a value that itself holds `{{tokens}}` resolves through them, to a depth
 *    bound, cycles left literal (issue #1009); the raw string, never the typed
 *    value
 *
 * The `{{name}}` matcher itself is `VARIABLE_PATTERN` from
 * `constants/variables.ts` - this module used to declare its own identical
 * copy, which is how the app came to hold four (issue #227).
 */

import { VARIABLE_PATTERN } from "@/constants/variables";
import { isDynamicVariableName, resolveDynamicVariable } from "./dynamic-variables";
import { isIterationVariableName } from "./iteration-variables";

/** A stored variable definition as it may actually arrive off disk - loose. */
export interface StoredVariableLike {
	value?: unknown;
	enabled?: unknown;
}

/** `Record<name, definition>` - the shape of every stored `variables` blob. */
export type StoredVariableBag = Record<string, StoredVariableLike>;

/**
 * D17: only an explicit `false` disables a definition. Absent (a blob written
 * by the raw engine API) and malformed values count as enabled, matching the
 * importers' normalization and the engine's `parse_variables`.
 */
export function isEnabledDefinition(def: StoredVariableLike | undefined): boolean {
	return !!def && typeof def === "object" && def.enabled !== false;
}

/**
 * D17: the raw stored string substitutes; a non-string stored `value` reads as
 * "" rather than being stringified (`42` printing as "42" in one client and
 * `undefined` printing as "undefined" in another is how this divergence was
 * found).
 */
export function coerceVariableValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/**
 * Build the effective variable map with the app's precedence (highest wins):
 * environment > collection chain (leaf over root) > globals. `chain` is
 * root-first, so later (leaf) entries overwrite earlier (root) ones.
 */
export function buildVariableValues(scopes: {
	globals?: StoredVariableBag;
	chain?: StoredVariableBag[];
	environment?: StoredVariableBag;
}): Map<string, string> {
	const map = new Map<string, string>();
	const collect = (bag: StoredVariableBag | undefined) => {
		if (!bag || typeof bag !== "object") return;
		for (const [name, def] of Object.entries(bag)) {
			if (isEnabledDefinition(def)) map.set(name, coerceVariableValue(def.value));
		}
	};
	collect(scopes.globals); // 1. globals (lowest)
	for (const bag of scopes.chain ?? []) collect(bag); // 2. chain root->leaf
	collect(scopes.environment); // 3. environment (highest)
	return map;
}

/**
 * The reserved prefix for the data namespace (issue #402). `{{data.column}}`
 * addresses a column of a collection run's data set, never a variable.
 */
export const DATA_NAMESPACE_PREFIX = "data.";

/**
 * True for a name inside the reserved `data.*` namespace.
 *
 * The namespace sits *outside* the tier order rather than above it, so a
 * variable someone happens to name `data.id` and the column `{{data.id}}` are
 * different names and cannot collide. The prefix alone (`{{data.}}`) names no
 * column, so it is not reserved - it follows the ordinary unknown-name rule.
 */
export function isDataVariableName(name: string): boolean {
	return name.length > DATA_NAMESPACE_PREFIX.length && name.startsWith(DATA_NAMESPACE_PREFIX);
}

/**
 * The column a `data.*` name addresses, or null for a name outside the
 * namespace.
 *
 * One place strips the prefix, rather than a `slice(5)` in the painter, another
 * in the audit and a third in the completion providers - each of which would
 * have to re-derive the boundary `isDataVariableName` already draws.
 */
export function dataColumnName(name: string): string | null {
	return isDataVariableName(name) ? name.slice(DATA_NAMESPACE_PREFIX.length) : null;
}

/**
 * The bare column names a bound data row will substitute (issue #1007).
 *
 * Postman binds a dataset's columns to bare names - `{{username}}` in a request
 * reads the current row - so a collection imported from it is written that way,
 * and the engine answers those names from the row at bind time, above the
 * environment. Composition holds only the *names*: a payload is composed once
 * and a row is bound per iteration, so what composition does about a bound
 * column is exactly what it does about `data.*` - leave the token written as it
 * stands.
 *
 * Empty is every resolution with no dataset behind it, which is every preview
 * that composes without a row in hand; the parameter exists so the preview
 * cannot answer the conformance fixture's cases differently from the engine. A
 * preview that *has* the row reads `resolveTemplateWithRow` instead, which is
 * the bind rather than the composition (issue #1062).
 */
export type BoundColumnNames = ReadonlySet<string>;

/** The set a resolution with no dataset behind it reads - shared, not rebuilt. */
const NO_BOUND_COLUMNS: BoundColumnNames = new Set<string>();

/**
 * How deep a value's own `{{tokens}}` are followed before the rest are left
 * written as they stand (issue #1009). The engine's `MAX_NESTED_RESOLUTIONS`,
 * restated: the two are pinned by the conformance fixture's cycle case, which
 * only terminates because both sides bound the work.
 */
const MAX_NESTED_RESOLUTIONS = 8;

/**
 * Replace every `{{name}}` in @p input with what @p lookup answers for it, a
 * name it answers `undefined` for keeping its braces.
 *
 * The engine's `substitute_tokens`, restated: the recursion and its bound live
 * here and the tier order lives in the lookup, which is what lets one core
 * serve both a composition preview (`resolveTemplate`) and a preview that holds
 * the row (`resolveTemplateWithRow`) without either restating the other's
 * nesting rules.
 *
 * A replacement that carries tokens of its own is resolved through the same
 * lookup, to `MAX_NESTED_RESOLUTIONS` levels, so a layered `{{baseUrl}}`
 * previews as the URL it spells. A name already being expanded is a cycle and
 * its token stays literal; the surrounding text is never rescanned.
 */
function substituteTokens(input: string, lookup: (name: string) => string | undefined): string {
	if (!input || typeof input !== "string") return input;
	// The names currently being expanded, innermost last - the chain the cycle
	// check reads, not a set of every name seen: `{{a}} {{a}}` side by side is
	// two expansions of one name and neither is a cycle.
	const expanding: string[] = [];
	const substitute = (text: string): string =>
		text.replace(VARIABLE_PATTERN, (match, rawName: string) => {
			const name = rawName.trim();
			if (expanding.includes(name)) return match;
			const value = lookup(name);
			if (value === undefined) return match;
			if (!value.includes("{{") || expanding.length >= MAX_NESTED_RESOLUTIONS) return value;
			expanding.push(name);
			try {
				return substitute(value);
			} finally {
				expanding.pop();
			}
		});
	return substitute(input);
}

/**
 * One name's answer for a resolution with no row behind it - the engine's
 * `lookup_variable`, tier for tier.
 *
 * `undefined` is "keeps its braces", which is every reserved or deferred name
 * as well as every name nothing defines.
 */
function lookupVariable(
	name: string,
	lookup: (name: string) => string | undefined,
	boundColumns: BoundColumnNames
): string | undefined {
	// Before the lookup, not after: the namespace is disjoint from the
	// scopes, so a variable named `data.id` must not answer for the column.
	// Only a scenario run's iteration can bind one, and the engine's
	// composer leaves it written as it stands for exactly that reason.
	if (isDataVariableName(name)) return undefined;
	// Same reasoning, same placement: `$vu` / `$iteration` name the
	// reserved identity namespace (issue #994), not a variable, so a
	// scope definition of either must not answer here either. Only the
	// iteration that sends binds them - the engine's composer leaves the
	// token written as it stands for exactly that reason.
	if (isIterationVariableName(name)) return undefined;
	// Before the lookup for the opposite reason: this name is *not*
	// disjoint from the scopes, and the row is the one that wins. Postman
	// puts a data column above the environment, so a scope answering here
	// would preview the value the row is there to replace - and ahead of
	// the generator table too, so a column named `$guid` is deferred rather
	// than generated. After the two reserved namespaces, as the engine
	// orders them.
	if (boundColumns.has(name)) return undefined;
	const defined = lookup(name);
	if (defined !== undefined) return defined;
	// The generator answers `null` for a name its table does not have, where a
	// scope answers `undefined` - one shape here, so the miss is tested once.
	return isDynamicVariableName(name) ? (resolveDynamicVariable(name) ?? undefined) : undefined;
}

/**
 * Substitute `{{name}}` occurrences: the reserved `data.*` namespace and the
 * reserved `$vu` / `$iteration` identity namespace first, with `boundColumns`
 * beside them (all kept verbatim, issue #1007), then scopes, then the
 * dynamic-variable table. A defined name (even one spelled `$guid`) wins over
 * a generator; a name nothing answers keeps its braces, `$name` (issue #186)
 * and ordinary alike (issue #1009) - the token reaching the wire is what makes
 * the miss visible, where an empty string silently changed the request.
 *
 * `boundColumns` defaults to empty, which is resolution as it was: every caller
 * with no dataset behind it resolves exactly the names it always did.
 */
export function resolveTemplate(
	input: string,
	lookup: (name: string) => string | undefined,
	boundColumns: BoundColumnNames = NO_BOUND_COLUMNS
): string {
	return substituteTokens(input, (name) => lookupVariable(name, lookup, boundColumns));
}

/**
 * One row's cells, keyed by column name with no `data.` prefix, holding the
 * text each substitutes - the engine's `DataRowColumns`.
 */
export type DataRowCells = ReadonlyMap<string, string>;

/**
 * Render one row value as the text a token substitutes - the engine's
 * `render_data_value`, restated.
 *
 * A string is its own text: the CSV/TSV path produces only strings, so this is
 * the ordinary case and it is byte-exact. A JSON or JSONL file may carry any
 * type: numbers and booleans render as JSON writes them (`7`, `true`), `null`
 * renders empty, and an object or array renders as compact JSON so a nested
 * value can still be dropped into a body.
 *
 * A null cell never reaches a request through the binder - it is refused, for
 * the same reason a missing column is - so the empty rendering is the answer to
 * "what does this value say", not a value the wire ever sees.
 */
export function renderDataValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "";
	// Every other cell came out of a CSV, TSV, JSON or JSONL parse, so it is a
	// number, a boolean, or a plain object or array - each of which `stringify`
	// spells. Nothing a data file can hold makes it answer nothing.
	return JSON.stringify(value);
}

/**
 * Resolve @p input against a bound row as well as the scopes - the engine's
 * `resolve_template_with_data`, restated for the preview that holds a row.
 *
 * Composition has no row: a payload is composed once and a row is bound per
 * iteration, which is why `resolveTemplate` above leaves both spellings of a
 * data read written as they stand. A Send-with-row's preview is the other case,
 * the one the engine meets in `pm.variables.replaceIn` (issue #890) - the row
 * is already picked, so the preview can show what the send will put on the wire
 * rather than the token that stands in for it.
 *
 * The tiers, in the engine's order:
 *  - `{{data.column}}` reads @p row, and a `data.` name the row has no column
 *    for keeps its braces rather than emptying - the token says the value came
 *    from the file, so a name no column answers is a mistake about the column
 *    and the quiet answer hides it (the Data tab's column audit is what names
 *    it, and `describeDataToken` is what paints it)
 *  - a bare name the row carries reads the row too (issue #1007), above the
 *    scopes, because that is where Postman puts a data variable
 *  - every other bare name falls through to `lookupVariable` with no bound
 *    columns: a name the row does not carry is an ordinary variable, not a
 *    mistake about a column, which is what keeps one request previewing the
 *    same way with and without a row picked
 */
export function resolveTemplateWithRow(
	input: string,
	lookup: (name: string) => string | undefined,
	row: DataRowCells
): string {
	return substituteTokens(input, (name) => {
		const column = dataColumnName(name);
		if (column !== null) return row.get(column);
		const cell = row.get(name);
		return cell !== undefined ? cell : lookupVariable(name, lookup, NO_BOUND_COLUMNS);
	});
}
