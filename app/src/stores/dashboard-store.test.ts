/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useDashboardStore, deriveRunProgress, runOwnSloMs } from "./dashboard-store";
import type { LoadTestMetrics, RunReport } from "@/types";
import { useClientSettingsStore } from "./client-settings-store";
import { DEFAULT_SLO_THRESHOLD_MS } from "@/constants/client-settings";

function tick(elapsed: number, p99 = 10): LoadTestMetrics {
	return {
		timestamp: elapsed * 1000,
		elapsed_seconds: elapsed,
		requests_completed: 0,
		requests_failed: 0,
		current_rps: 0,
		current_concurrency: Math.round(elapsed),
		latency_p50_ms: 5,
		latency_p95_ms: 8,
		latency_p99_ms: p99,
		avg_latency_ms: 6,
		bytes_sent: 0,
		bytes_received: 0,
	};
}

describe("dashboard-store live retention window", () => {
	beforeEach(() => {
		useDashboardStore.getState().startRun("r");
	});

	it("trims ticks older than the time window (measured from the newest tick)", () => {
		const s = useDashboardStore.getState();
		s.setLiveWindowSeconds(60);
		s.addMetricsBatch(Array.from({ length: 13 }, (_, i) => tick(i * 10))); // 0..120s

		const hist = useDashboardStore.getState().historicalMetrics;
		// Newest = 120s, cutoff = 60s → keep 60,70,…,120 (7 ticks).
		expect(hist).toHaveLength(7);
		expect(hist[0].elapsed_seconds).toBe(60);
		expect(hist[hist.length - 1].elapsed_seconds).toBe(120);
	});

	it("keeps everything when the window is 'full' (null)", () => {
		const s = useDashboardStore.getState();
		s.setLiveWindowSeconds(null);
		s.addMetricsBatch(Array.from({ length: 500 }, (_, i) => tick(i)));
		expect(useDashboardStore.getState().historicalMetrics).toHaveLength(500);
	});

	// The ceiling is the engine's `liveMaxRetainedTicks`, synced in by
	// useLiveWindowSync - so the trim has to read the store's value, not a
	// module constant, or raising the setting would enlarge the engine's ring
	// while this side kept discarding at the old number.
	it("trims to the configured tick ceiling, not a fixed constant", () => {
		const s = useDashboardStore.getState();
		s.setLiveWindowSeconds(null); // full run - the ceiling is the only bound
		s.setMaxRetainedTicks(120);
		s.addMetricsBatch(Array.from({ length: 500 }, (_, i) => tick(i)));

		const hist = useDashboardStore.getState().historicalMetrics;
		expect(hist).toHaveLength(120);
		// The newest are kept, so the chart's right edge stays live.
		expect(hist[hist.length - 1].elapsed_seconds).toBe(499);
		expect(hist[0].elapsed_seconds).toBe(380);
	});

	it("ignores a non-positive ceiling rather than emptying the history", () => {
		const s = useDashboardStore.getState();
		s.setMaxRetainedTicks(0);
		expect(useDashboardStore.getState().maxRetainedTicks).toBe(50000);
	});

	it("latched aggregates survive ticks rolling out of the window", () => {
		const s = useDashboardStore.getState();
		s.setLiveWindowSeconds(60);
		// A crossing at t=5s (p99 over the 200ms SLO), then advance well past the window.
		s.addMetricsBatch([tick(5, 250)]);
		s.addMetricsBatch(Array.from({ length: 13 }, (_, i) => tick(70 + i * 5)));

		const state = useDashboardStore.getState();
		// The crossing tick (t=5) has rolled off, but the breakpoint stays latched.
		expect(state.historicalMetrics.some((m) => m.elapsed_seconds === 5)).toBe(false);
		expect(state.breakpoint.crossed).toBe(true);
		expect(state.breakpoint.timeSeconds).toBe(5);
		expect(state.breakpoint.p99Ms).toBe(250);
		expect(state.breakpoint.sloMs).toBe(200);
	});
});

