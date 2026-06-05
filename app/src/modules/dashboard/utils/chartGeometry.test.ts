import { describe, it, expect } from "vitest";
import { niceYMax, projectY } from "./chartGeometry";

describe("niceYMax", () => {
	it("returns finite value >= 1 for empty array", () => {
		const result = niceYMax([]);
		expect(Number.isFinite(result)).toBe(true);
		expect(result).toBeGreaterThanOrEqual(1);
	});

	it("returns finite value >= 1 for all-zero array", () => {
		const result = niceYMax([0, 0, 0]);
		expect(Number.isFinite(result)).toBe(true);
		expect(result).toBeGreaterThanOrEqual(1);
	});

	it("returns value > maxVal for non-zero array", () => {
		const result = niceYMax([100]);
		expect(result).toBeGreaterThan(100);
	});

	it("applies custom floor", () => {
		const result = niceYMax([0], { floor: 50 });
		expect(result).toBeGreaterThanOrEqual(50);
	});

	it("applies custom headroom", () => {
		const result = niceYMax([100], { headroom: 1.5 });
		expect(result).toBeCloseTo(150);
	});

	it("never returns 0 or NaN", () => {
		const result = niceYMax([]);
		expect(result).not.toBe(0);
		expect(Number.isNaN(result)).toBe(false);
	});
});

describe("projectY", () => {
	it("returns finite value when yMax is 0", () => {
		const result = projectY(0, 0, 10, 100);
		expect(Number.isFinite(result)).toBe(true);
	});

	it("returns finite value when yMax is negative", () => {
		const result = projectY(5, -1, 10, 100);
		expect(Number.isFinite(result)).toBe(true);
	});

	it("returns finite value when v is NaN", () => {
		const result = projectY(NaN, 1, 10, 100);
		expect(Number.isFinite(result)).toBe(true);
	});

	it("returns finite value when v is Infinity", () => {
		const result = projectY(Infinity, 1, 10, 100);
		expect(Number.isFinite(result)).toBe(true);
	});

	it("maps v=0 to top+innerH (bottom of chart)", () => {
		// v=0 → 1 - 0/yMax = 1 → top + 1*innerH
		expect(projectY(0, 100, 10, 100)).toBeCloseTo(110);
	});

	it("maps v=yMax to top (top of chart)", () => {
		// v=yMax → 1 - yMax/yMax = 0 → top + 0*innerH
		expect(projectY(100, 100, 10, 100)).toBeCloseTo(10);
	});

	it("maps v=yMax/2 to midpoint", () => {
		expect(projectY(50, 100, 10, 100)).toBeCloseTo(60);
	});

	it("fallback is top+innerH when yMax <= 0", () => {
		// degenerate: should land at bottom of chart area
		expect(projectY(0, 0, 10, 100)).toBeCloseTo(110);
	});
});
