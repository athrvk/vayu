/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { ExchangeWarning } from "@/types/domain";

/**
 * The warnings an exchange carries, or `undefined` when it has none (issue
 * #3307). Same rule as `receivedHeaderLines`: a live `/execute` body always
 * carries `warnings: []` while a stored trace writes the key only when
 * non-empty, so both funnels run their input through here and one exchange builds
 * one `ResponseState` live and restored.
 *
 * Takes `unknown` because a stored trace is whatever its engine wrote: an entry
 * without a string `code` and `message` is skipped rather than drawn as an empty
 * band, and a list that leaves nothing is absent.
 */
export function receivedWarnings(raw: unknown): ExchangeWarning[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const warnings = raw.filter(
		(entry): entry is ExchangeWarning =>
			typeof entry === "object" &&
			entry !== null &&
			typeof entry.code === "string" &&
			typeof entry.message === "string"
	);
	return warnings.length > 0 ? warnings : undefined;
}
