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
			cleanupOverhead: 0.02,
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
	// Mutation checked: restoring `notCrossed(null)` fails the first case.
	describe("breakpoint SLO (#2816)", () => {
		const capacity = {
			sloMs: 50,
			stopReason: "slo_exceeded",
			levels: [],
		};

		it("names a capacity run's own SLO", () => {
			const d = reportToDerived(baseReport({ capacity }));
			expect(d.breakpoint).toMatchObject({ crossed: false, sloMs: 50 });
		});

		it("names none for a report with no capacity block", () => {
			expect(reportToDerived(baseReport()).breakpoint.sloMs).toBeNull();
		});
	});

	// Mutation checked: dropping `capacity` from the return fails the first case.
	describe("the search's result (#2816)", () => {
		it("carries a capacity run's stop reason to the Saturation card", () => {
			const capacity = { sloMs: 50, stopReason: "plateau", levels: [] };
			expect(reportToDerived(baseReport({ capacity })).capacity).toBe(capacity);
		});

		it("carries none for a report with no capacity block", () => {
			expect(reportToDerived(baseReport()).capacity).toBeUndefined();
		});
	});

	describe("setup and cleanup overhead (#2894)", () => {
		// Mutation checked: dropping `cleanupOverhead` from the return, or reading
		// it from `s.setupOverhead`, fails the first case; defaulting setup to 0
		// fails the second.
		it("passes both keys through under their own names", () => {
			const d = reportToDerived(baseReport());
			expect(d.setupOverhead).toBe(0.03);
			expect(d.cleanupOverhead).toBe(0.02);
		});

		it("leaves setup undefined for a run stored before it was measured", () => {
			const base = baseReport();
			const d = reportToDerived(
				baseReport({
					summary: { ...base.summary, setupOverhead: undefined, cleanupOverhead: 0.4 },
				})
			);
			expect(d.setupOverhead).toBeUndefined();
			expect(d.cleanupOverhead).toBe(0.4);
		});
	});

	describe("dispatch chip on a report without completedWhileSending (whole-run pair)", () => {
		const withRates = (sendRate?: number, throughput?: number) => {
			const base = baseReport();
			return reportToDerived(
				baseReport({ summary: { ...base.summary, sendRate, throughput } })
			).dispatchStatus;
		};

		it("reads kept-pace when the rates are within the tolerance", () => {
			expect(withRates(198, 190)).toBe("kept-pace");
		});

		it("reads lagging at once for a gap past it, since a finished run has nothing left to settle", () => {
			expect(withRates(4500, 3940)).toBe("lagging");
		});

		it("draws no chip when the report lacks a rate", () => {
			expect(withRates(undefined, 190)).toBeUndefined();
			expect(withRates(198, undefined)).toBeUndefined();
		});
	});

	describe("received rate on the sending window (#2882)", () => {
		// 600 sent over 3 s sending (sendRate 200); 590 had come back by the time
		// sending stopped, while the whole-run `throughput` (190) is diluted by the drain.
		const withWindow = (
			summary: Partial<RunReport["summary"]> & { completedWhileSending?: number }
		) => {
			const base = baseReport();
			return reportToDerived(
				baseReport({
					summary: { ...base.summary, sendRate: 200, throughput: 190, ...summary },
				})
			);
		};

		it("prints completedWhileSending over the sending window and says so", () => {
			const d = withWindow({ completedWhileSending: 590, sendingDurationSeconds: 2.95 });
			expect(d.receivedRate).toBeCloseTo(200, 5);
			expect(d.receivedWindow).toBe("sending");
		});

		it("judges the chip on the rate it prints, not on throughput", () => {
			// 400/2 = 200 req/s beside sendRate 200 is kept-pace; the whole-run 190
			// would sit 10 below, and 100 would read lagging.
			const kept = withWindow({
				completedWhileSending: 400,
				sendingDurationSeconds: 2,
				throughput: 100,
			});
			expect(kept.receivedRate).toBe(200);
			expect(kept.dispatchStatus).toBe("kept-pace");

			// The reverse: a healthy whole-run throughput cannot rescue a lagging window.
			const lagging = withWindow({
				completedWhileSending: 200,
				sendingDurationSeconds: 2,
				throughput: 200,
			});
			expect(lagging.receivedRate).toBe(100);
			expect(lagging.dispatchStatus).toBe("lagging");
		});

		it("uses a measured 0 instead of reading it as absent", () => {
			const d = withWindow({ completedWhileSending: 0, sendingDurationSeconds: 2 });
			expect(d.receivedRate).toBe(0);
			expect(d.receivedWindow).toBe("sending");
			expect(d.dispatchStatus).toBe("lagging");
		});

		it("falls back to the whole-run throughput without the count", () => {
			const d = withWindow({ sendingDurationSeconds: 2 });
			expect(d.receivedRate).toBe(190);
			expect(d.receivedWindow).toBe("wholeRun");
		});

		it.each([
			["0", 0],
			["absent", undefined],
			["negative", -1],
			["not finite", Number.POSITIVE_INFINITY],
			["not a number", Number.NaN],
		])("falls back to the whole-run throughput when the window is %s", (_name, window) => {
			const d = withWindow({ completedWhileSending: 590, sendingDurationSeconds: window });
			expect(d.receivedRate).toBe(190);
			expect(d.receivedWindow).toBe("wholeRun");
		});

		it("leaves throughput whole-run for the cards that read it", () => {
			const d = withWindow({ completedWhileSending: 400, sendingDurationSeconds: 2 });
			expect(d.throughput).toBe(190);
		});
	});

	describe("mean requests in flight (#2821)", () => {
		const withAvgInFlight = (avgInFlight?: number) => {
			const base = baseReport();
			return reportToDerived(baseReport({ summary: { ...base.summary, avgInFlight } }));
		};

		it("carries the report's mean beside the peak, which stays the peak", () => {
			const d = withAvgInFlight(4.2);
			expect(d.avgInFlight).toBe(4.2);
			expect(d.peakConcurrency).toBe(20);
		});

		it("keeps a measured 0 a 0", () => {
			expect(withAvgInFlight(0).avgInFlight).toBe(0);
		});

		it("leaves it absent for a report stored before the mean existed, so the card falls back to the peak", () => {
			expect(withAvgInFlight(undefined).avgInFlight).toBeUndefined();
		});
	});

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

	describe("a stopped run's rate fidelity (#2805)", () => {
		// Stopped at the halfway mark of a 60 s plan: it sent every request it owed
		// for the 30 s it was sending, which is 50% of the plan.
		function stoppedReport(over: {
			status?: "stopped" | "completed";
			duration?: string;
			targetRps?: number;
			rateControl?: RunReport["rateControl"];
			sendingDurationSeconds?: number;
		}): RunReport {
			const base = baseReport();
			const hasTarget = !("targetRps" in over) || over.targetRps !== undefined;
			return baseReport({
				metadata: {
					runId: "r5",
					runType: "load",
					startTime: 0,
					endTime: 1000,
					status: over.status ?? "stopped",
					configuration: {
						mode: "constant_rps",
						duration: "duration" in over ? over.duration : "60s",
						...(hasTarget ? { targetRps: over.targetRps ?? 50 } : {}),
					},
				},
				summary: {
					...base.summary,
					sendingDurationSeconds:
						"sendingDurationSeconds" in over ? over.sendingDurationSeconds : 30.075,
				},
				rateControl:
					"rateControl" in over
						? over.rateControl
						: {
								targetRps: 50,
								actualRps: 49.9,
								achievement: 50.067,
								requestsSent: 1502,
								requestsExpected: 3000,
							},
			});
		}

		it("judges the run by pace and states the plan share beside it", () => {
			const d = reportToDerived(stoppedReport({}));

			expect(d.rateAchievementPct).toBeCloseTo(99.88, 1);
			expect(d.stoppedAt).toEqual({ planSharePct: 50.067, plannedSeconds: 60 });
		});

		it("keeps a completed run on the plan share, with no stopped line", () => {
			const d = reportToDerived(stoppedReport({ status: "completed" }));

			expect(d.rateAchievementPct).toBe(50.067);
			expect(d.stoppedAt).toBeUndefined();
		});

		it("keeps the stored achievement when the run has no target to pace against", () => {
			const d = reportToDerived(
				stoppedReport({
					targetRps: undefined,
					rateControl: {
						targetRps: 0,
						actualRps: 49.9,
						achievement: 50.067,
						requestsSent: 1502,
						requestsExpected: 3000,
					},
				})
			);

			expect(d.rateAchievementPct).toBe(50.067);
			expect(d.stoppedAt).toBeUndefined();
		});

		it("keeps the stored achievement for a report stored without the counts or the window", () => {
			const noCounts = reportToDerived(
				stoppedReport({
					rateControl: { targetRps: 50, actualRps: 49.9, achievement: 50.067 },
				})
			);
			const noWindow = reportToDerived(stoppedReport({ sendingDurationSeconds: undefined }));

			for (const d of [noCounts, noWindow]) {
				expect(d.rateAchievementPct).toBe(50.067);
				expect(d.stoppedAt).toBeUndefined();
			}
		});

		it("judges by pace but draws no plan line when the duration is not a plan", () => {
			const d = reportToDerived(stoppedReport({ duration: undefined }));

			expect(d.rateAchievementPct).toBeCloseTo(99.88, 1);
			expect(d.stoppedAt).toBeUndefined();
		});
	});

	it("shows the dropped card only when a rate-limited run actually dropped requests", () => {
		expect(reportToDerived(baseReport()).showDropped).toBe(false); // 0 drops
		const withDrops = baseReport({
			summary: { ...baseReport().summary, droppedRequests: 12 },
		});
		expect(reportToDerived(withDrops).showDropped).toBe(true);
	});

	describe("skipped requests (#2911)", () => {
		const withSummary = (extra: Partial<RunReport["summary"]>, mode = "constant_rps") =>
			baseReport({
				metadata: {
					...baseReport().metadata!,
					configuration: { ...baseReport().metadata!.configuration, mode },
				},
				summary: { ...baseReport().summary, ...extra },
			});

		// Mutation checked: dropping `skippedRequests` from reportToDerived's gate
		// or return fails the first two cases.
		it("shows the card for a rate-limited run that only skipped", () => {
			const d = reportToDerived(withSummary({ skippedRequests: 30, stalledMs: 150 }));

			expect(d.showDropped).toBe(true);
			expect(d.droppedRequests).toBe(0);
			expect(d.skippedRequests).toBe(30);
			expect(d.stalledMs).toBe(150);
		});

		it("keeps both counts when the run dropped and skipped", () => {
			const d = reportToDerived(withSummary({ droppedRequests: 4, skippedRequests: 30 }));

			expect(d.showDropped).toBe(true);
			expect(d.droppedRequests).toBe(4);
			expect(d.skippedRequests).toBe(30);
		});

		it("does not show the card for skips on a mode that is not rate limited", () => {
			const d = reportToDerived(withSummary({ skippedRequests: 30 }, "constant_concurrency"));

			expect(d.showDropped).toBe(false);
			expect(d.skippedRequests).toBe(30);
		});

		it("reads a report without the fields as none skipped", () => {
			const d = reportToDerived(baseReport());

			expect(d.showDropped).toBe(false);
			expect(d.skippedRequests).toBe(0);
			expect(d.stalledMs).toBe(0);
		});
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
