/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Estimated seconds remaining for a closed-ended (iterations) run: (requestsExpected -
 * requestsSent) / currentRps. Null when the run is open-ended (requestsExpected === 0) or
 * currentRps is non-positive (no basis to project); clamped to 0 once the run has met its expected
 * count.
 */
export interface EtaInputs {
	requestsExpected: number;
	requestsSent: number;
	currentRps: number;
}

export function computeEta({
	requestsExpected,
	requestsSent,
	currentRps,
}: EtaInputs): number | null {
	if (requestsExpected <= 0) return null;
	if (currentRps <= 0) return null;
	const remaining = Math.max(0, requestsExpected - requestsSent);
	return remaining / currentRps;
}
