/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A request's own timeout, as the Settings tab edits it (issue #2937): a
 * number of milliseconds inside the engine's range, or `null` for "use the
 * `defaultTimeout` setting".
 */

import { MAX_REQUEST_TIMEOUT_MS, MIN_REQUEST_TIMEOUT_MS } from "@/constants/request";
import { formatMs } from "@/lib/format-number";
import type { ConfigEntry } from "@/types";

const DEFAULT_TIMEOUT_KEY = "defaultTimeout";

/**
 * The typed text as a stored timeout, clamped into the range the engine
 * accepts (it refuses anything outside with a 400, so an unclamped value would
 * fail every save). `null` for text that is not a number: the caller decides
 * whether that is "keep what was there" or "clear".
 */
export function parseTimeout(raw: string): number | null {
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed)) return null;
	return Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(MIN_REQUEST_TIMEOUT_MS, parsed));
}

/**
 * The `defaultTimeout` setting in milliseconds, or `null` while the config has
 * not arrived or the entry cannot be read. Null rather than the engine's
 * seeded 30 s: the field's empty state names the number a send will use, and
 * guessing it would state one the engine is not applying.
 */
export function defaultTimeoutFrom(entries: ConfigEntry[] | undefined): number | null {
	const entry = entries?.find((e) => e.key === DEFAULT_TIMEOUT_KEY);
	if (!entry) return null;
	const ms = Number.parseInt(entry.value, 10);
	return Number.isNaN(ms) || ms <= 0 ? null : ms;
}

/** What the empty field says a send will do. */
export function timeoutPlaceholder(defaultMs: number | null): string {
	return defaultMs === null ? "Use default" : `Use default (${formatMs(defaultMs)} ms)`;
}
