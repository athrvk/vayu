/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which header a session Console row masks by name (#3672): the engine's
 * logger set (`kSecretFieldNames` in `log_redact.hpp`, as `electron/log.ts`
 * ports it) less the three challenge headers. A script-request row arrives
 * masked by the engine under that rule, so a Send row, built in the renderer,
 * must judge the same names or one request shows `apikey` in clear on its own
 * row and masked on its script's. The challenge headers carry a scheme and a
 * realm, no credential, and are what a 401 is diagnosed from, so the engine
 * keeps them in a record and so does the row.
 *
 * Pinned to the engine by `engine/tests/fixtures/log-redaction-conformance.json`
 * (`secretFieldNames`, `challengeHeaderNames`). `sensitive-headers.ts` is a
 * different, narrower list (what a code snippet masks) and stays as it is.
 */

import { asciiLower } from "@/services/oauth/credential-params";

/** The logger's set without `www-authenticate`, `proxy-authenticate` and `authentication-info`. */
const SECRET_HEADER_NAMES: ReadonlySet<string> = new Set([
	"authorization",
	"proxy-authorization",
	"cookie",
	"set-cookie",
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
	"code",
	"code_verifier",
	"private_key",
	"secret_access_key",
	"secretaccesskey",
	"session_token",
]);

/** Whether a header named @p name holds a credential, ASCII case folded as the engine folds it. */
export function isSecretHeaderName(name: string): boolean {
	return SECRET_HEADER_NAMES.has(asciiLower(name));
}
