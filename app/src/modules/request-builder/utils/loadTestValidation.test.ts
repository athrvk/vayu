import { describe, it, expect } from "vitest";
import { validateRampDuration } from "./loadTestValidation";

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
