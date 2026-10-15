/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { formatResponseTime } from "@/components/shared";
import { formatErrorRate, formatRps } from "@/components/shared/run-outcome";
import type { LoadResultSummary } from "@/types";

/**
 * The line a finished load run's history row prints under its identity:
 * "485 req/s · p95 42 ms · 0.0% errors". A figure the run did not record is left
 * out rather than zeroed, and a row that recorded none has no line at all.
 */
export function resultSubtitle(summary: LoadResultSummary): string | null {
	const { rps, p95Ms, errorRate } = summary;
	const parts: string[] = [];
	if (rps !== undefined) parts.push(`${formatRps(rps)} req/s`);
	if (p95Ms !== undefined) parts.push(`p95 ${formatResponseTime(p95Ms)}`);
	if (errorRate !== undefined) parts.push(`${formatErrorRate(errorRate)} errors`);
	return parts.length > 0 ? parts.join(" · ") : null;
}
