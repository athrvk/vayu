/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the engine writes in place of a credential in a stored run's
 * `configSnapshot` (`kRedactedMarker` in `engine/include/vayu/utils/log_redact.hpp`;
 * keep the two spellings equal). A sensitive header's whole value becomes this,
 * and a secret variable's value inside the url, params, headers or body becomes
 * it as a substring (#1803).
 *
 * A snapshot value holding it is not a value the run sent, so nothing may
 * replay it or save it onto a request.
 */
export const WITHHELD_MARKER = "<redacted>";

/** True when a string holds the marker, as a whole value or as a substring. */
export function isWithheld(value: string): boolean {
	return value.includes(WITHHELD_MARKER);
}

/** True when any string leaf under `node` holds the marker. */
export function holdsWithheld(node: unknown): boolean {
	if (typeof node === "string") return isWithheld(node);
	if (Array.isArray(node)) return node.some(holdsWithheld);
	if (node && typeof node === "object") return Object.values(node).some(holdsWithheld);
	return false;
}
