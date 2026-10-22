/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The `allowedOrigins` a mock server or an inbox starts with (#2367).
 *
 * With none, the listener answers `Access-Control-Allow-Origin: *` and never
 * with credentials; with a list, only those pages may read it, with the user's
 * cookies. The engine refuses a malformed entry with a `400` naming it, so this
 * mirrors the same rules (`origin_shape_error`, `canonical_origin` in
 * `engine/src/http/url_parts.cpp`, and `parse_allowed_origins` in `routes.hpp`)
 * to say so in the form instead of after a round trip. The engine stays the
 * authority: nothing here is needed for correctness, only for the wording.
 */

import { pluralize } from "@/modules/dashboard/utils/format";

/** `constants::mock_server::MAX_ALLOWED_ORIGINS` and the inbox's twin. */
export const MAX_ALLOWED_ORIGINS = 32;
/** `constants::mock_server::MAX_ALLOWED_ORIGIN_LENGTH`, in bytes, and the inbox's twin. */
export const MAX_ALLOWED_ORIGIN_BYTES = 512;

export type ParsedAllowedOrigins =
	{ origins: string[]; error: null } | { origins: []; error: string };

function hasWhitespaceOrControl(text: string): boolean {
	return [...text].some((char) => {
		const code = char.charCodeAt(0);
		return code <= 0x20 || code === 0x7f;
	});
}
const SCHEME_AND_AUTHORITY = /^(https?):\/\/(.*)$/i;

/** Why @p origin is not an `http(s)://host[:port]`, or null when it is one. */
function originShapeError(origin: string): string | null {
	if (origin === "null") return "is the opaque origin 'null', which names no one site";
	if (hasWhitespaceOrControl(origin)) return "contains whitespace";
	if (origin.includes("*")) return "is a wildcard - list each origin by name";
	const match = SCHEME_AND_AUTHORITY.exec(origin);
	if (!match) return "must start http:// or https://";
	const authority = match[2];
	if (authority === "") return "has no host";
	if (authority.includes("@")) return "carries a user name or password";
	if (/[/?#\\]/.test(authority)) {
		return "has a path, query or fragment - an origin ends at the host or port";
	}
	return null;
}

/**
 * The canonical spelling of @p origin, or why it cannot be one.
 *
 * `URL.origin` is the WHATWG serialisation `ada` produces on the engine's side:
 * scheme and host lowercased, a default port dropped. Parsing is what catches an
 * authority the shape rules let through (`http://:80`, a port past 65535).
 */
function canonicalOrigin(origin: string): { origin: string } | { error: string } {
	const shape = originShapeError(origin);
	if (shape) return { error: shape };
	try {
		return { origin: new URL(origin).origin };
	} catch {
		return { error: "does not name a valid host and port" };
	}
}

/**
 * The origins in @p text, one per line: trimmed, blank lines dropped, each in
 * canonical spelling and repeated ones (after canonicalisation) listed once.
 *
 * The first line that cannot be an origin is named in `error`, never skipped:
 * a dropped entry is a page the user meant to admit and is refused without a
 * word.
 */
export function parseAllowedOrigins(text: string): ParsedAllowedOrigins {
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "");

	const encoder = new TextEncoder();
	const origins: string[] = [];
	for (const line of lines) {
		if (encoder.encode(line).length > MAX_ALLOWED_ORIGIN_BYTES) {
			return {
				origins: [],
				error: `Couldn't use an origin longer than ${MAX_ALLOWED_ORIGIN_BYTES} bytes.`,
			};
		}
		const canonical = canonicalOrigin(line);
		if ("error" in canonical) {
			return { origins: [], error: `Couldn't use "${line}" - it ${canonical.error}.` };
		}
		if (!origins.includes(canonical.origin)) origins.push(canonical.origin);
	}

	if (origins.length > MAX_ALLOWED_ORIGINS) {
		return {
			origins: [],
			error: `Couldn't list ${origins.length} origins - at most ${MAX_ALLOWED_ORIGINS}.`,
		};
	}
	return { origins, error: null };
}

/**
 * The policy a listener is running under, in words: `Origins: any` for the
 * default, else the list. Written once so the drawer, the inbox tab and the
 * mock tab cannot describe the same record three ways.
 */
export function describeOriginPolicy(allowedOrigins: readonly string[]): string {
	if (allowedOrigins.length === 0) return "Origins: any";
	return `Origins: ${allowedOrigins.join(", ")}`;
}

/** The same policy as a count, for a row with no room for the list. */
export function summarizeOriginPolicy(allowedOrigins: readonly string[]): string {
	if (allowedOrigins.length === 0) return "Any origin";
	return `${allowedOrigins.length} ${pluralize(allowedOrigins.length, "origin")}`;
}
