/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `formatSleepDuration` at its boundaries, and the one-line sentence built on
 * top of it. Both readers - the chart mark and the Events row - go through
 * these, so a wrong boundary here is wrong on both surfaces at once.
 */

import { describe, it, expect } from "vitest";
import { formatSleepDuration, hostSleepLabel } from "./hostSleep";
import type { HostSleep } from "@/stores/host-sleep-store";

function sleep(durationMs: number): HostSleep {
	return { at: 0, durationMs, startSeconds: 0 };
}

describe("formatSleepDuration", () => {
	it("reads under a minute as seconds", () => {
		expect(formatSleepDuration(45_000)).toBe("45s");
	});

	it("reads exactly a minute as '1m', with no dangling '0s'", () => {
		// Pins `seconds > 0 ? "...s" : "..."`: a naive concatenation would print
		// "1m 0s" here.
		expect(formatSleepDuration(60_000)).toBe("1m");
	});

	it("reads minutes with a seconds remainder", () => {
		expect(formatSleepDuration(72_000)).toBe("1m 12s");
	});

	it("reads minutes with no remainder, and no hours branch below an hour", () => {
		expect(formatSleepDuration(180_000)).toBe("3m");
	});

	it("reads the hours branch with remaining minutes", () => {
		expect(formatSleepDuration(5_400_000)).toBe("1h 30m"); // 1h 30m
	});

	it("reads the hours branch with no remaining minutes, and no dangling '0m'", () => {
		expect(formatSleepDuration(7_200_000)).toBe("2h");
	});

	it("clamps a negative duration to '0s' rather than printing a negative number", () => {
		expect(formatSleepDuration(-5_000)).toBe("0s");
	});

	it("reads a zero duration as '0s'", () => {
		expect(formatSleepDuration(0)).toBe("0s");
	});
});

describe("hostSleepLabel", () => {
	it("is 'Host asleep <duration>', the same sentence on the chart and the Events row", () => {
		expect(hostSleepLabel(sleep(72_000))).toBe("Host asleep 1m 12s");
	});
});
