/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { RunReport } from "@/types";
import { durationSeconds } from "@/constants/load-test";
import type { DashboardDerived } from "../types";
import { resolveMode } from "../hooks/useMode";
import { errorBreakdown } from "./errorBreakdown";
import { notCrossed } from "./computeBreakpoint";
import { isRateLimitedRun } from "./metricsTransforms";

/**
 * Adapt a completed-run RunReport into the DashboardDerived bundle the live
 * dashboard's HeroRow/ModeStatsRow consume. Marks isCompleted=true so the
 * components use peak (not instantaneous) concurrency. Fields the report can't
 * supply without per-tick data (breakpoint, ramp deviation) get safe defaults.
 */
export function reportToDerived(report: RunReport): DashboardDerived {
	const cfg = report.metadata?.configuration ?? {};
	const s = report.summary;
	const lat = report.latency;
	const mode = resolveMode(cfg.mode);
	const targetRps = report.rateControl?.targetRps ?? cfg.targetRps;
	const actualRps = report.rateControl?.actualRps ?? s.avgRps;
	// The report's own percentage when it has one, so this card and the History
	// tile state one definition (#2392); a report without `rateControl` is
	// judged by the ratio the card always drew.
	const rateAchievementPct =
		report.rateControl?.achievement ??
		(targetRps && targetRps > 0 && actualRps !== undefined
			? (actualRps / targetRps) * 100
			: undefined);
	const peak = s.peakConcurrency ?? 0;
	const duration = s.testDuration ?? s.totalDurationSeconds ?? 0;

	return {
		mode,
		isCompleted: true,
		targetRps,
		actualRps,
		rateAchievementPct,
		sendRate: s.sendRate,
		throughput: s.throughput,
		currentRps: actualRps ?? 0,
		avgQueueWaitMs: s.avgQueueWaitMs ?? 0,
		totalRequests: s.totalRequests,
		failedRequests: s.failedRequests,
		...errorBreakdown(s.failedRequests, s.httpErrorRequests, s.noResponseRequests),
		statusCodes: report.statusCodes ?? {},
		requestsExpected: s.totalRequests,
		requestsSent: s.totalRequests,
		peakConcurrency: peak,
		currentConcurrency: peak, // completed → HeroRow reads peak anyway
		configuredConcurrency: cfg.concurrency,
		backpressure: 0,
		p99Latency: lat.p99,
		meanLatency: lat.avg,
		medianLatency: lat.median ?? lat.p50,
		p95Latency: lat.p95,
		testDuration: duration,
		elapsedSeconds: duration,
		setupOverhead: s.setupOverhead,
		droppedRequests: s.droppedRequests ?? 0,
		// Swap in the Dropped Requests card only when drops actually occurred -
		// matches the live MetricsView gate. A clean rate-limited run keeps the
		// Rate Fidelity card (otherwise it shows "0 dropped" with a false
		// "Server saturating" warning).
		showDropped: isRateLimitedRun(mode, targetRps) && (s.droppedRequests ?? 0) > 0,
		rampDeviationPct: undefined, // needs per-tick concurrency (deferred to W1)
		// A unit-aware parse: "2m" is 120 s, not 2 (#1945).
		rampUpDurationSeconds: durationSeconds(cfg.rampUpDuration) ?? undefined,
		startConcurrency: cfg.startConcurrency,
		targetConcurrency: cfg.concurrency,
		breakpoint: notCrossed(null),
	};
}