describe("dashboard-store breakpoint on live frames (issue #2385)", () => {
	beforeEach(() => {
		useClientSettingsStore.setState({ sloThresholdMs: DEFAULT_SLO_THRESHOLD_MS });
		useDashboardStore.getState().startRun("r");
	});

	it("latches on a gate frame's second p99, not on a window between gates", () => {
		const s = useDashboardStore.getState();
		// A ~100 ms window reading over the SLO, then a gate whose second did not.
		s.addMetricsBatch([
			{ ...tick(0.5, 900), live: true },
			{
				...tick(1, 900),
				live: true,
				second_samples: 80,
				second_p50_ms: 5,
				second_p95_ms: 8,
				second_p99_ms: 120,
			},
		]);
		expect(useDashboardStore.getState().breakpoint.crossed).toBe(false);

		s.addMetricsBatch([
			{
				...tick(2, 10),
				live: true,
				second_samples: 80,
				second_p50_ms: 5,
				second_p95_ms: 90,
				second_p99_ms: 310,
			},
		]);
		const { breakpoint } = useDashboardStore.getState();
		expect(breakpoint.crossed).toBe(true);
		expect(breakpoint.timeSeconds).toBe(2);
		expect(breakpoint.p99Ms).toBe(310);
	});
});

describe("dashboard-store breakpoint atRunStart", () => {
	beforeEach(() => {
		useClientSettingsStore.setState({ sloThresholdMs: DEFAULT_SLO_THRESHOLD_MS });
		useDashboardStore.getState().startRun("r");
	});

	it("is set when the first reading the run holds is already over the SLO", () => {
		const s = useDashboardStore.getState();
		// A window between gates holds no reading, so it does not count as one.
		s.addMetricsBatch([{ ...tick(0.5, 900), live: true }, tick(1, 250)]);
		expect(useDashboardStore.getState().breakpoint).toMatchObject({
			crossed: true,
			atRunStart: true,
		});
	});

	it("is clear when an earlier tick in the same batch read under the SLO", () => {
		useDashboardStore.getState().addMetricsBatch([tick(1, 50), tick(2, 250)]);
		expect(useDashboardStore.getState().breakpoint.atRunStart).toBe(false);
	});

	it("is clear when an earlier batch read under the SLO", () => {
		const s = useDashboardStore.getState();
		s.addMetricsBatch([tick(1, 50)]);
		s.addMetricsBatch([tick(2, 250)]);
		expect(useDashboardStore.getState().breakpoint).toMatchObject({
			crossed: true,
			atRunStart: false,
		});
	});
});

describe("dashboard-store breakpoint SLO", () => {
	beforeEach(() => {
		useClientSettingsStore.setState({ sloThresholdMs: DEFAULT_SLO_THRESHOLD_MS });
	});

	it("judges a plain run against Settings and says so (#2939)", () => {
		useDashboardStore.getState().startRun("r", { mode: "ramp_up" });
		expect(useDashboardStore.getState().breakpoint.sloSource).toBe("settings");
		useDashboardStore.getState().addMetricsBatch([tick(1, 250)]);
		expect(useDashboardStore.getState().breakpoint).toMatchObject({
			crossed: true,
			sloMs: DEFAULT_SLO_THRESHOLD_MS,
			sloSource: "settings",
		});
	});

	it("keeps judging a ramp against Settings when it set a different p99 budget (#2939)", () => {
		useDashboardStore.getState().startRun("r", { mode: "ramp_up", latencyP99Ms: 350 });
		expect(useDashboardStore.getState().breakpoint).toMatchObject({
			sloMs: DEFAULT_SLO_THRESHOLD_MS,
			sloSource: "settings",
		});
	});

	it("marks the source run only where the p99 budget is the judged number (#2939)", () => {
		useDashboardStore
			.getState()
			.startRun("r", { mode: "ramp_up", latencyP99Ms: DEFAULT_SLO_THRESHOLD_MS });
		expect(useDashboardStore.getState().breakpoint.sloSource).toBe("run");
	});

	it("relabels the source when the config arrives after the ticks, keeping the verdict (#2939)", () => {
		const s = useDashboardStore.getState();
		s.startRun("r");
		s.addMetricsBatch([tick(1, 250)]);
		s.setRunConfig({ mode: "ramp_up", latencyP99Ms: DEFAULT_SLO_THRESHOLD_MS }, null);
		expect(useDashboardStore.getState().breakpoint).toMatchObject({
			crossed: true,
			timeSeconds: 1,
			sloSource: "run",
		});
	});

	it("a new run starts uncrossed against the SLO in force", () => {
		useClientSettingsStore.setState({ sloThresholdMs: 350 });
		useDashboardStore.getState().startRun("r");
		expect(useDashboardStore.getState().breakpoint.sloMs).toBe(350);
	});

	it("an uncrossed breakpoint follows the SLO as it changes mid-run", () => {
		const s = useDashboardStore.getState();
		s.startRun("r");
		useClientSettingsStore.setState({ sloThresholdMs: 500 });
		s.addMetricsBatch([tick(1, 300)]);
		const { breakpoint } = useDashboardStore.getState();
		expect(breakpoint.crossed).toBe(false);
		expect(breakpoint.sloMs).toBe(500);
	});

	it("a crossing keeps the SLO it crossed, whatever the setting becomes after", () => {
		const s = useDashboardStore.getState();
		s.startRun("r");
		s.addMetricsBatch([tick(1, 250)]);
		useClientSettingsStore.setState({ sloThresholdMs: 900 });
		s.addMetricsBatch([tick(2, 10)]);
		const { breakpoint } = useDashboardStore.getState();
		expect(breakpoint.crossed).toBe(true);
		expect(breakpoint.sloMs).toBe(200);
	});
});

