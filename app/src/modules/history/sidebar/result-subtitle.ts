/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { assertionsFailedPhrase } from "@/components/shared/run-assertions";
import { formatErrorRate } from "@/components/shared/run-outcome";
import { STOP_REASONS } from "@/components/shared/capacityStop";
import { formatLatency, formatNumber, formatRate } from "@/lib/format-number";
import type { LoadResultCapacity, LoadResultSummary } from "@/types";

/**
 * The line a finished load run's history row prints under its identity:
 * "485 req/s · p95 42ms · 0.0% errors". A figure the run did not record is left
 * out rather than zeroed, and a row that recorded none has no line at all. A
 * scenario run with failed assertions (#2820) ends it with "4,580 assertions
 * failed", the one thing its HTTP-only error rate cannot say.
 *
 * A capacity run's row carries the search's levels (#2930) and prints those
 * instead: its run-average rate blends every level the search stepped through
 * and describes none of them. A capacity row from an engine that predates the
 * block has no `capacity` and keeps the line above.
 */
export function resultSubtitle(summary: LoadResultSummary): string | null {
	if (summary.capacity) return capacitySubtitle(summary.capacity);
	const { rps, p95Ms, errorRate, assertionsFailed } = summary;
	const parts: string[] = [];
	if (rps !== undefined) parts.push(`${formatRate(rps)} req/s`);
	if (p95Ms !== undefined) parts.push(`p95 ${formatLatency(p95Ms)}`);
	if (errorRate !== undefined) parts.push(`${formatErrorRate(errorRate)} errors`);
	const assertions = assertionsFailedPhrase(assertionsFailed);
	if (assertions) parts.push(assertions);
	return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * What a capacity search found, as a History row's line: "held 41 · gave out
 * at 51". Bare numbers, as the row's other figures are; the unit is the mode's
 * and the row's mode label already names it.
 *
 * A knee only counts for a stop that watched the target degrade
 * (`StopReason.finding`), and a missing held level beside one means the first
 * level already breached, so it reads "gave out at M" and never "held 0". A
 * plateau's held level is the last one tried and overshoots the plateau point,
 * so the row names no level ("plateaued"); a stop on a bound the caller set (or
 * a reason this build has no words for) proves only a floor. A search with no level to report prints nothing: the average rate
 * would be the wrong answer, not a fallback.
 */
export function capacitySubtitle(capacity: LoadResultCapacity): string | null {
	const { maxHealthyConcurrency: held, kneeConcurrency: knee } = capacity;
	const finding = STOP_REASONS[capacity.stopReason]?.finding;
	if (finding === "degrading" && knee !== undefined) {
		const gaveOut = `gave out at ${formatNumber(knee)}`;
		return held === undefined ? gaveOut : `held ${formatNumber(held)} · ${gaveOut}`;
	}
	if (finding === "saturated") return "plateaued";
	if (held === undefined) return null;
	return `held at least ${formatNumber(held)}`;
}
