/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Size formatting for settings: which entries are byte counts and how a
 * min/max range reads. The digits come from `formatBytes` in `lib/format-number`.
 */

import { formatBytes } from "@/lib/format-number";

/**
 * Whether an entry's value is a byte count, and so reads as `1.0 MB` rather
 * than as `1048576`.
 *
 * The entry declares it (`ConfigEntry.unit`, seeded engine-side). This used to
 * be a hardcoded list of three keys here, which is the app re-deriving a fact
 * the engine owns: an engine entry measured in bytes was formatted as a bare
 * number until someone remembered to edit this array, and two keys had already
 * been left in it after #519 retired them.
 */
export function isByteUnit(unit?: string): boolean {
	return unit === "bytes";
}

/**
 * Format min/max values for size configs
 * @param min - Minimum value as string
 * @param max - Maximum value as string
 */
export function formatSizeRange(min?: string, max?: string): string | null {
	if (!min && !max) return null;

	const parts: string[] = [];
	if (min) {
		const minBytes = parseInt(min, 10);
		if (!isNaN(minBytes)) {
			parts.push(`Min: ${formatBytes(minBytes)}`);
		}
	}
	if (max) {
		const maxBytes = parseInt(max, 10);
		if (!isNaN(maxBytes)) {
			parts.push(`Max: ${formatBytes(maxBytes)}`);
		}
	}

	return parts.length > 0 ? parts.join(", ") : null;
}
