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
});
