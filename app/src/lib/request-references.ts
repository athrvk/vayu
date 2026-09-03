/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The strings a request carries that hold `{{variables}}`, and the distinct
 * variable names it references.
 *
 * Two walks live here, because two engine functions substitute two different
 * field sets and a surface that used one for the other would be wrong:
 *
 * - `bindableStrings` mirrors the engine's **data binder**
 *   (`scenario_data.cpp` `walk_bindable_fields`): URL, header names and values,
 *   body text, form field names and values, plus query params (composition folds
 *   them into the URL before the binder runs) and the credential strings of the
 *   auth the request sends. This is the set a *data row* binds, and the column
 *   audit (`services/data-files/column-audit.ts`) is its consumer - it answers
 *   "which declared columns does a run bind", so it must not walk a field the
 *   binder never touches.
 * - `templatedStrings` is that set plus a form-data file part's `src`,
 *   `fileName` and `contentType` - the wider set the **composer**
 *   (`request_composer.cpp` `resolve_form_field`) interpolates `{{...}}` into.
 *   A `{{token}}` in a file part's content type is a real variable reference the
 *   send resolves, so the request tab's variables view walks it, while the data
 *   binder does not bind a row there and the audit must not count it.
 *
 * `referencedVariableNames` is what the context bar's variables section reads: the
 * ordinary `{{name}}` references the request uses, in first-seen order, with the
 * `data.*` namespace and the `$dynamic` generators left out - neither is a
 * variable the user defines and manages - followed by the names a `pm.*.get()`
 * call in a script actually reads. A `{{name}}` inside script text is excluded:
 * the engine never interpolates a script (D16), so those characters reach the
 * script verbatim and say nothing about a variable it reads.
 */

import { VARIABLE_PATTERN } from "@/constants/variables";
import { dataColumnName } from "@/lib/variable-resolution";
import { referencedVariables } from "@/lib/referenced-variables";
import { isDynamicVariableName } from "@/lib/dynamic-variables";
import type { KeyValueEntry, Request, RequestAuth, RequestBody } from "@/types";

/**
 * What a reference walk needs from a request.
 *
 * `resolvedAuth` is not `Request["auth"]`: it is the auth the request will
 * actually send, with `inherit` already walked through the collection chain.
 * Required, and typed to exclude `inherit`, so a caller holding raw rows has to
 * resolve rather than accidentally hand over an `inherit` that walks nothing.
 */
export type RequestReferenceSource = Pick<
	Request,
	"url" | "params" | "headers" | "body" | "preRequestScript" | "postRequestScript"
> & {
	resolvedAuth: Exclude<RequestAuth, { mode: "inherit" }>;
};

/**
 * The credential strings a data row can bind, per auth mode.
 *
 * Mirrors the engine's `walk_auth_credentials` field for field. The switch is
 * exhaustive on purpose: a mode added to `RequestAuth` without a decision here
 * is a type error rather than a credential this silently stops walking.
 */
export function authCredentials(auth: Exclude<RequestAuth, { mode: "inherit" }>): string[] {
	switch (auth.mode) {
		case "bearer":
			return [auth.token];
		case "basic":
			return [auth.username, auth.password];
		case "apikey":
			return [auth.key, auth.value];
		case "oauth2":
			// The config is the input to a token acquisition, not a credential the
			// request carries - so a data token in it binds nothing and is not a
			// reference, matching the engine.
			return [];
		case "inherit":
			// Unreachable through a caller that resolved, which is every caller:
			// `Exclude<RequestAuth, { mode: "inherit" }>` cannot actually remove this
			// mode, because it shares a union member with `none` and `noauth`.
			return [];
		case "none":
		case "noauth":
		case "digest":
		case "aws":
		case "ntlm":
			return [];
	}
}

/**
 * Every string a request carries that can hold a `{{variable}}`, in walk order:
 * URL, params, headers, body, then the auth credentials the request sends.
 *
 * One walk serves both consumers; `includeFileFields` is the only thing that
 * differs between them, and it is the binder-versus-composer distinction, not a
 * knob:
 * - Off (the default, the column audit's field set) mirrors the engine's data
 *   binder (`walk_bindable_fields`): a form part contributes its name and value.
 * - On (`templatedStrings`, the composer's field set) also walks a form-data file
 *   part's `src`, `fileName` and `contentType` (`resolve_form_field`), which the
 *   composer interpolates but the binder never binds a data row into.
 * The file fields sit with the form part they belong to, before the auth
 * credentials, so the two callers see the same order for every field they share.
 */
export function bindableStrings(
	request: RequestReferenceSource,
	options?: { includeFileFields?: boolean }
): string[] {
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
	if (body?.mode === "form-data") {
		for (const field of body.fields ?? []) {
			strings.push(field.key, field.value);
			if (options?.includeFileFields) {
				if (field.src) strings.push(field.src);
				if (field.fileName) strings.push(field.fileName);
				if (field.contentType) strings.push(field.contentType);
			}
		}
	} else if (body?.mode === "x-www-form-urlencoded") {
		entries(body.fields);
	}
	// Bound per iteration since #591, and applied (base64, percent-encoding) only
	// after the bind - so what a token sits in is the credential itself.
	strings.push(...authCredentials(request.resolvedAuth));
	return strings;
}

/** The composer's field set - `bindableStrings` including form-data file parts. */
function templatedStrings(request: RequestReferenceSource): string[] {
	return bindableStrings(request, { includeFileFields: true });
}

/**
 * The ordinary variable names this request references, in first-seen order.
 *
 * Request fields first (`templatedStrings` order), then the names a `pm.*.get()`
 * call reads in the pre- and post-request scripts. Deduplicated: a name written
 * in the URL and again in a header is one reference.
 *
 * Left out, because none is a variable the ladder defines:
 * - `data.*` - a data-contract column, not a variable (see `dataColumnName`).
 * - `$dynamic` generators - `{{$guid}}` resolves from the generator table, so it
 *   is neither defined nor "undefined"; listing it would mark it red for no fix.
 * - `{{name}}` in script text - never interpolated (D16), so it reads nothing.
 * - `pm.iterationData.get()` - a row read, the data contract's business, not a
 *   variable read (see `referenced-variables`, `PmRead`).
 */
export function referencedVariableNames(request: RequestReferenceSource): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	const add = (name: string) => {
		const trimmed = name.trim();
		if (!trimmed || seen.has(trimmed)) return;
		if (dataColumnName(trimmed) !== null) return;
		if (isDynamicVariableName(trimmed)) return;
		seen.add(trimmed);
		result.push(trimmed);
	};

	for (const text of templatedStrings(request)) {
		if (!text) continue;
		for (const match of text.matchAll(VARIABLE_PATTERN)) add(match[1]);
	}

	for (const script of [request.preRequestScript, request.postRequestScript]) {
		for (const reference of referencedVariables(script ?? "")) {
			// `pm` reads a variable; `template` (a `{{}}` in script text) reads
			// nothing. `row` is `pm.iterationData` - a data read, not a variable.
			if (reference.via === "pm" && reference.reads !== "row") add(reference.name);
		}
	}

	return result;
}
