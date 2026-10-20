/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { OAuth2Config } from "@/types";

const US = "\x1f"; // unit separator: between fields and segments
const RS = "\x1e"; // record separator: between the rows of a segment

/** The lists the key reads, in the order it reads them. */
const EXTRA_PARAM_LISTS = ["authorizationParams", "tokenParams", "refreshParams"] as const;

/** Names the engine writes itself, so a row of one is never sent (`RESERVED_PARAM_NAMES`). */
const RESERVED_PARAM_NAMES: ReadonlySet<string> = new Set([
	"grant_type",
	"client_id",
	"client_secret",
	"code",
	"redirect_uri",
	"code_verifier",
	"refresh_token",
	"username",
	"password",
	"scope",
	"state",
	"code_challenge",
	"code_challenge_method",
	"response_type",
]);

const SEND_AS_VALUES: ReadonlySet<unknown> = new Set(["body", "url", "header"]);

const encoder = new TextEncoder();

/** A config field as the engine reads it: a string, else "". */
const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** UTF-8 byte order, which is how the engine's `std::string` sort compares. */
function compareBytes(a: string, b: string): number {
	const x = encoder.encode(a);
	const y = encoder.encode(b);
	const shared = Math.min(x.length, y.length);
	for (let i = 0; i < shared; i++) {
		if (x[i] !== y[i]) return x[i] - y[i];
	}
	return x.length - y.length;
}

/** The engine's `extra_param`: the (key, value) of a row it would send, else null. */
function eligiblePair(row: unknown): [string, string] | null {
	if (typeof row !== "object" || row === null || Array.isArray(row)) return null;
	const { key, value, enabled, sendAs } = row as Record<string, unknown>;
	if (enabled === false) return null;
	if (typeof key !== "string" || key === "" || RESERVED_PARAM_NAMES.has(key)) return null;
	if (sendAs != null && !SEND_AS_VALUES.has(sendAs)) return null;
	return [key, text(value)];
}

/** One list's segment, or "" when it has no eligible row. */
function extraParamsSegment(
	config: OAuth2Config,
	list: (typeof EXTRA_PARAM_LISTS)[number]
): string {
	const rows: unknown = config[list];
	if (!Array.isArray(rows)) return "";
	const pairs = rows.map(eligiblePair).filter((pair) => pair !== null);
	if (pairs.length === 0) return "";
	pairs.sort(([ka, va], [kb, vb]) => compareBytes(ka, kb) || compareBytes(va, vb));
	return `${US}${list}:${pairs.map(([k, v]) => `${k}=${v}`).join(RS)}`;
}

/**
 * Compute the token cache key for an OAuth 2.0 config.
 *
 * MUST stay byte-identical with the engine's vayu::http::oauth::cache_key
 * (engine/src/http/oauth_client.cpp) - both sides key the token cache by this
 * string, and the shared test vectors in cache-key.test.ts / oauth_client_test.cpp
 * pin the format:
 *
 *   accessTokenUrl \x1f clientId \x1f (credentialsId|"default")
 *   \x1f (grantType === "password" ? username : "")
 *
 * then, for each of authorizationParams, tokenParams and refreshParams with at
 * least one row the engine would send (issue #2536):
 *
 *   \x1f listName ":" key "=" value ( \x1e key "=" value )*
 *
 * the rows' (key, value) pairs sorted by key, then value, in UTF-8 byte order,
 * so row order and `sendAs` do not change the key. A config with no such row
 * keys exactly as it did before the lists existed.
 *
 * Note: `scope`/`audience`/`resource` are intentionally omitted (matches
 * Postman's keying). Configs differing only in scope share a cached token; set a
 * distinct credentialsId to separate them. An audience sent as a row is read.
 */
export function computeOAuth2CacheKey(config: OAuth2Config): string {
	const username = config.grantType === "password" ? text(config.username) : "";
	const base = [
		text(config.accessTokenUrl),
		text(config.clientId),
		text(config.credentialsId) || "default",
		username,
	].join(US);
	return base + EXTRA_PARAM_LISTS.map((list) => extraParamsSegment(config, list)).join("");
}
