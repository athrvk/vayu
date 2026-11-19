/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A URL with its credentials masked for display (#3634), cut where the
 * engine's `redact_url_credentials` (`core/vayu_extensions.cpp`) cuts it: the
 * password of `user:password@host` is dropped and the user kept, and the value
 * of a query or fragment pair named like a credential
 * (`isSensitiveParamName`, pinned to the engine's list by
 * `url-credentials.conformance.test.ts`) reads {@link WITHHELD_MARKER}. A
 * `{{variable}}` standing alone is kept, and every other byte is as written.
 *
 * The one difference from the engine is the marker: an export empties the
 * value so a re-import holds no placeholder, while a display that showed
 * `access_token=` would say the token was sent empty.
 */

import { isSensitiveParamName } from "@/services/oauth/credential-params";
import { WITHHELD_MARKER } from "./withheld-value";

/** The engine's `is_variable_reference`: one `{{name}}`, spaces around it allowed. */
function isVariableReference(text: string): boolean {
	const trimmed = text.replace(/^ +| +$/g, "");
	if (trimmed.length < 5 || !trimmed.startsWith("{{") || !trimmed.endsWith("}}")) return false;
	const inner = trimmed.slice(2, -2);
	return !/[{}]/.test(inner) && inner.trim() !== "";
}

/**
 * The scheme, authority and path with the userinfo password dropped. The
 * userinfo ends at the *last* `@` of the authority, so a password holding one
 * is dropped whole; with no scheme, an authority holding a space is a path.
 */
function dropUserinfoPassword(head: string): string {
	const schemeEnd = head.indexOf("://");
	const hasScheme = schemeEnd !== -1 && !/[/ \t]/.test(head.slice(0, schemeEnd));
	const authorityStart = hasScheme ? schemeEnd + 3 : 0;
	const authorityEnd = head.indexOf("/", authorityStart);
	const authority = head.slice(authorityStart, authorityEnd === -1 ? undefined : authorityEnd);
	const at = authority.lastIndexOf("@");
	if (at === -1 || (!hasScheme && /[ \t]/.test(authority))) return head;

	const userinfo = authority.slice(0, at);
	const colon = userinfo.indexOf(":");
	const password = colon === -1 ? "" : userinfo.slice(colon + 1);
	if (password === "" || isVariableReference(password)) return head;
	return (
		head.slice(0, authorityStart) + userinfo.slice(0, colon) + head.slice(authorityStart + at)
	);
}

/** One `name=value` pair, its value masked when the name is a credential's. */
function maskPair(pair: string, extraNames: readonly string[]): string {
	const equals = pair.indexOf("=");
	if (equals === -1 || equals + 1 === pair.length) return pair;
	const name = pair.slice(0, equals);
	const value = pair.slice(equals + 1);
	if (!isSensitiveParamName(name, extraNames) || isVariableReference(value)) return pair;
	return `${name}=${WITHHELD_MARKER}`;
}

function maskQuery(query: string, extraNames: readonly string[]): string {
	return query
		.split("&")
		.map((pair) => maskPair(pair, extraNames))
		.join("&");
}

/**
 * @p url with its credentials masked. @p extraParamNames are the query
 * parameters the request's own auth wrote (`authQueryParam`), which no fixed
 * list can name.
 */
export function maskUrlCredentials(url: string, extraParamNames: readonly string[] = []): string {
	const fragmentAt = url.indexOf("#");
	const beforeFragment = fragmentAt === -1 ? url : url.slice(0, fragmentAt);
	const queryAt = beforeFragment.indexOf("?");
	let out = dropUserinfoPassword(
		queryAt === -1 ? beforeFragment : beforeFragment.slice(0, queryAt)
	);
	if (queryAt !== -1) out += `?${maskQuery(beforeFragment.slice(queryAt + 1), extraParamNames)}`;
	if (fragmentAt !== -1) out += `#${maskQuery(url.slice(fragmentAt + 1), extraParamNames)}`;
	return out;
}
