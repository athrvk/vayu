/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { RunReport } from "@/types";
import { durationSeconds } from "@/constants/load-test";
import type { DashboardDerived, StoppedAt } from "../types";
import { resolveMode } from "../hooks/useMode";
import { errorBreakdown } from "./errorBreakdown";
import { notCrossed } from "./computeBreakpoint";
import { isRateLimitedRun } from "./metricsTransforms";
import { liveRateFidelity } from "./rateFidelity";

/**
 * A Stop ends the sending early, so the report's `achievement` is the share of
 * the whole plan the run reached (about 50% for a Stop at the halfway mark),
 * while the live card judged the same run by pace (#2805). A stopped run is
 * read by pace here too, with the plan share kept apart as `stoppedAt`.
 * `undefined` when the report lacks a count, a window or a target (a run stored
 * before #2392): the stored achievement stands and no plan line is drawn.
 */
function stoppedRunFidelity(
	report: RunReport,
	targetRps: number | undefined
): { achievementPct: number; stoppedAt?: StoppedAt } | undefined {
	if (report.metadata?.status !== "stopped") return undefined;
	const requestsSent = report.rateControl?.requestsSent;
	const elapsedSeconds = report.summary.sendingDurationSeconds;
	if (requestsSent === undefined || elapsedSeconds === undefined) return undefined;

	const plannedSeconds = durationSeconds(report.metadata.configuration?.duration);
	const pace = liveRateFidelity({
		targetRps,
		requestsSent,
		elapsedSeconds,
		durationSeconds: plannedSeconds ?? undefined,
	});
	if (pace?.achievementPct === undefined) return undefined;

	const planSharePct = report.rateControl?.achievement;
	const stoppedAt =
		plannedSeconds !== null && planSharePct !== undefined
			? { planSharePct, plannedSeconds }
			: undefined;
	return { achievementPct: pace.achievementPct, stoppedAt };
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
	const stopped = stoppedRunFidelity(report, targetRps);
	// The report's own percentage when it has one, so this card and the History
	// tile state one definition (#2392); a report without `rateControl` is
	// judged by the ratio the card always drew.
	const rateAchievementPct =
		stopped?.achievementPct ??
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
		stoppedAt: stopped?.stoppedAt,
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