describe("dashboard-store breakpoint SLO of a capacity run (issue #2816)", () => {
	beforeEach(() => {
		useClientSettingsStore.setState({ sloThresholdMs: DEFAULT_SLO_THRESHOLD_MS });
	});

	it("starts uncrossed against the run's own SLO, not the setting", () => {
		useDashboardStore.getState().startRun("r", { mode: "capacity", sloMs: 50 });
		expect(useDashboardStore.getState().breakpoint).toMatchObject({
			sloMs: 50,
			sloSource: "run",
		});
	});

	it("latches a 60 ms tick the 200 ms setting would have let through", () => {
		const s = useDashboardStore.getState();
		s.startRun("r", { mode: "capacity", sloMs: 50 });
		s.addMetricsBatch([tick(1, 10), tick(2, 60)]);
		expect(useDashboardStore.getState().breakpoint).toMatchObject({
			crossed: true,
			sloMs: 50,
			p99Ms: 60,
		});
	});

	it("does not follow the setting as it changes mid-run", () => {
		const s = useDashboardStore.getState();
		s.startRun("r", { mode: "capacity", sloMs: 50 });
		useClientSettingsStore.setState({ sloThresholdMs: 500 });
		s.addMetricsBatch([tick(1, 60)]);
		expect(useDashboardStore.getState().breakpoint).toMatchObject({ crossed: true, sloMs: 50 });
	});

	it("falls back to the setting for a capacity config that carries no SLO", () => {
		useDashboardStore.getState().startRun("r", { mode: "capacity" });
		expect(useDashboardStore.getState().breakpoint.sloMs).toBe(DEFAULT_SLO_THRESHOLD_MS);
	});

	it("ignores a stray sloMs in any other mode, where the setting still governs", () => {
		const s = useDashboardStore.getState();
		s.startRun("r", { mode: "ramp_up", sloMs: 50 });
		s.addMetricsBatch([tick(1, 60)]);
		expect(useDashboardStore.getState().breakpoint).toMatchObject({
			crossed: false,
			sloMs: DEFAULT_SLO_THRESHOLD_MS,
		});

		useClientSettingsStore.setState({ sloThresholdMs: 500 });
		s.addMetricsBatch([tick(2, 60)]);
		expect(useDashboardStore.getState().breakpoint.sloMs).toBe(500);
	});

	// A run an agent started streams ticks before its config is read from the row.
	describe("a config that arrives after the ticks (setRunConfig)", () => {
		it("re-judges the retained ticks against the run's own SLO", () => {
			const s = useDashboardStore.getState();
			s.startRun("r");
			s.addMetricsBatch([tick(1, 10), tick(2, 60)]);
			expect(useDashboardStore.getState().breakpoint.crossed).toBe(false);

			s.setRunConfig({ mode: "capacity", sloMs: 50 }, null);
			expect(useDashboardStore.getState().breakpoint).toMatchObject({
				crossed: true,
				sloMs: 50,
				timeSeconds: 2,
			});
		});

		it("moves an uncrossed breakpoint onto the run's SLO before the next tick", () => {
			const s = useDashboardStore.getState();
			s.startRun("r");
			s.setRunConfig({ mode: "capacity", sloMs: 50 }, null);
			expect(useDashboardStore.getState().breakpoint).toMatchObject({
				crossed: false,
				sloMs: 50,
			});
		});

		it("leaves a ramp run's latched crossing alone", () => {
			useClientSettingsStore.setState({ sloThresholdMs: 100 });
			const s = useDashboardStore.getState();
			s.startRun("r");
			s.addMetricsBatch([tick(1, 150)]);
			useClientSettingsStore.setState({ sloThresholdMs: 900 });
			s.setRunConfig({ mode: "ramp_up" }, null);
			expect(useDashboardStore.getState().breakpoint).toMatchObject({
				crossed: true,
				sloMs: 100,
			});
		});
	});
});

