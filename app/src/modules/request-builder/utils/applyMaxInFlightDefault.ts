/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Inject the global "max in-flight requests" default into a load-test request.
 *
 * Rules:
 * - A per-run value always wins. If the request already specifies `maxInFlight`,
 *   the request is returned unchanged.
 * - Otherwise the global default is applied, but only when it is a positive,
 *   finite number. A `null`/`undefined`/`0`/negative global means "auto", in
 *   which case the request is left untouched so the engine derives its own
 *   per-strategy default.
 *
 * Pure function — returns a new object only when a value is injected.
 */
export function applyMaxInFlightDefault<T extends { maxInFlight?: number }>(
	request: T,
	globalDefault: number | null | undefined
): T {
	// Per-run value always wins (== null catches both null and undefined).
	if (request.maxInFlight != null) {
		return request;
	}

	// Only inject a positive, finite global default; otherwise leave as auto.
	if (
		typeof globalDefault !== "number" ||
		!Number.isFinite(globalDefault) ||
		globalDefault <= 0
	) {
		return request;
	}

	return { ...request, maxInFlight: globalDefault };
}
