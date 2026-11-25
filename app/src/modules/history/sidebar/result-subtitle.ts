/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import {
	failedCheckPhrases,
	failedChecksOf,
	rowAssertionsOf,
} from "@/components/shared/run-assertions";
import {
	drainCutCancelledOf,
	formatErrorRate,
	stepCountsPhrase,
} from "@/components/shared/run-outcome";
import { STOP_REASONS } from "@/components/shared/capacityStop";
import { formatLatency, formatNumber, formatRate } from "@/lib/format-number";
import { pluralize } from "@/modules/dashboard/utils/format";
import type { CollectionResultSummary, LoadResultCapacity, LoadResultSummary } from "@/types";

/**
 * A finished load run's history-row line under its identity: "485 req/s · p95 42ms · 0.0% errors".
 * A figure the run did not record is left out, not zeroed; a row that recorded none has no line. A
 * failed check ends it in its verdict's words (#3537): "4,580 assertions failed", "4 assertions
 * failed in the sampled replay", "3 elements errored", what an HTTP-only error rate cannot say. A
 * drain cut by a Stop ends it with "15 requests unanswered" (#3538): the row's glyph reads not
 * judged and the verdict's sentence is not on the row.
 *
 * A capacity run's row prints the search's levels instead (#2930): its run-average rate blends
 * every level stepped through and describes none. A capacity row from an engine predating the block
 * has no `capacity` and keeps the line above.
 */
export function resultSubtitle(summary: LoadResultSummary): string | null {
	if (summary.capacity) return capacitySubtitle(summary.capacity);
	const { rps, p95Ms, errorRate } = summary;
	const parts: string[] = [];
	if (rps !== undefined) parts.push(`${formatRate(rps)} req/s`);
	if (p95Ms !== undefined) parts.push(`p95 ${formatLatency(p95Ms)}`);
	if (errorRate !== undefined) parts.push(`${formatErrorRate(errorRate)} errors`);
	parts.push(...failedCheckPhrases(failedChecksOf(rowAssertionsOf(summary))));
	const unanswered = drainCutCancelledOf(summary);
	if (unanswered)
		parts.push(`${formatNumber(unanswered)} ${pluralize(unanswered, "request")} unanswered`);
	return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * A finished collection run's history-row line when a step did not pass (#3458) or a budget was
 * missed (#3539): "2 passed, 1 failed, 4 errored", zero counts left out, "budgets missed" first
 * when both apply. A clean run has no line, so its row reads as before the engine sent counts.
 */
export function collectionSubtitle(summary: CollectionResultSummary): string | null {
	const budgets = summary.verdict === "failed" ? "budgets missed" : null;
	const unclean = stepCountsPhrase(summary, ["failed", "errored"]);
	const steps = unclean ? stepCountsPhrase(summary) : null;
	const parts = [budgets, steps].filter(Boolean);
	return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * What a capacity search found, as a History row's line: "held 41 · gave out at 51". Bare numbers
 * like the row's other figures; the unit is the mode's, which the row's mode label names.
 *
 * A knee only counts for a stop that watched the target degrade (`StopReason.finding`); a missing
 * held level beside one means the first level already breached, so it reads "gave out at M", never
 * "held 0". A plateau's held level is the last one tried and overshoots the plateau point, so the
 * row names no level ("plateaued"); a stop on a caller's bound (or a reason this build has no words
 * for) proves only a floor. A search with no level to report prints nothing: the average rate would
 * be the wrong answer, not a fallback.
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