describe("dashboard-store run's own SLO (issue #2939)", () => {
	beforeEach(() => {
		useClientSettingsStore.setState({ sloThresholdMs: DEFAULT_SLO_THRESHOLD_MS });
	});

	it("is the p99 budget the run was started with", () => {
		useDashboardStore.getState().startRun("r", { mode: "constant_rps", latencyP99Ms: 120 });
		expect(runOwnSloMs(useDashboardStore.getState().loadTestConfig)).toBe(120);
	});

	it("is none for a run with no budget, whatever the setting is", () => {
		useClientSettingsStore.setState({ sloThresholdMs: 350 });
		useDashboardStore.getState().startRun("r", { mode: "constant_rps" });
		expect(runOwnSloMs(useDashboardStore.getState().loadTestConfig)).toBeUndefined();
		useDashboardStore.getState().startRun("r");
		expect(runOwnSloMs(useDashboardStore.getState().loadTestConfig)).toBeUndefined();
	});

	it("is a capacity run's sloMs ahead of its p99 budget", () => {
		expect(runOwnSloMs({ mode: "capacity", sloMs: 50, latencyP99Ms: 120 })).toBe(50);
		expect(runOwnSloMs({ mode: "capacity", latencyP99Ms: 120 })).toBe(120);
		// A stray sloMs outside capacity is no run's line.
		expect(runOwnSloMs({ mode: "ramp_up", sloMs: 50 })).toBeUndefined();
	});

	it("follows a config that arrives after the run started (setRunConfig)", () => {
		const s = useDashboardStore.getState();
		s.startRun("r");
		s.setRunConfig({ mode: "constant_rps", latencyP99Ms: 120 }, null);
		expect(runOwnSloMs(useDashboardStore.getState().loadTestConfig)).toBe(120);
	});

	// The judge is unchanged: a p99 budget draws a line, it does not move the
	// breakpoint, which a non-capacity run still judges against the setting.
	it("leaves a non-capacity breakpoint judged against the setting", () => {
		const s = useDashboardStore.getState();
		s.startRun("r", { mode: "ramp_up", latencyP99Ms: 120 });
		s.addMetricsBatch([tick(1, 150)]);
		expect(useDashboardStore.getState().breakpoint).toMatchObject({
			crossed: false,
			sloMs: DEFAULT_SLO_THRESHOLD_MS,
		});
	});
});

describe("dashboard-store monitor samples", () => {
	beforeEach(() => {
		useDashboardStore.getState().startRun("r");
	});

	it("starts empty, so a run without a monitor draws no vitals row", () => {
		expect(useDashboardStore.getState().monitorSamples).toEqual([]);
	});

	it("appends scrapes in arrival order", () => {
		const s = useDashboardStore.getState();
		s.addMonitorSamples([{ timestamp: 1000, series: { cpu: 1 } }]);
		s.addMonitorSamples([{ timestamp: 2000, series: { cpu: 2 } }]);

		expect(useDashboardStore.getState().monitorSamples.map((m) => m.timestamp)).toEqual([
			1000, 2000,
		]);
	});

	it("bounds the buffer by the retained-tick ceiling", () => {
		// A scrape can be configured faster than the tick cadence, so this array
		// needs its own cap - an overnight soak at 250ms would otherwise grow
		// without limit beside a series that is trimmed.
		const s = useDashboardStore.getState();
		s.setMaxRetainedTicks(5);
		s.addMonitorSamples(
			Array.from({ length: 12 }, (_, i) => ({ timestamp: i, series: { cpu: i } }))
		);

		const kept = useDashboardStore.getState().monitorSamples;
		expect(kept).toHaveLength(5);
		expect(kept[0].timestamp).toBe(7);
	});

	it("clears the samples when a new run starts", () => {
		const s = useDashboardStore.getState();
		s.addMonitorSamples([{ timestamp: 1000, series: { cpu: 1 } }]);
		useDashboardStore.getState().startRun("r2");
		expect(useDashboardStore.getState().monitorSamples).toEqual([]);
	});
});

