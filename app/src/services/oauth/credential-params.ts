/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which OAuth 2.0 extra request parameter rows carry a credential: the
 * engine's `names_param_credential` (`engine/src/core/vayu_extensions.cpp`),
 * which the token cache key (`cache-key.ts`) must match byte for byte. The MCP
 * server holds the same lists in `electron/mcp/withhold.ts`, which cannot
 * import from `src/`; `electron/mcp/withhold.conformance.test.ts` holds the
 * two copies equal and pins {@link SENSITIVE_PARAM_NAMES} to the engine's
 * fixture.
 */

/** The engine's `SECRET_AUTH_KEYS`: auth members that hold a credential. Matched as written. */
export const CREDENTIAL_AUTH_MEMBERS: readonly string[] = [
	"token",
	"password",
	"value",
	"clientSecret",
	"secretKey",
	"accessKey",
	"sessionToken",
	"accessToken",
	"refreshToken",
	"idToken",
	"secret",
	"authKey",
	"consumerSecret",
	"tokenSecret",
	"clientToken",
	"privateKey",
	"code_verifier",
];

/** The engine's `SECRET_PARAM_KEYS`: the wire names a credential goes by. Matched as written. */
export const CREDENTIAL_PARAM_KEYS: readonly string[] = [
	"client_secret",
	"client_assertion",
	"code_verifier",
	"refresh_token",
	"access_token",
	"id_token",
	"password",
	"assertion",
];

/**
 * The engine's `is_secret_param_name` with no API-key name: the shared
 * secret-field set less `code`, plus `EXTRA_SECRET_PARAM_NAMES`. Matched on
 * the whole name, ASCII case folded; it holds the credential header names, so
 * a row sent as a header is judged by the same list.
 */
export const SENSITIVE_PARAM_NAMES: readonly string[] = [
	"authorization",
	"proxy-authorization",
	"cookie",
	"set-cookie",
	"www-authenticate",
	"proxy-authenticate",
	"authentication-info",
	"token",
	"access_token",
	"refresh_token",
	"client_secret",
	"password",
	"apikey",
	"x-api-key",
	"x-auth-token",
	"x-csrf-token",
	"passphrase",
	"api_key",
	"id_token",
	"code_verifier",
	"private_key",
	"secret_access_key",
	"secretaccesskey",
	"session_token",
	"api-key",
	"secret",
	"auth_token",
	"signature",
	"sig",
	"x-amz-signature",
	"x-amz-security-token",
	"client_assertion",
	"assertion",
];

const AUTH_MEMBER_SET: ReadonlySet<string> = new Set(CREDENTIAL_AUTH_MEMBERS);
const PARAM_KEY_SET: ReadonlySet<string> = new Set(CREDENTIAL_PARAM_KEYS);
const SENSITIVE_PARAM_SET: ReadonlySet<string> = new Set(SENSITIVE_PARAM_NAMES);

/** ASCII-only fold, the engine's `ascii_lower`: `toLowerCase` would also fold the Kelvin sign into `k`. */
function asciiLower(text: string): string {
	return text.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

/** Whether an extra request parameter row named @p key carries a credential. */
export function namesCredentialParam(key: string): boolean {
	return (
		AUTH_MEMBER_SET.has(key) ||
		PARAM_KEY_SET.has(key) ||
		SENSITIVE_PARAM_SET.has(asciiLower(key))
	);
}
