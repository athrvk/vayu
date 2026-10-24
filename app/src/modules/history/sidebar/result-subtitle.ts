/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { formatAssertionsFailed, formatErrorRate } from "@/components/shared/run-outcome";
import { formatLatency, formatRate } from "@/lib/format-number";
import type { LoadResultSummary } from "@/types";

/**
 * The line a finished load run's history row prints under its identity:
 * "485 req/s · p95 42ms · 0.0% errors". A figure the run did not record is left
 * out rather than zeroed, and a row that recorded none has no line at all. A
 * scenario load run that failed assertions says so last (#2820): its error rate
 * is HTTP-only and reads 0.0% beside them.
 */
export function resultSubtitle(summary: LoadResultSummary): string | null {
	const { rps, p95Ms, errorRate, assertionsFailed } = summary;
	const parts: string[] = [];
	if (rps !== undefined) parts.push(`${formatRate(rps)} req/s`);
	if (p95Ms !== undefined) parts.push(`p95 ${formatLatency(p95Ms)}`);
	if (errorRate !== undefined) parts.push(`${formatErrorRate(errorRate)} errors`);
	if (assertionsFailed !== undefined && assertionsFailed > 0) {
		parts.push(formatAssertionsFailed(assertionsFailed));
	}
	return parts.length > 0 ? parts.join(" · ") : null;
}
