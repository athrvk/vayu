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

/** Minimal token shape the coverage decision needs. */
export interface CoverageToken {
	expiresAt: number | null;
	expiresIn: number;
}

export type CoverageState =
	| { kind: "inert" }
	| { kind: "no-config" }
	| { kind: "no-token" }
	| { kind: "covered"; nonExpiring: boolean; remainingMs?: number }
	| { kind: "refresh"; remainingMs: number; lifetimeMs: number; durationMs: number }
	| { kind: "too-long"; lifetimeMs: number; durationMs: number };

/**
 * Decide whether a duration-based test is covered by the token. Pure so the
 * state machine can be unit-tested without React. `now` is injectable for tests.
 */
export function coverageState(
	durationSeconds: number | null,
	hasCacheKey: boolean,
	token: CoverageToken | undefined,
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
	if (durationMs <= lifetimeMs) return { kind: "refresh", remainingMs, lifetimeMs, durationMs };
	return { kind: "too-long", lifetimeMs, durationMs };
}
