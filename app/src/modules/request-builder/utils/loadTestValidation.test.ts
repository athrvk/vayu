import { describe, it, expect } from "vitest";
import {
	validateCapacityRange,
	validateRampDuration,
	validateStartConcurrencyFloor,
} from "./loadTestValidation";

describe("validateRampDuration", () => {
	it("returns null for non-ramp_up modes regardless of durations", () => {
		expect(validateRampDuration("constant_rps", 5, 60)).toBeNull();
		expect(validateRampDuration("constant_concurrency", 5, 60)).toBeNull();
		expect(validateRampDuration("iterations", 5, 60)).toBeNull();
	});

	it("returns null when total duration exceeds ramp duration", () => {
		expect(validateRampDuration("ramp_up", 30, 10)).toBeNull();
	});

	it("returns null when total duration equals ramp duration", () => {
		expect(validateRampDuration("ramp_up", 10, 10)).toBeNull();
	});

	it("returns an error message when total duration is less than ramp duration", () => {
		const msg = validateRampDuration("ramp_up", 6, 10);
		expect(msg).not.toBeNull();
		expect(msg).toContain("6");
		expect(msg).toContain("10");
	});
});

describe("validateStartConcurrencyFloor", () => {
	// The value the engine answers with a 400, and the one a cleared number
	// input produces: `Number("")` is 0, not NaN.
	it("rejects a start of 0 in both profiles that climb from it", () => {
		expect(validateStartConcurrencyFloor("ramp_up", 0)).toContain("at least 1");
		expect(validateStartConcurrencyFloor("capacity", 0)).toContain("at least 1");
	});

	it("rejects a negative start, which the engine reads as a size_t", () => {
		expect(validateStartConcurrencyFloor("ramp_up", -1)).toContain("at least 1");
	});

	it("rejects a non-numeric start rather than sending JSON null", () => {
		expect(validateStartConcurrencyFloor("capacity", Number.NaN)).toContain("at least 1");
	});

	it("accepts the floor itself and anything above it", () => {
		expect(validateStartConcurrencyFloor("ramp_up", 1)).toBeNull();
		expect(validateStartConcurrencyFloor("capacity", 64)).toBeNull();
	});

	// The other modes never send `start_concurrency`, so a stale 0 left in the
	// field by a profile switch must not block them.
	it("says nothing about a mode that does not send a start", () => {
		expect(validateStartConcurrencyFloor("constant_rps", 0)).toBeNull();
		expect(validateStartConcurrencyFloor("constant_concurrency", 0)).toBeNull();
		expect(validateStartConcurrencyFloor("iterations", 0)).toBeNull();
		expect(validateStartConcurrencyFloor(undefined, 0)).toBeNull();
	});
});

describe("validateCapacityRange", () => {
	it("rejects a search whose start is already at its ceiling", () => {
		// The engine runs it - one level, then `cap_reached` - which is exactly
		// the run the profile does not exist to do.
		expect(validateCapacityRange("capacity", 64, 64)).toContain("one level");
		expect(validateCapacityRange("capacity", 100, 64)).toContain("one level");
	});

	it("accepts a start below the ceiling", () => {
		expect(validateCapacityRange("capacity", 4, 256)).toBeNull();
	});

	it("says nothing about any other mode", () => {
		// `ramp_up` allows a start above its target on purpose - that is a ramp
		// down - so this rule must not reach it.
		expect(validateCapacityRange("ramp_up", 100, 10)).toBeNull();
		expect(validateCapacityRange("constant_concurrency", 100, 10)).toBeNull();
		expect(validateCapacityRange(undefined, 100, 10)).toBeNull();
	});
});
