/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { firstBlockingError, validateLoadTestDraft, type DraftErrors } from "./validation";
import { emptyBudgetDraft } from "./budgets";
import { emptyMonitorDraft } from "./monitor";
import type { LoadTestProfile } from "./useSavedLoadTestConfig";
import type { ResolvedElement } from "@/types";
import {
	DEFAULT_LOAD_TEST_CEILINGS,
	LOAD_TEST_LIMITS,
	resolveLoadTestLimits,
} from "@/constants/load-test";

const PROFILE: LoadTestProfile = {
	mode: "ramp_up",
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
};

const validate = (
	profile: Partial<LoadTestProfile> = {},
	monitorUrl = "",
	scenarioOnly: ResolvedElement[] = []
) =>
	validateLoadTestDraft({
		profile: { ...PROFILE, ...profile },
		budgets: emptyBudgetDraft(),
		customBudgets: [],
		monitor: { ...emptyMonitorDraft(), url: monitorUrl },
		maxSeries: 10,
		scenarioOnly,
		isStreamingRequest: false,
		limits: LOAD_TEST_LIMITS,
		slowThreshold: 1000,
		maxInFlight: "",
	});

const validateStreamBudget = (isStreamingRequest: boolean) =>
	validateLoadTestDraft({
		profile: PROFILE,
		budgets: { ...emptyBudgetDraft(), streamEventsPerSecondMin: "0" },
		customBudgets: [],
		monitor: emptyMonitorDraft(),
		maxSeries: 10,
		scenarioOnly: [],
		isStreamingRequest,
		limits: LOAD_TEST_LIMITS,
		slowThreshold: 1000,
		maxInFlight: "",
	});

const NONE: DraftErrors = {
	rampDurationError: null,
	startFloorError: null,
	startConcurrencyError: null,
	capacityRangeError: null,
	profileRangeError: null,
	budgetsError: null,
	monitoringError: null,
	scenarioOnlyError: null,
};

describe("validateLoadTestDraft", () => {
	it("checks a stream budget only for a request that streams (#3234)", () => {
		expect(validateStreamBudget(true).budgetsError).toMatch(/events per second/i);
		// Not shown and not sent, so a value left in the memo is nobody's mistake.
		expect(validateStreamBudget(false).budgetsError).toBeNull();
	});

	it("passes a valid draft", () => {
		expect(validate()).toEqual(NONE);
	});

	it("reads the ramp rules from the profile", () => {
		expect(validate({ rampDuration: 60 }).rampDurationError).not.toBeNull();
		expect(validate({ startConcurrency: 50 }).startConcurrencyError).not.toBeNull();
	});

	it("reads the monitoring rule from the monitor draft", () => {
		// A URL with no metric names is the incomplete block the rule refuses.
		expect(validate({}, "http://localhost:9100/metrics").monitoringError).not.toBeNull();
	});

	it("reads the scenario-only rule from the resolved elements (#3050)", () => {
		const pacing: ResolvedElement = {
			id: "p1",
			kind: "timer.pacing",
			enabled: true,
			config: {},
			origin: { kind: "request", scope: "request", id: "req_1" },
		};
		expect(validate({}, "", [pacing]).scenarioOnlyError).toContain("timer.pacing");
		expect(validate({}, "", []).scenarioOnlyError).toBeNull();
	});
});

/**
 * A number input's `min` and `max` are advisory, so a typed value reaches the
 * draft whatever the range says; these are the rule that stops Start (#3542).
 */
