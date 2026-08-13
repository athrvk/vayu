/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a mock issuer's `failureMode` means, in one place.
 *
 * The row badge, the row's live switch and the start dialog all name these four
 * modes; three copies of the mapping would be three chances for the UI to call
 * `server_error` something the next surface calls something else.
 *
 * Bounds mirror the engine's own (`core/constants.hpp`, `mi::`): asking for a
 * value outside them is a `400 mock_issuer_invalid_config`, so the dialog
 * refuses it up front rather than turning a typo into a failed request.
 */

import type { MockIssuer, MockIssuerFailureMode } from "@/types";

export const FAILURE_MODE_LABELS: Record<MockIssuerFailureMode, string> = {
	none: "None",
	slow: "Slow",
	server_error: "Server error",
	invalid_client: "Invalid client",
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
	if (issuer.failureMode === "slow") {
		parts.push(`answers after ${issuer.slowMs}ms`);
	} else if (issuer.failureMode !== "none") {
		parts.push(`answers ${FAILURE_MODE_LABELS[issuer.failureMode].toLowerCase()}`);
	}
	parts.push(
		issuer.clientCount === 0
			? "any client id accepted"
			: `${issuer.clientCount} client${issuer.clientCount === 1 ? "" : "s"} configured`
	);
	if (issuer.issueRefreshTokens) parts.push("refresh tokens issued");
	return `${parts.join(" · ")}.`;
}
