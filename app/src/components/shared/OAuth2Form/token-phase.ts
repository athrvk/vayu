/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { OAuth2TokenStatusResponse } from "@/types";

export const TOKEN_ACTION_LABELS = ["Get token", "Renew", "Refresh"] as const;

export type TokenActionLabel = (typeof TOKEN_ACTION_LABELS)[number];

/** How the expiry reads: a word, then the time when there is one. */
export interface TokenExpiryText {
	word: "expires" | "expired" | "does not expire";
	at: number | null;
}

/**
 * Everything the token row shows that depends on whether the token is still
 * good, decided once. The dot, the action's label and glyph and the expiry text
 * each used to ask separately - two of them the engine's `expired` flag, which
 * is up to a refetch old, and one the local clock - so for up to 30 seconds
 * past the expiry they disagreed on one row (#3354).
 */
export interface TokenPhase {
	dotClass: string;
	actionLabel: TokenActionLabel;
	/** The action's glyph says renew (a current token) rather than fetch. */
	renews: boolean;
	/** Null when no token is cached. */
	expiry: TokenExpiryText | null;
}

const NO_TOKEN: TokenPhase = {
	dotClass: "bg-muted-foreground/40",
	actionLabel: "Get token",
	renews: false,
	expiry: null,
};

function expiryText(expiresAt: number | null, lapsed: boolean): TokenExpiryText {
	if (lapsed) return { word: "expired", at: expiresAt };
	if (expiresAt === null) return { word: "does not expire", at: null };
	return { word: "expires", at: expiresAt };
}

/** The epoch ms at which a cached token that is still good stops being, or null. */
export function lapseInstant(status: OAuth2TokenStatusResponse | undefined): number | null {
	if (!status?.found || !status.token || status.expired) return null;
	return status.token.expiresAt;
}

/**
 * The phase of the token @p status describes at @p now (epoch ms). A token has
 * lapsed once the engine says so or its own `expiresAt` has passed, whichever
 * is first: the flag lags the clock and the clock cannot see a revocation.
 * A token with no `expiresAt` lapses only by the flag.
 */
export function tokenPhase(status: OAuth2TokenStatusResponse | undefined, now: number): TokenPhase {
	const token = status?.found ? status.token : undefined;
	if (!status || !token) return NO_TOKEN;

	const { expiresAt } = token;
	const lapsed = status.expired === true || (expiresAt !== null && expiresAt <= now);
	return {
		dotClass: lapsed ? "bg-warning" : "bg-status-success",
		actionLabel: lapsed ? "Refresh" : "Renew",
		renews: !lapsed,
		expiry: expiryText(expiresAt, lapsed),
	};
}