/**
 * How far through a run one tick is, for the taskbar and Dock indicator
 * (#1362). Pure, and read by `LoadTestService` on every committed batch.
 */
describe("deriveRunProgress", () => {
	it("prefers the engine's own expected count", () => {
		const progress = deriveRunProgress(
			{ duration: "60s" },
			{ ...tick(30), requests_sent: 250, requests_expected: 1000 }
		);
		// Elapsed over duration would say 0.5 here; the engine's arithmetic wins.
		expect(progress).toBe(0.25);
	});

	it("falls back to elapsed over duration when no count is published", () => {
		expect(deriveRunProgress({ duration: "60s" }, tick(15))).toBe(0.25);
	});

	it("reads the units the engine accepts", () => {
		expect(deriveRunProgress({ duration: "2m" }, tick(30))).toBe(0.25);
		expect(deriveRunProgress({ duration: "1h" }, tick(900))).toBe(0.25);
		expect(deriveRunProgress({ duration: "60000ms" }, tick(15))).toBe(0.25);
		// A bare number is seconds, the way the engine reads a numeric duration.
		expect(deriveRunProgress({ duration: "60" }, tick(15))).toBe(0.25);
	});

	it("has no fraction for an open-ended run", () => {
		expect(deriveRunProgress({ targetRps: 100 }, tick(30))).toBeNull();
		expect(deriveRunProgress(null, tick(30))).toBeNull();
		expect(deriveRunProgress({ duration: "60s" }, null)).toBeNull();
		// An expected count of 0 is how the engine says "open-ended", not "done".
		expect(
			deriveRunProgress({}, { ...tick(30), requests_sent: 250, requests_expected: 0 })
		).toBeNull();
	});

	/*
	 * Every live tick of a `script.setup` carries elapsed 0 and nothing sent
	 * (#2395), and the strategy has not yet published its expected count.
	 */
	it("reads 0, not NaN, for a tick from before load started", () => {
		const setupTick = { ...tick(0), requests_sent: 0, requests_expected: 0 };
		expect(deriveRunProgress({ duration: "60s" }, setupTick)).toBe(0);
		expect(
			deriveRunProgress({ duration: "60s" }, { ...setupTick, requests_expected: 500 })
		).toBe(0);
	});

	it("refuses a duration it cannot read rather than guessing at one", () => {
		expect(deriveRunProgress({ duration: "soon" }, tick(30))).toBeNull();
		expect(deriveRunProgress({ duration: "0s" }, tick(30))).toBeNull();
	});

	/*
	 * A scenario iterations run publishes iterations x steps as an upper bound
	 * and settles requests_expected to the sent count at a natural end (#2914).
	 * Mutation check: have deriveRunProgress ignore the tick's own expected
	 * count and the settled final tick reads below 1, so the Dock never fills.
	 */
	it("reads below 1 under the live upper bound and 1 once the engine settles it", () => {
		const live = { ...tick(30), requests_sent: 10, requests_expected: 20 };
		expect(deriveRunProgress({}, live)).toBe(0.5);
		expect(deriveRunProgress({}, { ...live, requests_expected: 10 })).toBe(1);
	});

	/*
	 * Mutation check: drop the clamp and a run that overshoots its own expected
	 * count - the last window's requests land after the bound - reports a
	 * fraction above 1, which Electron reads as an indeterminate bar.
	 */
	it("stays inside 0..1 when a run overshoots", () => {
		expect(
			deriveRunProgress({}, { ...tick(30), requests_sent: 1100, requests_expected: 1000 })
		).toBe(1);
		expect(deriveRunProgress({ duration: "10s" }, tick(30))).toBe(1);
	});
});

/*
 * The engine answers `GET /runs/:id/report` for a run it is still executing,
 * so a report in hand is not a finished run (#1925). Taking one as final
 * painted Completed and removed Stop while the run kept generating load.
 *
 * Mutation check: drop the `isRunInProgress` guard in `setFinalReport` and the
 * first two cases redden - `mode` becomes "completed" and the report lands.
 * Map "failed" to "completed" again and the failed case reddens (#1932).
 */
