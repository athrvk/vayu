/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Pure coverage decision for OAuth2LoadTestGuard, split out so the state machine
 * can be unit-tested without React and so the component file only exports a
 * component (keeps React Fast Refresh happy).
 */

export function fmtDuration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.round(m / 60);
	return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

import type { OAuth2Config } from "@/types";

/** Minimal token shape the coverage decision needs. */
export interface CoverageToken {
	expiresAt: number | null;
	expiresIn: number;
	hasRefreshToken: boolean;
}

export type CoverageState =
	| { kind: "inert" }
	| { kind: "no-config" }
	| { kind: "no-token" }
	| {
			kind: "covered";
			nonExpiring: boolean;
			remainingMs?: number;
			/** Covered because the engine renews the token mid-run, not because
			 *  the cached one outlives the test. */
			viaRefresh?: boolean;
	  }
	| { kind: "refresh"; remainingMs: number; lifetimeMs: number; durationMs: number }
	| { kind: "too-long"; lifetimeMs: number; durationMs: number };

/**
 * Whether the engine will keep this credential current for the whole run.
 *
 * Mirrors the config-and-token cases of `plan_auth_refresh`
 * (engine/src/http/auth_resolver.cpp) - the guard must not promise a refresh
 * the engine will not perform, and must not block a run the engine can carry.
 * Change one, change both.
 *
 * It cannot mirror that function's last case, which plans a refresh only for a
 * run whose `Authorization` header is the token's own value, and declines when
 * a user-supplied header beat the token to it - swapping the token under that
 * header would change nothing on the wire. This decision is made before a
 * request is composed and is handed a config and a token, never headers, so
 * that case is outside its inputs. The gap leans the safe way: it takes a
 * user-supplied `Authorization` header to reach, and such a run is
 * authenticated by that header rather than by this token, which makes the
 * coverage question moot. Covering it would be a signature change.
 */
export function isMidRunRefreshable(
	config: Pick<OAuth2Config, "grantType" | "tokenPlacement" | "autoRefreshToken">,
	token: CoverageToken | undefined
): boolean {
	if (!token || token.expiresIn <= 0) return false;
	// A query-placed token is baked into the URL of every transfer; no header
	// swap reaches it.
	if (config.tokenPlacement === "query") return false;
	if (config.autoRefreshToken === false) return false;
	// This grant's only non-interactive way back is a refresh token, and a run
	// must never pop a browser mid-flight.
	if (config.grantType === "authorization_code" && !token.hasRefreshToken) return false;
	return true;
}

/**
 * Decide whether a duration-based test is covered by the token. Pure so the
 * state machine can be unit-tested without React. `now` is injectable for tests.
 *
 * @param refreshable Whether the engine renews the token mid-run
 *                    ({@link isMidRunRefreshable}). When it does, a test longer
 *                    than the token is covered rather than blocked.
 */
export function coverageState(
	durationSeconds: number | null,
	hasCacheKey: boolean,
	token: CoverageToken | undefined,
	refreshable: boolean,
	now: number = Date.now()
): CoverageState {
	if (durationSeconds == null || durationSeconds <= 0) return { kind: "inert" };
	if (!hasCacheKey) return { kind: "no-config" };
	if (!token) return { kind: "no-token" };
	if (token.expiresAt == null || token.expiresIn <= 0) {
		return { kind: "covered", nonExpiring: true };
	}
	const durationMs = durationSeconds * 1000;
	const remainingMs = token.expiresAt - now;
	const lifetimeMs = token.expiresIn * 1000;
	if (durationMs <= remainingMs) return { kind: "covered", nonExpiring: false, remainingMs };
	// The token dies mid-run, and the engine renews it there: nothing to warn
	// about, and nothing for the user to do.
	if (refreshable) {
		return { kind: "covered", nonExpiring: false, remainingMs, viaRefresh: true };
	}
	if (durationMs <= lifetimeMs) return { kind: "refresh", remainingMs, lifetimeMs, durationMs };
	return { kind: "too-long", lifetimeMs, durationMs };
}
