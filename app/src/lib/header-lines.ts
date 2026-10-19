/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { HeaderLine } from "@/types/domain";

/**
 * The lines the engine sent, or `undefined` when it sent none (issue #2460).
 *
 * "Absent" and "empty" are one case on purpose, and this is the one place that
 * says so. A live answer carries `headerLines: []` for a response with no
 * headers, a stored trace omits the key, and an engine or row from before the
 * key has neither - so treating only `undefined` as missing would let the same
 * exchange build a different `ResponseState` live and restored. Both funnels
 * run their input through here.
 *
 * Absence is kept, not filled in from the folded map, because it is the only
 * signal that the Cookies tab is holding a folded `set-cookie` rather than one
 * received line: a derived line looks exactly like a real one, and parsing a
 * folded value as a single line shows several cookies as one.
 */
export function receivedHeaderLines(lines: HeaderLine[] | undefined): HeaderLine[] | undefined {
	return lines && lines.length > 0 ? lines : undefined;
}

/**
 * The header lines to display: the engine's when there are some, otherwise one
 * line per name of the folded map. For the tables and the Raw tab, which have
 * nothing better to show for a legacy row or a load-run sample.
 */
export function resolveHeaderLines(
	headers: Record<string, string> | undefined,
	lines: HeaderLine[] | undefined
): HeaderLine[] {
	return (
		receivedHeaderLines(lines) ??
		Object.entries(headers ?? {}).map(([name, value]) => ({ name, value }))
	);
}