describe("dashboard-store setFinalReport", () => {
	const reportWith = (status?: string) =>
		({
			summary: { totalRequests: 10 },
			latency: {},
			...(status === undefined ? {} : { metadata: { status } }),
		}) as unknown as RunReport;

	beforeEach(() => {
		useDashboardStore.getState().startRun("r");
		useDashboardStore.getState().setStreaming(false);
	});

	it.each(["running", "pending"])("leaves the store alone for a %s run", (status) => {
		useDashboardStore.getState().setFinalReport(reportWith(status));
		const s = useDashboardStore.getState();
		expect(s.mode).toBe("running");
		expect(s.finalReport).toBeNull();
	});

	it("finalises a completed run", () => {
		const report = reportWith("completed");
		useDashboardStore.getState().setFinalReport(report);
		expect(useDashboardStore.getState().mode).toBe("completed");
		expect(useDashboardStore.getState().finalReport).toBe(report);
	});

	it("finalises a stopped run as stopped", () => {
		useDashboardStore.getState().setFinalReport(reportWith("stopped"));
		expect(useDashboardStore.getState().mode).toBe("stopped");
	});

	it("finalises a failed run as failed, not completed (#1932)", () => {
		useDashboardStore.getState().setFinalReport(reportWith("failed"));
		expect(useDashboardStore.getState().mode).toBe("failed");
		expect(useDashboardStore.getState().isStreaming).toBe(false);
	});

	it("keeps a stop the user asked for as stopped, even if the report says failed", () => {
		useDashboardStore.getState().stopRun();
		useDashboardStore.getState().setFinalReport(reportWith("failed"));
		expect(useDashboardStore.getState().mode).toBe("stopped");
	});

	it("takes a report with no status as final", () => {
		useDashboardStore.getState().setFinalReport(reportWith());
		expect(useDashboardStore.getState().mode).toBe("completed");
	});
});

describe("dashboard-store stopRun", () => {
	it("clears a stream error, so the stopped run's report is not held off", () => {
		useDashboardStore.getState().startRun("r");
		useDashboardStore.getState().setError("The connection closed.");
		useDashboardStore.getState().stopRun();
		const s = useDashboardStore.getState();
		expect(s.mode).toBe("stopped");
		expect(s.error).toBeNull();
	});
});

describe("dashboard-store setRunConfig", () => {
	it("fills in config and request without restarting the run (#1935)", () => {
		const s = useDashboardStore.getState();
		s.startRun("r");
		s.addMetricsBatch([tick(1), tick(2)]);
		s.setRunConfig(
			{ mode: "ramp_up", duration: "30m" },
			{ method: "GET", url: "https://x.test" }
		);

		const after = useDashboardStore.getState();
		expect(after.loadTestConfig).toEqual({ mode: "ramp_up", duration: "30m" });
		expect(after.requestInfo).toEqual({ method: "GET", url: "https://x.test" });
		expect(after.currentRunId).toBe("r");
		expect(after.mode).toBe("running");
		expect(after.isStreaming).toBe(true);
		expect(after.historicalMetrics).toHaveLength(2);
		expect(after.currentMetrics?.elapsed_seconds).toBe(2);
	});

	it("keeps the request it already has when the row names none", () => {
		const s = useDashboardStore.getState();
		s.startRun("r", undefined, { method: "GET", url: "https://x.test" });
		s.setRunConfig({ mode: "iterations" }, null);
		expect(useDashboardStore.getState().requestInfo).toEqual({
			method: "GET",
			url: "https://x.test",
		});
	});
});

