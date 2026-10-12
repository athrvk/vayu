/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file mock-issuer.ts
 * @brief The payloads the mock OAuth issuer tools send.
 */

/**
 * The fields `POST /mock-issuer/start` accepts, in the engine's spelling
 * (`parse_mock_issuer_settings`, engine/src/http/routes/mock_issuer.cpp). One
 * list rather than a hand-written object literal per field, so the payload
 * builder and the tool's input schema cannot drift apart.
 */
const MOCK_ISSUER_START_KEYS = [
	"port",
	"expiresInSeconds",
	"claims",
	"clients",
	"failureMode",
	"slowMs",
	"issueRefreshTokens",
] as const;

/** The failure modes the issuer's `/token` endpoint can be put into. */
export const MOCK_ISSUER_FAILURE_MODES = [
	"none",
	"slow",
	"server_error",
	"invalid_client",
] as const;

/**
 * The start body, carrying only the fields the caller actually named - an
 * absent one must stay absent, because the engine reads a present field with a
 * bad type or an out-of-range value as an error rather than falling back to the
 * default, and `undefined` would serialize to `null`.
 *
 * The engine's *limits* (the 31-day expiry ceiling, the 60s slow ceiling, 32
 * clients, 8 concurrent issuers) are deliberately not restated in the schema:
 * they live in `core/constants.hpp`, an out-of-range value comes back as a
 * `400 mock_issuer_invalid_config` naming the bound, and a second copy here
 * would be a second thing to keep in step - one that refuses values the engine
 * accepts the moment either side moves. What the schema does own is the shape:
 * a claims object, an integer port, a failure mode from the closed set above.
 */
export function mockIssuerStartPayload(args: Record<string, unknown>): Record<string, unknown> {
	const payload: Record<string, unknown> = {};
	for (const key of MOCK_ISSUER_START_KEYS) {
		if (args[key] !== undefined) payload[key] = args[key];
	}
	return payload;
}

/**
 * The settings `PUT /mock-issuer/:id` will change under a bound listener.
 *
 * Deliberately a subset of the start keys rather than the same list: the engine
 * refuses `port`, `clients`, `claims` and `issueRefreshTokens` on a running
 * issuer with "stop it and start a new one" (`apply_mock_issuer_patch`), so
 * offering them here would be offering a call that always fails. It is also a
 * subset of what the PUT accepts - `expiresInSeconds` is mutable engine-side
 * and is not offered, because a token's lifetime is fixed when it is minted, so
 * changing it mid-session changes nothing about the tokens already in the
 * agent's hands and only the *next* mint. #757 scoped this tool to the two
 * knobs the UI's own live edit exposes; widening it belongs to whoever finds a
 * use for it.
 */
const MOCK_ISSUER_PATCH_KEYS = ["failureMode", "slowMs"] as const;

/**
 * The merge-patch body for `update_mock_issuer`, carrying only what the caller
 * named - an omitted field keeps its current value engine-side, which is the
 * whole point of patching a live issuer rather than restarting it.
 */
export function mockIssuerPatchPayload(args: Record<string, unknown>): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	for (const key of MOCK_ISSUER_PATCH_KEYS) {
		if (args[key] !== undefined) patch[key] = args[key];
	}
	return patch;
}
