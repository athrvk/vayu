/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a mock issuer's `failureMode` means, in one place: the row badge, the row's live switch and
 * the start dialog all name these modes, and three copies of the mapping would be three chances to
 * call `server_error` different things.
 *
 * Bounds mirror the engine's (`core/constants.hpp`, `mi::`): a value outside them is a
 * `400 mock_issuer_invalid_config`, so the dialog refuses it up front rather than turning a typo
 * into a failed request.
 */

import { pluralize } from "@/modules/dashboard/utils/format";
import type { MockIssuer, MockIssuerFailureMode } from "@/types";

export const FAILURE_MODE_LABELS: Record<MockIssuerFailureMode, string> = {
	none: "None",
	slow: "Slow",
	server_error: "Server error",
	invalid_client: "Invalid client",
	metadata_not_found: "Metadata not found",
	registration_refused: "Registration refused",
	wrong_iss: "Wrong iss",
};

/**
 * Each mode's clause in the expanded row's summary. A `Record` over the union, so a new mode fails
 * to compile here instead of reading as healthy.
 */
const FAILURE_MODE_EFFECTS: Record<MockIssuerFailureMode, (issuer: MockIssuer) => string | null> = {
	none: () => null,
	slow: (issuer) => `answers after ${issuer.slowMs}ms`,
	server_error: () => "answers with a server error",
	invalid_client: () => "rejects every client id",
	metadata_not_found: () => "hides its metadata document",
	registration_refused: () => "refuses client registration",
	wrong_iss: () => "sends a wrong iss on the authorize redirect",
};

/** `mi::MAX_EXPIRES_IN_SECONDS` - 31 days. */
export const MAX_EXPIRES_IN_SECONDS = 31 * 86400;
/** `mi::MAX_SLOW_MS`. */
export const MAX_SLOW_MS = 60_000;
export const DEFAULT_EXPIRES_IN_SECONDS = 3600;
export const DEFAULT_SLOW_MS = 2000;

/** The issuer's configuration as one line, for the expanded row. */
export function failureModeSummary(issuer: MockIssuer): string {
	const parts = [`Tokens expire in ${issuer.expiresInSeconds}s`];
	// `?.`: a mode from an engine newer than this app has no clause, and the
	// summary should say nothing rather than throw while the row renders.
	const effect = FAILURE_MODE_EFFECTS[issuer.failureMode]?.(issuer);
	if (effect) parts.push(effect);
	parts.push(
		issuer.clientCount === 0
			? "any client id accepted"
			: `${issuer.clientCount} ${pluralize(issuer.clientCount, "client")} configured`
	);
	if (issuer.issueRefreshTokens) parts.push("refresh tokens issued");
	if (issuer.resourceScope) parts.push(`resource requires scope ${issuer.resourceScope}`);
	return `${parts.join(" · ")}.`;
}