describe("dashboard-store p99 at peak", () => {
	beforeEach(() => {
		useClientSettingsStore.setState({ sloThresholdMs: DEFAULT_SLO_THRESHOLD_MS });
		useDashboardStore.getState().startRun("r");
	});

	const at = (elapsed: number, vu: number, p99: number): LoadTestMetrics => ({
		...tick(elapsed, p99),
		current_concurrency: vu,
	});

	it("latches the peak-load reading, not the breakpoint tick's", () => {
		const s = useDashboardStore.getState();
		// Crosses the SLO at 19 virtual users (203 ms), then keeps climbing to 30.
		s.addMetricsBatch([at(1, 10, 60), at(2, 19, 203), at(3, 30, 292)]);
		const state = useDashboardStore.getState();
		expect(state.breakpoint.p99Ms).toBe(203);
		expect(state.p99AtPeakMs).toBe(292);
	});

	it("restarts when the peak rises, across batches", () => {
		const s = useDashboardStore.getState();
		s.addMetricsBatch([at(1, 10, 500)]);
		expect(useDashboardStore.getState().p99AtPeakMs).toBe(500);
		s.addMetricsBatch([at(2, 20, 100)]);
		expect(useDashboardStore.getState().p99AtPeakMs).toBe(100);
		s.addMetricsBatch([at(3, 20, 140), at(4, 15, 900)]);
		expect(useDashboardStore.getState().p99AtPeakMs).toBe(140);
	});

	it("stays undefined while no tick at the peak has a whole-second p99", () => {
		const s = useDashboardStore.getState();
		s.addMetricsBatch([{ ...at(0.5, 30, 900), live: true }]);
		expect(useDashboardStore.getState().peakConcurrency).toBe(30);
		expect(useDashboardStore.getState().p99AtPeakMs).toBeUndefined();
	});

	it("survives the peak tick rolling out of the retention window", () => {
		const s = useDashboardStore.getState();
		s.setLiveWindowSeconds(60);
		s.addMetricsBatch([at(5, 30, 292)]);
		s.addMetricsBatch(Array.from({ length: 13 }, (_, i) => at(70 + i * 5, 12, 40)));
		const state = useDashboardStore.getState();
		expect(state.historicalMetrics.some((m) => m.elapsed_seconds === 5)).toBe(false);
		expect(state.p99AtPeakMs).toBe(292);
	});

	it("startRun clears it for the next run", () => {
		const s = useDashboardStore.getState();
		s.addMetricsBatch([at(1, 30, 292)]);
		s.startRun("next");
		expect(useDashboardStore.getState().p99AtPeakMs).toBeUndefined();
		s.addMetricsBatch([at(1, 5, 20)]);
		expect(useDashboardStore.getState().p99AtPeakMs).toBe(20);
	});
});

describe("dashboard-store dispatch lag streak", () => {
	beforeEach(() => {
		useDashboardStore.getState().startRun("r");
	});

	const windowed = (elapsed: number, sendRate: number, rps: number): LoadTestMetrics => ({
		...tick(elapsed),
		current_send_rate: sendRate,
		current_rps: rps,
	});

	it("latches the tick the windowed gap opened at, across batches", () => {
		const s = useDashboardStore.getState();
		s.addMetricsBatch([windowed(1, 100, 100), windowed(2, 100, 60)]);
		expect(useDashboardStore.getState().dispatchLagSinceSeconds).toBe(2);
		s.addMetricsBatch([windowed(3, 100, 55), windowed(4, 100, 60)]);
		expect(useDashboardStore.getState().dispatchLagSinceSeconds).toBe(2);
	});

	it("resets when the rates agree again, so the next gap starts a new streak", () => {
		const s = useDashboardStore.getState();
		s.addMetricsBatch([windowed(2, 100, 60), windowed(3, 100, 100)]);
		expect(useDashboardStore.getState().dispatchLagSinceSeconds).toBeNull();
		s.addMetricsBatch([windowed(4, 100, 60)]);
		expect(useDashboardStore.getState().dispatchLagSinceSeconds).toBe(4);
	});

	it("survives the tick it began on rolling out of the retention window", () => {
		const s = useDashboardStore.getState();
		s.setLiveWindowSeconds(60);
		s.addMetricsBatch([windowed(5, 100, 60)]);
		s.addMetricsBatch(Array.from({ length: 13 }, (_, i) => windowed(70 + i * 5, 100, 60)));
		const state = useDashboardStore.getState();
		expect(state.historicalMetrics.some((m) => m.elapsed_seconds === 5)).toBe(false);
		expect(state.dispatchLagSinceSeconds).toBe(5);
	});

	it("startRun clears it for the next run", () => {
		const s = useDashboardStore.getState();
		s.addMetricsBatch([windowed(2, 100, 60)]);
		s.startRun("next");
		expect(useDashboardStore.getState().dispatchLagSinceSeconds).toBeNull();
	});
});
