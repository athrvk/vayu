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
 * **Both spellings a bound row answers count as a reference** (issue #1007):
 * `{{data.column}}`, always, and bare `{{column}}` when `column` is already a
 * declared column - the Postman shape, which a bound row substitutes exactly
 * as it does the prefixed one. A bare name that is *not* a declared column is
 * an ordinary variable token, not evidence about the contract either way, and
 * is not counted or reported here at all.
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
 *
 * **Auth credentials are request fields too** (issue #729). Since #591 a row
 * binds into the credentials a step sends - the flagship case being a
 * collection whose contract declares `user` and `password` for a basic-auth
 * pair - so a walk that stopped at URL, headers and body reported those two
 * columns as referenced by nothing while every iteration bound them. The
 * credentials walked here are exactly the ones the engine's
 * `walk_auth_credentials` visits: a bearer token, both halves of basic auth,
 * and an api key's name and value. **OAuth 2.0 is deliberately absent from
 * that set** - its config is the input to a token acquisition that happens once
 * per plan, so a data token there is refused rather than bound, and counting
 * one as a reference would report a binding the engine will not perform.
 *
 * The auth a request *sends* is not always the auth it *holds*: `inherit`
 * resolves through the collection chain, which needs collections this module
 * does not take. So the caller resolves it (`resolveEffectiveAuth`) and passes
 * the answer, and the type refuses `inherit` rather than silently walking no
 * credentials for the case that most needs them.
 *
 * **Collection scripts run for every step**, root-to-leaf ahead of the
 * request's own (`compose_script_parts`), so a `pm.iterationData.get("plan")`
 * written once on a parent collection is scanned here as well - under the same
 * best-effort label, and moving a verdict in the same conservative direction.
 */

import { VARIABLE_PATTERN } from "@/constants/variables";
import { dataColumnName } from "@/lib/variable-resolution";
import type { KeyValueEntry, Request, RequestAuth, RequestBody } from "@/types";

/**
 * What the audit needs from a request.
 *
 * `resolvedAuth` is not `Request["auth"]`: it is the auth the request will
 * actually send, with `inherit` already walked through the collection chain.
 * Required, and typed to exclude `inherit`, so a caller holding raw rows has to
 * resolve rather than accidentally hand over an `inherit` that walks nothing.
 */
export type AuditableRequest = Pick<
	Request,
	"url" | "params" | "headers" | "body" | "preRequestScript" | "postRequestScript"
> & {
	resolvedAuth: Exclude<RequestAuth, { mode: "inherit" }>;
};

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

/**
 * The credential strings a data row can bind, per auth mode.
 *
 * Mirrors the engine's `walk_auth_credentials` field for field. The switch is
 * exhaustive on purpose: a mode added to `RequestAuth` without a decision here
 * is a type error rather than a credential this silently stops walking.
 */
function authCredentials(auth: Exclude<RequestAuth, { mode: "inherit" }>): string[] {
	switch (auth.mode) {
		case "bearer":
			return [auth.token];
		case "basic":
			return [auth.username, auth.password];
		case "apikey":
			return [auth.key, auth.value];
		case "oauth2":
			// The config is not a credential the request carries - see the module
			// comment - so a token in it binds nothing and is not a reference.
			return [];
		case "inherit":
			// Unreachable through a caller that resolved, which is every caller:
			// `Exclude<RequestAuth, { mode: "inherit" }>` cannot actually remove
			// this mode, because it shares a union member with `none` and
			// `noauth` (the same reason `Collection.auth` carries it too). Walking
			// nothing is the honest answer for an auth whose credentials live
			// somewhere this function was not given.
			return [];
		case "none":
		case "noauth":
		case "digest":
		case "aws":
		case "ntlm":
			return [];
	}
}

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
	// Bound per iteration since #591, and applied (base64, percent-encoding)
	// only after the bind - so what a token sits in is the credential itself.
	strings.push(...authCredentials(request.resolvedAuth));
	return strings;
}

/**
 * The columns a string references, in the order they appear - both spellings
 * a bound row answers (issue #1007): `{{data.column}}` (always a column, any
 * name) and bare `{{column}}` (a column reference only when `declared` already
 * names it - a bare name declared nothing is an ordinary variable token and no
 * evidence about the contract either way, so it is not returned here at all).
 */
function columnsIn(text: string, declared: ReadonlySet<string>): string[] {
	if (!text) return [];
	const found: string[] = [];
	for (const match of text.matchAll(VARIABLE_PATTERN)) {
		const name = match[1].trim();
		const dataColumn = dataColumnName(name);
		if (dataColumn) {
			found.push(dataColumn);
		} else if (declared.has(name)) {
			found.push(name);
		}
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
 *
 * @param collectionScripts The pre- and post-request scripts of the collections
 *        whose chains the audited requests run under. Scanned on the same
 *        best-effort terms as a request's own scripts, because a run executes
 *        them for every step.
 */
export function auditDataColumns(
	declared: readonly string[],
	requests: readonly AuditableRequest[],
	collectionScripts: readonly string[] = []
): ColumnAudit {
	const declaredSet = new Set(declared);
	const referencedSet = new Set<string>();
	const undeclared: string[] = [];
	const scriptSet = new Set<string>();

	for (const request of requests) {
		for (const text of bindableStrings(request)) {
			for (const column of columnsIn(text, declaredSet)) {
				if (declaredSet.has(column)) referencedSet.add(column);
				else if (!undeclared.includes(column)) undeclared.push(column);
			}
		}
		for (const script of [request.preRequestScript, request.postRequestScript]) {
			for (const column of scriptColumnsIn(script)) scriptSet.add(column);
		}
	}

	for (const script of collectionScripts) {
		for (const column of scriptColumnsIn(script)) scriptSet.add(column);
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
