import { describe, it, expect } from "vitest";
import type { RunReport } from "@/types";
import { reportToDerived } from "./reportToDerived";

function baseReport(overrides: Partial<RunReport> = {}): RunReport {
	return {
		metadata: {
			runId: "r1",
			runType: "load",
			status: "completed",
			startTime: 0,
			endTime: 1000,
			requestUrl: "http://x",
			requestMethod: "GET",
			configuration: { mode: "constant_rps", duration: "3s", targetRps: 200 },
		},
		summary: {
			totalRequests: 600,
			successfulRequests: 600,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: 3,
			avgRps: 195,
			throughput: 190,
			sendRate: 198,
			testDuration: 3,
			setupOverhead: 0.03,
			peakConcurrency: 20,
			droppedRequests: 0,
			avgQueueWaitMs: 1.0,
			bytesSent: 1000,
			bytesReceived: 2000,
			throughputBytesPerSec: 666,
		},
		latency: {
			min: 100,
			max: 130,
			avg: 101,
			p50: 101,
			p90: 102,
			p95: 103,
			p99: 108,
			p999: 120,
		},
		statusCodes: { "200": 600 },
		errors: { total: 0, withDetails: 0, types: {} },
		rateControl: { targetRps: 200, actualRps: 195, achievement: 97.5 },
		...overrides,
	};
}

describe("reportToDerived", () => {
	it("carries the report's HTTP errors / No response split (issue #2124)", () => {
		const base = baseReport();
		const d = reportToDerived(
			baseReport({
				summary: {
					...base.summary,
					totalRequests: 100,
					failedRequests: 17,
					httpErrorRequests: 15,
					noResponseRequests: 2,
					errorRate: 17,
				},
			})
		);
		expect(d.failedRequests).toBe(17);
		expect(d.httpErrors).toBe(15);
		expect(d.noResponse).toBe(2);
	});

	it("reads a report without the split as all HTTP errors", () => {
		const base = baseReport();
		const d = reportToDerived(
			baseReport({ summary: { ...base.summary, failedRequests: 4, errorRate: 0.7 } })
		);
		expect(d.httpErrors).toBe(4);
		expect(d.noResponse).toBe(0);
	});

	it("maps a constant_rps report to a completed DashboardDerived", () => {
		const d = reportToDerived(baseReport());
		expect(d.mode).toBe("constant_rps");
		expect(d.isCompleted).toBe(true);
		expect(d.p99Latency).toBe(108);
		expect(d.medianLatency).toBe(101);
		expect(d.throughput).toBe(190);
		expect(d.peakConcurrency).toBe(20);
		expect(d.currentConcurrency).toBe(20); // completed → peak fallback
		expect(d.targetRps).toBe(200);
		expect(d.actualRps).toBe(195);
		expect(d.avgQueueWaitMs).toBe(1.0);
		expect(d.statusCodes).toEqual({ "200": 600 });
		expect(d.showDropped).toBe(false); // rate-limited but zero drops → Rate Fidelity card
		expect(d.breakpoint.crossed).toBe(false);
		expect(d.breakpoint.sloMs).toBeNull(); // a report holds no per-tick series, so no SLO was judged
	});

	describe("rate fidelity (#2392)", () => {
		// Completions over the whole wall time (drain included) read 195 here; the
		// generator sent every request it owed, over the sending window.
		const sentAll: RunReport["rateControl"] = {
			targetRps: 200,
			actualRps: 200,
			achievement: 100,
			requestsSent: 600,
			requestsExpected: 600,
		};

		it("takes the rate and the percentage from the sending window's figures", () => {
			const d = reportToDerived(baseReport({ rateControl: sentAll }));

			expect(d.actualRps).toBe(200);
			expect(d.rateAchievementPct).toBe(100);
			// The completions-over-wall-time figures stay what they were.
			expect(d.throughput).toBe(190);
		});

		it("keeps a report stored before the counts on its stored rate and percentage", () => {
			const d = reportToDerived(
				baseReport({ rateControl: { targetRps: 200, actualRps: 192, achievement: 96 } })
			);

			expect(d.actualRps).toBe(192);
			expect(d.rateAchievementPct).toBe(96);
		});

		it("falls back to average rps over the target for a report with no rateControl", () => {
			const d = reportToDerived(baseReport({ rateControl: undefined }));

			expect(d.targetRps).toBe(200);
			expect(d.actualRps).toBe(195);
			expect(d.rateAchievementPct).toBeCloseTo(97.5);
		});

		it("has no percentage when there is no target to be a share of", () => {
			const d = reportToDerived(
				baseReport({
					rateControl: undefined,
					metadata: {
						runId: "r4",
						runType: "load",
						status: "completed",
						startTime: 0,
						endTime: 1,
						configuration: { mode: "constant_concurrency", concurrency: 10 },
					},
				})
			);

			expect(d.rateAchievementPct).toBeUndefined();
		});
	});

	it("shows the dropped card only when a rate-limited run actually dropped requests", () => {
		expect(reportToDerived(baseReport()).showDropped).toBe(false); // 0 drops
		const withDrops = baseReport({
			summary: { ...baseReport().summary, droppedRequests: 12 },
		});
		expect(reportToDerived(withDrops).showDropped).toBe(true);
	});

	it("parses ramp config + does not mark dropped for ramp_up", () => {
		const d = reportToDerived(
			baseReport({
				metadata: {
					runId: "r2",
					runType: "load",
					status: "completed",
					startTime: 0,
					endTime: 1,
					configuration: {
						mode: "ramp_up",
						duration: "5s",
						concurrency: 50,
						startConcurrency: 1,
						rampUpDuration: "3s",
					},
				},
			})
		);
		expect(d.mode).toBe("ramp_up");
		expect(d.targetConcurrency).toBe(50);
		expect(d.startConcurrency).toBe(1);
		expect(d.rampUpDurationSeconds).toBe(3);
		expect(d.showDropped).toBe(false);
	});

	it("reads a ramp duration's unit and drops one that is not a duration (#1945)", () => {
		const rampOf = (rampUpDuration: string) =>
			reportToDerived(
				baseReport({
					metadata: {
						runId: "r3",
						runType: "load",
						status: "completed",
						startTime: 0,
						endTime: 1,
						configuration: { mode: "ramp_up", concurrency: 50, rampUpDuration },
					},
				})
			).rampUpDurationSeconds;

		expect(rampOf("2m")).toBe(120);
		expect(rampOf("soon")).toBeUndefined();
	});

	it("defaults missing optional fields without producing NaN-prone undefineds", () => {
		const d = reportToDerived(
			baseReport({
				summary: {
					totalRequests: 10,
					successfulRequests: 10,
					failedRequests: 0,
					errorRate: 0,
					totalDurationSeconds: 1,
					avgRps: 10,
				},
			})
		);
		expect(d.peakConcurrency).toBe(0);
		expect(d.avgQueueWaitMs).toBe(0);
		expect(d.droppedRequests).toBe(0);
		expect(d.backpressure).toBe(0);
	});
});
