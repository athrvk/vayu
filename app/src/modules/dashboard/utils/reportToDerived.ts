/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { RunReport } from "@/types";
import type { DashboardDerived } from "../types";
import { resolveMode } from "../hooks/useMode";
import { isRateLimitedRun } from "./metricsTransforms";

/** Parse a duration string like "10s" to seconds; undefined/empty → undefined. */
function parseSeconds(s: string | undefined): number | undefined {
	if (!s) return undefined;
	const n = parseInt(s, 10);
	return Number.isFinite(n) ? n : undefined;
}

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
	const peak = s.peakConcurrency ?? 0;
	const duration = s.testDuration ?? s.totalDurationSeconds ?? 0;

	return {
		mode,
		isCompleted: true,
		targetRps,
		actualRps,
		sendRate: s.sendRate,
		throughput: s.throughput,
		currentRps: actualRps ?? 0,
		avgQueueWaitMs: s.avgQueueWaitMs ?? 0,
		totalRequests: s.totalRequests,
		failedRequests: s.failedRequests,
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
		rampUpDurationSeconds: parseSeconds(cfg.rampUpDuration),
		startConcurrency: cfg.startConcurrency,
		targetConcurrency: cfg.concurrency,
		breakpoint: { crossed: false, concurrency: null, timeSeconds: null, p99Ms: null },
	};
}