describe("ceilings from Settings", () => {
	interface Extras {
		slowThreshold?: number;
		maxInFlight?: string;
		isStreamingRequest?: boolean;
	}
	const check = (
		profile: Partial<LoadTestProfile>,
		ceilings: Partial<typeof DEFAULT_LOAD_TEST_CEILINGS> = {},
		{ slowThreshold = 1000, maxInFlight = "", isStreamingRequest = false }: Extras = {}
	) =>
		validateLoadTestDraft({
			profile: { ...PROFILE, ...profile },
			budgets: emptyBudgetDraft(),
			customBudgets: [],
			monitor: emptyMonitorDraft(),
			maxSeries: 10,
			scenarioOnly: [],
			isStreamingRequest,
			limits: resolveLoadTestLimits({ ...DEFAULT_LOAD_TEST_CEILINGS, ...ceilings }),
			slowThreshold,
			maxInFlight,
		}).profileRangeError;

	it("refuses a value above the ceiling, naming the field, the range and Settings", () => {
		expect(check({ mode: "constant_rps", duration: 100_000 })).toBe(
			"Duration must be a number from 1 to 3,600, the ceiling set in Settings."
		);
		expect(check({ mode: "constant_rps", rps: 900_000 })).toBe(
			"Target rate must be a number from 1 to 50,000, the ceiling set in Settings."
		);
	});

	it("reads a ceiling the user raised or lowered, not the shipped one", () => {
		expect(check({ mode: "constant_rps", rps: 900_000 }, { rps: 1_000_000 })).toBeNull();
		expect(check({ mode: "constant_rps", rps: 900 }, { rps: 500 })).toContain("500");
	});

	it("refuses zero and a negative value, which the engine would act on", () => {
		// Duration 0 was sent as an omitted duration, so the run lasted the engine's 60 s.
		expect(check({ mode: "constant_rps", duration: 0 })).toMatch(/^Duration must be/);
		expect(check({ mode: "constant_rps", duration: -5 })).toMatch(/^Duration must be/);
		expect(check({ mode: "constant_concurrency", concurrency: 0 })).toMatch(
			/^Virtual users must be/
		);
	});

	it("refuses a fraction where the field counts whole things", () => {
		expect(check({ mode: "constant_concurrency", concurrency: 9000.5 })).toBe(
			"Virtual users must be a whole number from 1 to 1,000, the ceiling set in Settings."
		);
		expect(check({ mode: "iterations", iterations: 10.5 })).toMatch(
			/^Requests must be a whole/
		);
	});

	it("accepts a fractional duration and rate, which the engine reads as numbers", () => {
		expect(check({ mode: "constant_rps", duration: 2.5, rps: 1.5 })).toBeNull();
	});

	it("names the field as the mode labels it", () => {
		expect(check({ mode: "ramp_up", concurrency: 5000, startConcurrency: 1 })).toMatch(
			/^Target virtual users must be/
		);
		expect(check({ mode: "ramp_up", duration: 100_000 })).toMatch(/^Total duration must be/);
		expect(check({ mode: "capacity", concurrency: 5000 })).toMatch(
			/^Maximum virtual users must be/
		);
		expect(check({ mode: "capacity", duration: 100_000 })).toMatch(/^Give up after must be/);
	});

	it("checks the start and the ramp, which follow the connection and duration ceilings", () => {
		expect(check({ mode: "ramp_up", startConcurrency: 5000, concurrency: 1000 })).toMatch(
			/^Start from must be a whole number from 1 to 1,000/
		);
		expect(check({ mode: "ramp_up", rampDuration: 100_000, duration: 3600 })).toMatch(
			/^Ramp duration must be a number from 1 to 3,600, the ceiling set in Settings/
		);
	});

	it("leaves a start below 1 to the floor rule, so it is not reported twice", () => {
		expect(check({ mode: "ramp_up", startConcurrency: 0 })).toBeNull();
		expect(validate({ mode: "ramp_up", startConcurrency: 0 }).startFloorError).not.toBeNull();
	});

	it("checks the capacity budget and step against their fixed ranges, without the Settings clause", () => {
		expect(check({ mode: "capacity", sloMs: 70_000 })).toBe(
			"Latency budget must be a number from 1 to 60,000."
		);
		expect(check({ mode: "capacity", stepDuration: 0 })).toBe(
			"Hold each level for must be a number from 1 to 600."
		);
	});

	it("skips a field the mode does not send", () => {
		// A stale value in a hidden field is nobody's mistake, and must not hold Start.
		expect(check({ mode: "iterations", duration: 0, rps: 0, rampDuration: 0 })).toBeNull();
		expect(check({ mode: "constant_rps", concurrency: 0, iterations: 0 })).toBeNull();
		expect(check({ mode: "constant_concurrency", rps: 0, startConcurrency: 0 })).toBeNull();
		expect(check({ mode: "ramp_up", stepDuration: 0, sloMs: 0, rps: 0 })).toBeNull();
	});

	it("checks max in-flight only when typed, and only where it is sent", () => {
		expect(check({ mode: "constant_rps" }, {}, { maxInFlight: "" })).toBeNull();
		expect(check({ mode: "constant_rps" }, {}, { maxInFlight: "  " })).toBeNull();
		expect(check({ mode: "constant_rps" }, {}, { maxInFlight: "0" })).toBe(
			"Max in-flight requests must be a whole number from 1 to 1,000,000."
		);
		expect(check({ mode: "constant_rps" }, {}, { maxInFlight: "2000000" })).toMatch(
			/^Max in-flight requests must be/
		);
		expect(check({ mode: "constant_concurrency" }, {}, { maxInFlight: "0" })).toBeNull();
	});

	it("allows a slow threshold of 0, which turns the capture off", () => {
		expect(check({}, {}, { slowThreshold: 0 })).toBeNull();
		expect(check({}, {}, { slowThreshold: -1 })).toBe(
			"Slow request threshold must be a number from 0 to 60,000."
		);
		expect(check({}, {}, { slowThreshold: 70_000 })).toMatch(/^Slow request threshold/);
	});

	it("checks the stream caps only for a request that streams", () => {
		const stale = { streamDuration: 0, streamMaxEvents: 0 };
		expect(check(stale, {}, { isStreamingRequest: false })).toBeNull();
		expect(check(stale, {}, { isStreamingRequest: true })).toMatch(/^Stream duration must be/);
		expect(check({ streamMaxEvents: 0 }, {}, { isStreamingRequest: true })).toMatch(
			/^Stream events must be a whole number/
		);
	});

	it("is the message that stops Start", () => {
		const errors = validate({ mode: "constant_rps", duration: 0 });
		expect(firstBlockingError(errors)).toBe(errors.profileRangeError);
	});
});

describe("firstBlockingError", () => {
	it("is null when nothing fails", () => {
		expect(firstBlockingError(NONE)).toBeNull();
	});

	it("reports the ramp message before a budget message", () => {
		expect(
			firstBlockingError({ ...NONE, budgetsError: "budget", rampDurationError: "ramp" })
		).toBe("ramp");
	});

	it("reports a start-floor message before the range rules, which compare against it", () => {
		expect(
			firstBlockingError({
				...NONE,
				capacityRangeError: "capacity",
				startConcurrencyError: "downwards",
				startFloorError: "floor",
			})
		).toBe("floor");
	});

	it("blocks on a scenario-only element, after the rules a field can fix", () => {
		expect(firstBlockingError({ ...NONE, scenarioOnlyError: "pacing" })).toBe("pacing");
		expect(
			firstBlockingError({ ...NONE, scenarioOnlyError: "pacing", monitoringError: "monitor" })
		).toBe("monitor");
	});
});
