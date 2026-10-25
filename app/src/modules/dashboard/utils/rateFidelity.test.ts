import { describe, it, expect } from "vitest";
import { liveRateFidelity } from "./rateFidelity";

describe("liveRateFidelity", () => {
	it("divides sent by what the target owed over the elapsed time while sending", () => {
		expect(
			liveRateFidelity({
				targetRps: 200,
				requestsSent: 1900,
				elapsedSeconds: 10,
				durationSeconds: 30,
			})
		).toEqual({ actualRps: 190, achievementPct: 95 });
	});

	it("stops the window at the configured duration, so the drain owes nothing", () => {
		expect(
			liveRateFidelity({
				targetRps: 100,
				requestsSent: 2000,
				elapsedSeconds: 27,
				durationSeconds: 20,
			})
		).toEqual({ actualRps: 100, achievementPct: 100 });
	});

	it("uses the elapsed time when the run has no configured duration", () => {
		expect(liveRateFidelity({ targetRps: 100, requestsSent: 500, elapsedSeconds: 5 })).toEqual({
			actualRps: 100,
			achievementPct: 100,
		});
	});

	it("gives the rate but no percentage without a target", () => {
		expect(liveRateFidelity({ requestsSent: 500, elapsedSeconds: 5 })).toEqual({
			actualRps: 100,
		});
		expect(liveRateFidelity({ targetRps: 0, requestsSent: 500, elapsedSeconds: 5 })).toEqual({
			actualRps: 100,
		});
	});

	it("has nothing to say before the first window or without a sent count", () => {
		expect(
			liveRateFidelity({ targetRps: 100, requestsSent: 0, elapsedSeconds: 0 })
		).toBeUndefined();
		expect(liveRateFidelity({ targetRps: 100, elapsedSeconds: 5 })).toBeUndefined();
		expect(
			liveRateFidelity({ targetRps: 100, requestsSent: 10, elapsedSeconds: Number.NaN })
		).toBeUndefined();
	});

	describe("at the end of the sending window (#2910)", () => {
		it("owes the engine's whole count, so 33.3 req/s for 3 s ending at 99 sent reads 100", () => {
			expect(
				liveRateFidelity({
					targetRps: 33.3,
					requestsSent: 99,
					elapsedSeconds: 3,
					durationSeconds: 3,
				})?.achievementPct
			).toBe(100);
		});

		it("holds through the drain, where elapsed time passes the duration", () => {
			expect(
				liveRateFidelity({
					targetRps: 33.3,
					requestsSent: 99,
					elapsedSeconds: 4.2,
					durationSeconds: 3,
				})?.achievementPct
			).toBe(100);
		});

		it("keeps the continuous owed-to-date while the run is inside the window", () => {
			const pct = liveRateFidelity({
				targetRps: 33.3,
				requestsSent: 49,
				elapsedSeconds: 2.9,
				durationSeconds: 3,
			})?.achievementPct;
			expect(pct).toBeCloseTo((49 / (33.3 * 2.9)) * 100, 10);
		});

		it("reads a product that binary lands just below a whole number as whole", () => {
			expect(0.57 * 100).toBeLessThan(57);
			expect(
				liveRateFidelity({
					targetRps: 0.57,
					requestsSent: 57,
					elapsedSeconds: 100,
					durationSeconds: 100,
				})?.achievementPct
			).toBe(100);
		});

		it("falls back to the continuous owed count when the whole count is 0", () => {
			const result = liveRateFidelity({
				targetRps: 0.2,
				requestsSent: 0,
				elapsedSeconds: 3,
				durationSeconds: 3,
			});
			expect(result).toEqual({ actualRps: 0, achievementPct: 0 });
		});
	});
});
