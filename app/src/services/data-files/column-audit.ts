/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Referenced columns versus declared ones (issue #600).
 *
 * `schema-diff` beside this answers "does this *file* match the contract";
 * this answers "do the *requests* match it", which is the question the Data tab
 * can ask without a file at all. A `{{data.emial}}` typo is invisible until a
 * run reaches that request, binds nothing and sends the braces literally.
 *
 * **Request fields are authoritative, scripts are not.** The fields walked here
 * are exactly the ones the engine's binder walks (`scenario_data.cpp`
 * `walk_bindable_fields`: URL, header names and values, body text, form field
 * names and values) plus query params, which composition folds into the URL
 * before the binder sees them. A script, by contrast, computes its column names
 * at run time - `pm.iterationData.get(key)` is unanswerable here - so the
 * script scan finds string literals only and is labeled as best-effort
 * everywhere it is shown. The engine remains the run-time authority; this is
 * authoring-time advice.
 *
 * The one direction the best-effort scan is allowed to move a verdict is the
 * conservative one: a column a script literal names is not reported as
 * unreferenced. Telling someone a column is unused when a script reads it is
 * the worse error, and it is the one that gets a working column deleted.
 */

import { VARIABLE_PATTERN } from "@/constants/variables";
import { dataColumnName } from "@/lib/variable-resolution";
import type { KeyValueEntry, Request, RequestBody } from "@/types";

/** What the audit needs from a request - `Request` satisfies it structurally. */
export type AuditableRequest = Pick<
	Request,
	"url" | "params" | "headers" | "body" | "preRequestScript" | "postRequestScript"
>;

export interface ColumnAudit {
	/** Declared columns a request field references. */
	referenced: string[];
	/** Referenced by a request field, declared by nothing - the warning bucket. */
	undeclared: string[];
	/** Declared, and nothing found referencing it - informational. */
	unreferenced: string[];
	/**
	 * Columns named by a literal `pm.iterationData.get("x")` / `.has("x")`.
	 * Best-effort by construction - see the module comment.
	 */
	inScripts: string[];
}

/**
 * `pm.iterationData.get("column")`, and the `has` spelling, with a literal
 * argument. Optional chaining is allowed because the surface is `undefined`
 * outside a data-driven run and its own docs tell scripts to guard.
 *
 * A computed argument (`get(key)`) matches nothing here on purpose: a name this
 * cannot see is exactly why the result is labeled rather than claimed.
 */
const SCRIPT_COLUMN_PATTERN = /iterationData\s*\??\.\s*(?:get|has)\s*\(\s*(['"`])([^'"`\\]*)\1/g;

/** Every string a data row can bind in one request, in the binder's own order. */
function bindableStrings(request: AuditableRequest): string[] {
	const strings: string[] = [request.url];
	const entries = (rows: readonly KeyValueEntry[] | undefined) => {
		for (const row of rows ?? []) {
			strings.push(row.key, row.value);
		}
	};
	// Params are folded into the URL by composition, before the binder runs, so
	// a token in one binds exactly as a token in the URL does.
	entries(request.params);
	entries(request.headers);
	const body: RequestBody | undefined = request.body;
	if (body && "content" in body) strings.push(body.content);
	if (body && "fields" in body) entries(body.fields);
	return strings;
}

/** The `data.*` columns a string references, in the order they appear. */
function columnsIn(text: string): string[] {
	if (!text) return [];
	const found: string[] = [];
	for (const match of text.matchAll(VARIABLE_PATTERN)) {
		const column = dataColumnName(match[1].trim());
		if (column) found.push(column);
	}
	return found;
}

/** The columns a script names with a literal argument. */
function scriptColumnsIn(script: string): string[] {
	if (!script) return [];
	return [...script.matchAll(SCRIPT_COLUMN_PATTERN)]
		.map((match) => match[2])
		.filter((column) => column.length > 0);
}

/**
 * Audit `requests` against `declared`.
 *
 * Column order follows the contract for the declared buckets and first
 * appearance for the undeclared one, so the panel reads the way the Data tab
 * above it does. Every list is deduplicated: a column referenced by nine
 * requests is one column.
 */
export function auditDataColumns(
	declared: readonly string[],
	requests: readonly AuditableRequest[]
): ColumnAudit {
	const declaredSet = new Set(declared);
	const referencedSet = new Set<string>();
	const undeclared: string[] = [];
	const scriptSet = new Set<string>();

	for (const request of requests) {
		for (const text of bindableStrings(request)) {
			for (const column of columnsIn(text)) {
				if (declaredSet.has(column)) referencedSet.add(column);
				else if (!undeclared.includes(column)) undeclared.push(column);
			}
		}
		for (const script of [request.preRequestScript, request.postRequestScript]) {
			for (const column of scriptColumnsIn(script)) scriptSet.add(column);
		}
	}

	return {
		referenced: declared.filter((column) => referencedSet.has(column)),
		undeclared,
		unreferenced: declared.filter(
			(column) => !referencedSet.has(column) && !scriptSet.has(column)
		),
		inScripts: [...scriptSet],
	};
}
