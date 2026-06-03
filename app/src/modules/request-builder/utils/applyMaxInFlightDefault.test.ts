import { describe, it, expect } from "vitest";
import { applyMaxInFlightDefault } from "./applyMaxInFlightDefault";

describe("applyMaxInFlightDefault", () => {
	it("keeps the per-run value when both per-run and global are set (per-run wins)", () => {
		const result = applyMaxInFlightDefault({ maxInFlight: 500 }, 2000);
		expect(result.maxInFlight).toBe(500);
	});

	it("uses the global default when per-run value is undefined", () => {
		const result = applyMaxInFlightDefault({ maxInFlight: undefined }, 2000);
		expect(result.maxInFlight).toBe(2000);
	});

	it("uses the global default when per-run value is absent entirely", () => {
		const result = applyMaxInFlightDefault({} as { maxInFlight?: number }, 2000);
		expect(result.maxInFlight).toBe(2000);
	});

	it("leaves the request unchanged when global is null (auto)", () => {
		const request = { maxInFlight: undefined };
		const result = applyMaxInFlightDefault(request, null);
		expect(result.maxInFlight).toBeUndefined();
	});

	it("leaves the request unchanged when global is undefined", () => {
		const result = applyMaxInFlightDefault({ maxInFlight: undefined }, undefined);
		expect(result.maxInFlight).toBeUndefined();
	});

	it("leaves the request unchanged when global is 0 or negative", () => {
		expect(applyMaxInFlightDefault({ maxInFlight: undefined }, 0).maxInFlight).toBeUndefined();
		expect(applyMaxInFlightDefault({ maxInFlight: undefined }, -5).maxInFlight).toBeUndefined();
	});

	it("preserves other fields on the request", () => {
		const request = { method: "GET", url: "http://x", maxInFlight: undefined };
		const result = applyMaxInFlightDefault(request, 1500);
		expect(result).toEqual({ method: "GET", url: "http://x", maxInFlight: 1500 });
	});

	it("returns the same reference when no injection happens (per-run set)", () => {
		const request = { maxInFlight: 100 };
		expect(applyMaxInFlightDefault(request, 2000)).toBe(request);
	});
});
