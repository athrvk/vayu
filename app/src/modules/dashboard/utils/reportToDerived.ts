/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { RunReport } from "@/types";
import { durationSeconds } from "@/constants/load-test";
import type { DashboardDerived, ReceivedWindow, StoppedAt } from "../types";
import { resolveMode } from "../hooks/useMode";
import { errorBreakdown } from "./errorBreakdown";
import { notCrossed } from "./computeBreakpoint";
import { dispatchStatus } from "./dispatchLag";
import { shouldShowDropped } from "./metricsTransforms";
import { pooledLatencyOf } from "./pooledLatency";
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
 * The rate responses came back at, on the window `sendRate` was measured over
 * (#2882): completions counted when sending ended, over the sending window.
 * `throughput` divides the whole run, drain included, so beside `sendRate` it
 * reads as the server falling behind by exactly the drain it was given. A
 * report without the count (an older engine) or a usable window keeps
 * `throughput`, labelled as the whole-run figure it is.
 */
function receivedRateOf(s: RunReport["summary"]): {
	receivedRate: number | undefined;
	receivedWindow: ReceivedWindow;
} {
	const { completedWhileSending, sendingDurationSeconds } = s;
	if (
		completedWhileSending === undefined ||
		sendingDurationSeconds === undefined ||
		!Number.isFinite(sendingDurationSeconds) ||
		sendingDurationSeconds <= 0
	) {
		return { receivedRate: s.throughput, receivedWindow: "wholeRun" };
	}
	return {
		receivedRate: completedWhileSending / sendingDurationSeconds,
		receivedWindow: "sending",
	};
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
	const { receivedRate, receivedWindow } = receivedRateOf(s);
	const peak = s.peakConcurrency ?? 0;
	const duration = s.testDuration ?? s.totalDurationSeconds ?? 0;
	const droppedRequests = s.droppedRequests ?? 0;
	const skippedRequests = s.skippedRequests ?? 0;

	return {
		mode,
		isCompleted: true,
		targetRps,
		actualRps,
		rateAchievementPct,
		stoppedAt: stopped?.stoppedAt,
		sendRate: s.sendRate,
		// Whole-run on purpose: the achieved-throughput, iterations and per-VU cards
		// read it. Only the Send / Throughput pair takes `receivedRate`.
		throughput: s.throughput,
		receivedRate,
		receivedWindow,
		// A finished run has nothing in flight and no clock left to wait on, so the
		// pair is judged as held and settled, on the same `receivedRate` the card prints.
		dispatchStatus: dispatchStatus({
			sendRate: s.sendRate,
			receivedRate,
			held: true,
			settled: true,
		}),
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
		avgInFlight: s.avgInFlight,
		configuredConcurrency: cfg.concurrency,
		backpressure: 0,
		p99Latency: lat.p99,
		meanLatency: lat.avg,
		medianLatency: lat.median ?? lat.p50,
		p95Latency: lat.p95,
		pooledLatency: pooledLatencyOf(report),
		testDuration: duration,
		elapsedSeconds: duration,
		setupOverhead: s.setupOverhead,
		cleanupOverhead: s.cleanupOverhead,
		droppedRequests,
		skippedRequests,
		stalledMs: s.stalledMs ?? 0,
		// Swap in the Dropped Requests card only when requests were lost - the
		// live MetricsView calls the same helper. A clean rate-limited run keeps
		// the Rate Fidelity card (otherwise it shows "0 dropped" with a false
		// "Server saturating" warning).
		showDropped: shouldShowDropped(mode, targetRps, droppedRequests, skippedRequests),
		rampDeviationPct: undefined, // filled from the stored series by LoadTestDetail
		// A unit-aware parse: "2m" is 120 s, not 2 (#1945).
		rampUpDurationSeconds: durationSeconds(cfg.rampUpDuration) ?? undefined,
		startConcurrency: cfg.startConcurrency,
		targetConcurrency: cfg.concurrency,
		// A capacity run names its own budget; every other report has no threshold
		// until LoadTestDetail judges its stored series against the Settings SLO.
		breakpoint: notCrossed(report.capacity?.sloMs ?? null),
		capacity: report.capacity,
	};
}
