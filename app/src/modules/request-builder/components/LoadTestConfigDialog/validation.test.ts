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
	});

const NONE: DraftErrors = {
	rampDurationError: null,
	startFloorError: null,
	startConcurrencyError: null,
	capacityRangeError: null,
	budgetsError: null,
	monitoringError: null,
	scenarioOnlyError: null,
};

describe("validateLoadTestDraft", () => {
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
