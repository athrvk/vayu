/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { buildLoadTestConfig, SCRIPTS_DEFAULT, type LoadTestDraft } from "./buildLoadTestConfig";
import { emptyBudgetDraft } from "./budgets";
import { emptyMonitorDraft } from "./monitor";

const DRAFT: LoadTestDraft = {
	profile: {
		mode: "constant_concurrency",
		duration: 30,
		rps: 100,
		concurrency: 10,
		iterations: 500,
		rampDuration: 10,
		startConcurrency: 2,
		stepDuration: 5,
		sloMs: 250,
		streamDuration: 20,
		streamMaxEvents: 1000,
	},
	sampleRate: 100,
	slowThreshold: 1000,
	saveTimingBreakdown: false,
	maxInFlight: null,
	budgets: emptyBudgetDraft(),
	customBudgets: [],
	failRun: false,
	monitor: emptyMonitorDraft(),
	comment: "",
	scriptsOverride: SCRIPTS_DEFAULT,
	dataFile: null,
	isStreamingRequest: false,
};

const build = (overrides: Partial<LoadTestDraft> = {}) =>
	buildLoadTestConfig({ ...DRAFT, ...overrides });

const withMode = (mode: LoadTestDraft["profile"]["mode"]) => ({
	profile: { ...DRAFT.profile, mode },
});

describe("buildLoadTestConfig", () => {
	it("sends only the fields the chosen mode uses", () => {
		expect(build(withMode("constant_rps"))).toMatchObject({ mode: "constant_rps", rps: 100 });
		expect(build(withMode("constant_rps"))).not.toHaveProperty("concurrency");
		expect(build(withMode("ramp_up"))).toMatchObject({
			concurrency: 10,
			ramp_duration_seconds: 10,
			start_concurrency: 2,
		});
		expect(build(withMode("capacity"))).toMatchObject({
			concurrency: 10,
			start_concurrency: 2,
			slo_ms: 250,
			step_duration_seconds: 5,
		});
		expect(build(withMode("iterations"))).toMatchObject({ iterations: 500, concurrency: 10 });
	});

	it("leaves the duration out of an iterations run and keeps it elsewhere", () => {
		expect(build(withMode("iterations"))).not.toHaveProperty("duration_seconds");
		expect(build(withMode("ramp_up"))).toMatchObject({ duration_seconds: 30 });
	});

	it("caps in-flight requests only for a positive value on a constant-rate run", () => {
		const rps = withMode("constant_rps");
		expect(build({ ...rps, maxInFlight: 50 })).toMatchObject({ max_in_flight: 50 });
		expect(build({ ...rps, maxInFlight: 0 })).not.toHaveProperty("max_in_flight");
		expect(build({ ...rps, maxInFlight: null })).not.toHaveProperty("max_in_flight");
		expect(build({ maxInFlight: 50 })).not.toHaveProperty("max_in_flight");
	});

	it("sends the stream caps only for a streaming request", () => {
		expect(build({ isStreamingRequest: true })).toMatchObject({
			stream_duration_seconds: 20,
			stream_max_events: 1000,
		});
		expect(build({ isStreamingRequest: false })).not.toHaveProperty("stream_duration_seconds");
	});

	it("sends the scripts override only when it moves off the default", () => {
		expect(build({ scriptsOverride: "allInline" })).toMatchObject({
			elements: { scripts: "allInline" },
		});
		expect(build({ scriptsOverride: SCRIPTS_DEFAULT })).not.toHaveProperty("elements");
	});

	it("turns a blank comment into an absent one", () => {
		expect(build({ comment: "" }).comment).toBeUndefined();
		expect(build({ comment: "after the cache change" }).comment).toBe("after the cache change");
	});

	describe("carried budgets (issue #2195)", () => {
		const budgets = { ...emptyBudgetDraft(), latencyP99Ms: "200", maxErrorRatePct: "1" };
		const customBudgets = [{ id: "c1", name: "cart", stat: "p95" as const, value: "5" }];

		it("passes the carried keys through beside the thresholds they name", () => {
			const config = build({
				budgets,
				customBudgets,
				carriedBudgets: ["latencyP99Ms", "custom.cart.p95"],
			});
			expect(config.carriedBudgets).toEqual(["latencyP99Ms", "custom.cart.p95"]);
			expect(config.thresholds).toMatchObject({ latencyP99Ms: 200, "custom.cart.p95": 5 });
		});

		it("is absent, not empty, when nothing was carried", () => {
			expect(build({ budgets })).not.toHaveProperty("carriedBudgets");
			expect(build({ budgets, carriedBudgets: [] })).not.toHaveProperty("carriedBudgets");
		});

		it("names only keys the payload actually judges", () => {
			// Mutation check: skipping the filter sends "maxErrorRatePct" and
			// "custom.gone.p95", which the thresholds below do not hold.
			const config = build({
				budgets: { ...emptyBudgetDraft(), latencyP99Ms: "200" },
				carriedBudgets: ["latencyP99Ms", "maxErrorRatePct", "custom.gone.p95"],
			});
			expect(config.carriedBudgets).toEqual(["latencyP99Ms"]);
		});

		it("is absent when no budget is declared at all", () => {
			const config = build({ carriedBudgets: ["latencyP99Ms"] });
			expect(config.thresholds).toBeUndefined();
			expect(config).not.toHaveProperty("carriedBudgets");
		});
	});
});
