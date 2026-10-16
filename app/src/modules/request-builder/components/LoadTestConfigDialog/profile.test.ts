/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { profileParams } from "./profile";
import type { LoadTestProfile } from "./useSavedLoadTestConfig";

const PROFILE: LoadTestProfile = {
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
};

const params = (mode: LoadTestProfile["mode"], maxInFlight: number | null = null) =>
	profileParams({ ...PROFILE, mode }, maxInFlight);

describe("profileParams", () => {
	it("carries exactly the fields each mode owns", () => {
		expect(params("constant_rps")).toEqual({ mode: "constant_rps", duration: 30, rps: 100 });
		expect(params("constant_concurrency")).toEqual({
			mode: "constant_concurrency",
			duration: 30,
			concurrency: 10,
		});
		expect(params("iterations")).toEqual({
			mode: "iterations",
			iterations: 500,
			concurrency: 10,
		});
		expect(params("ramp_up")).toEqual({
			mode: "ramp_up",
			duration: 30,
			concurrency: 10,
			rampDuration: 10,
			startConcurrency: 2,
		});
		expect(params("capacity")).toEqual({
			mode: "capacity",
			duration: 30,
			concurrency: 10,
			startConcurrency: 2,
			sloMs: 250,
			stepDuration: 5,
		});
	});

	it("leaves an unused field absent rather than undefined", () => {
		expect(params("iterations")).not.toHaveProperty("duration");
		expect(params("constant_concurrency")).not.toHaveProperty("rps");
	});

	it("caps in-flight requests only for a positive value on a constant-rate run", () => {
		expect(params("constant_rps", 50).maxInFlight).toBe(50);
		expect(params("constant_rps", 0)).not.toHaveProperty("maxInFlight");
		expect(params("constant_rps", null)).not.toHaveProperty("maxInFlight");
		expect(params("constant_concurrency", 50)).not.toHaveProperty("maxInFlight");
	});
});
