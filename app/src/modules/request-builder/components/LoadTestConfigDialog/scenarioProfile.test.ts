/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import {
	LOAD_TEST_LIMITS,
	resolveLoadTestLimits,
	DEFAULT_LOAD_TEST_CEILINGS,
} from "@/constants/load-test";
import {
	SCENARIO_PROFILE_DEFAULTS,
	isScenarioLoadMode,
	scenarioLoadFields,
	scenarioProfileError,
	scenarioStreamCapError,
	scenarioStreamCaps,
	type ScenarioLoadProfile,
} from "./scenarioProfile";

const profile = (patch: Partial<ScenarioLoadProfile> = {}): ScenarioLoadProfile => ({
	...SCENARIO_PROFILE_DEFAULTS,
	...patch,
});
const limits = resolveLoadTestLimits(DEFAULT_LOAD_TEST_CEILINGS);

describe("scenarioLoadFields", () => {
	it("spells a timed run camelCase with a seconds string", () => {
		expect(scenarioLoadFields(profile())).toEqual({
			mode: "constant_concurrency",
			concurrency: 10,
			duration: "30s",
		});
	});

	it("adds the ramp's start and length, both in the payload's spelling", () => {
		expect(
			scenarioLoadFields(
				profile({ mode: "ramp_up", startConcurrency: 2, rampDuration: 8, duration: 40 })
			)
		).toEqual({
			mode: "ramp_up",
			concurrency: 10,
			duration: "40s",
			startConcurrency: 2,
			rampUpDuration: "8s",
		});
	});

	it("sends the pass total and no duration for fixed passes", () => {
		const fields = scenarioLoadFields(profile({ mode: "iterations", iterations: 60 }));
		expect(fields).toEqual({ mode: "iterations", concurrency: 10, iterations: 60 });
		expect(fields).not.toHaveProperty("duration");
	});
});

describe("isScenarioLoadMode", () => {
	it("accepts the three closed-loop modes and refuses the two the engine 400s", () => {
		for (const mode of ["constant_concurrency", "iterations", "ramp_up"]) {
			expect(isScenarioLoadMode(mode)).toBe(true);
		}
		for (const mode of ["constant_rps", "capacity", ""]) {
			expect(isScenarioLoadMode(mode)).toBe(false);
		}
	});
});

describe("scenarioProfileError", () => {
	it("passes the defaults", () => {
		expect(scenarioProfileError(profile(), limits)).toBeNull();
	});

	it("bounds virtual users to whole numbers inside the ceiling", () => {
		const ceiling = LOAD_TEST_LIMITS.CONCURRENCY.MAX;
		for (const concurrency of [0, -1, 1.5, NaN, ceiling + 1]) {
			expect(scenarioProfileError(profile({ concurrency }), limits)).toMatch(/Virtual users/);
		}
		expect(scenarioProfileError(profile({ concurrency: ceiling }), limits)).toBeNull();
	});

	it("follows a lowered ceiling", () => {
		const lowered = resolveLoadTestLimits({ ...DEFAULT_LOAD_TEST_CEILINGS, concurrency: 20 });
		expect(scenarioProfileError(profile({ concurrency: 21 }), lowered)).toMatch(/1 to 20/);
		expect(scenarioProfileError(profile({ concurrency: 20 }), lowered)).toBeNull();
	});

	it("checks the duration only where the mode has one", () => {
		expect(scenarioProfileError(profile({ duration: 0 }), limits)).toMatch(/Duration/);
		expect(
			scenarioProfileError(profile({ mode: "iterations", duration: 0 }), limits)
		).toBeNull();
	});

	it("checks the pass total only for fixed passes", () => {
		expect(scenarioProfileError(profile({ iterations: 0 }), limits)).toBeNull();
		expect(
			scenarioProfileError(profile({ mode: "iterations", iterations: 0 }), limits)
		).toMatch(/Passes through the sequence/);
		expect(
			scenarioProfileError(profile({ mode: "iterations", iterations: 2.5 }), limits)
		).toMatch(/whole number/);
	});

	it("reuses the ramp rules: it must fit, start at 1 or more and not climb down", () => {
		const ramp = (patch: Partial<ScenarioLoadProfile>) =>
			scenarioProfileError(profile({ mode: "ramp_up", ...patch }), limits);
		expect(ramp({ duration: 5, rampDuration: 10 })).toMatch(/at least the ramp duration/);
		expect(ramp({ startConcurrency: 0 })).toMatch(/at least 1/);
		expect(ramp({ startConcurrency: 11, concurrency: 10 })).toMatch(/ramp down/);
		expect(ramp({})).toBeNull();
	});

	it("does not apply the ramp rules to the other modes", () => {
		expect(scenarioProfileError(profile({ duration: 5, rampDuration: 10 }), limits)).toBeNull();
	});
});

describe("scenarioStreamCaps (#3235)", () => {
	it("spells the caps as the engine's milliseconds and carries no `stream`", () => {
		const caps = scenarioStreamCaps(profile({ streamDuration: 20, streamMaxEvents: 250 }));
		expect(caps).toEqual({ maxStreamDurationMs: 20_000, maxStreamEvents: 250 });
	});

	it("rounds a fractional second to a whole millisecond, which the engine requires", () => {
		expect(scenarioStreamCaps(profile({ streamDuration: 1.0004 })).maxStreamDurationMs).toBe(
			1000
		);
	});
});

describe("scenarioStreamCapError (#3235)", () => {
	it("passes the defaults and both ends of each range", () => {
		expect(scenarioStreamCapError(profile(), limits)).toBeNull();
		const { STREAM_DURATION_S: d, STREAM_MAX_EVENTS: e } = limits;
		expect(
			scenarioStreamCapError(
				profile({ streamDuration: d.MIN, streamMaxEvents: e.MIN }),
				limits
			)
		).toBeNull();
		expect(
			scenarioStreamCapError(
				profile({ streamDuration: d.MAX, streamMaxEvents: e.MAX }),
				limits
			)
		).toBeNull();
	});

	it.each([
		{
			patch: { streamDuration: 0 },
			message: /Stream duration must be a number from 1 to 86,400\./,
		},
		{ patch: { streamDuration: 86_401 }, message: /Stream duration/ },
		{ patch: { streamDuration: Number.NaN }, message: /Stream duration/ },
		{ patch: { streamMaxEvents: 0 }, message: /Stream events must be a whole number from 1/ },
		{ patch: { streamMaxEvents: 1.5 }, message: /Stream events/ },
		{ patch: { streamMaxEvents: 10_000_001 }, message: /Stream events/ },
	])("refuses $patch", ({ patch, message }) => {
		expect(scenarioStreamCapError(profile(patch), limits)).toMatch(message);
	});

	it("does not call an engine bound a Settings ceiling", () => {
		expect(scenarioStreamCapError(profile({ streamDuration: 0 }), limits)).not.toMatch(
			/Settings/
		);
	});
});
