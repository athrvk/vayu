/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The two knobs `POST /mock/start` takes beyond the collection (issue #570).
 *
 * Its own file, like `mock-server-selection.ts` beside it, so the dialog
 * exports nothing but a component and fast refresh keeps working - and so the
 * bounds live somewhere a test can read them without rendering.
 *
 * Bounds mirror the engine's own (`core/constants.hpp`, `mock_server::`, plus
 * the literal 0-100 `parse_mock_start` applies to the rate). Out of range is a
 * `400 bad_request` that names the field and not the bound, which is a poor
 * place to learn the range from - so the form refuses the value with the bound
 * spelled out instead.
 */

/** `constants::mock_server::MAX_LATENCY_MS`. */
export const MAX_MOCK_LATENCY_MS = 30_000;
/** A share of answers, so the bound is the percentage itself. */
export const MAX_MOCK_ERROR_RATE_PCT = 100;

/** What the start dialog collects, in the shape `POST /mock/start` takes. */
export interface MockServerOptions {
	latencyMs: number;
	errorRatePct: number;
}

/** Both knobs off - a mock that answers its examples as fast as it can. */
export const DEFAULT_MOCK_OPTIONS: MockServerOptions = { latencyMs: 0, errorRatePct: 0 };

/**
 * The refusal for @p text as a field bounded `0..max`, or null when it is
 * sendable.
 *
 * An empty box is refused rather than read as 0: `Number("")` is 0 and a whole
 * number, so every other check here passes it, and a silently-zeroed field is
 * the one case where the form would send something the user did not type.
 */
export function outOfRange(text: string, max: number, noun: string): string | null {
	const bound = `A whole number of ${noun}, 0 to ${max}.`;
	if (text.trim() === "") return bound;
	const value = Number(text);
	if (!Number.isInteger(value) || value < 0 || value > max) return bound;
	return null;
}
