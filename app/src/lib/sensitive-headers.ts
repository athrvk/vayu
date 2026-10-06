/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which header rows carry a credential whatever their value is (issue #1806).
 *
 * A secret *variable* is masked by value; a header typed straight into the
 * Headers tab is not a variable, so the name is the only signal. The list is
 * the engine's header subset of `is_secret_field_name` (`log_redact.hpp`), the
 * names its curl-debug redaction blanks, pinned to it by
 * `engine/tests/fixtures/log-redaction-conformance.json`'s
 * `sensitiveHeaderNames`. The request's own API-key header is the one name no
 * list can hold, so a caller passes it in.
 */

export const SENSITIVE_HEADER_NAMES: readonly string[] = [
	"authorization",
	"proxy-authorization",
	"cookie",
	"set-cookie",
	"x-api-key",
	"x-auth-token",
	"x-csrf-token",
];

/** Whether a header named `name` holds a credential, compared case-insensitively. */
export function isSensitiveHeaderName(name: string, apiKeyHeaderName?: string): boolean {
	const folded = name.trim().toLowerCase();
	if (folded === "") return false;
	if (SENSITIVE_HEADER_NAMES.includes(folded)) return true;
	return folded === apiKeyHeaderName?.trim().toLowerCase();
}
