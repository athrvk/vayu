/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which runs are worth asking about, and how the ask says their length.
 *
 * The threshold is a product decision, so what is pinned here is the boundary
 * behaviour around it rather than the number: a run at the threshold asks, one
 * under it does not, and a run that never declared a length is never guessed at.
 */

import { describe, expect, it } from "vitest";
import { LONG_RUN_SECONDS, formatRunLength, isLongRun, runLengthSeconds } from "./keepAwake";

describe("runLengthSeconds", () => {
	it("reads the seconds form the run config carries", () => {
		expect(runLengthSeconds({ duration: "600s" })).toBe(600);
	});

	it("reads a bare number too", () => {
		expect(runLengthSeconds({ duration: "600" })).toBe(600);
	});

	it("falls back to the ramp when that is all the config named", () => {
		expect(runLengthSeconds({ rampUpDuration: "900s" })).toBe(900);
	});

	it("prefers the total over the ramp, which is a part of it", () => {
		expect(runLengthSeconds({ duration: "1200s", rampUpDuration: "300s" })).toBe(1200);
	});

	it("answers null for a run that declares no length", () => {
		// An iterations run ends when the work does. Guessing a length for it
		// would put a duration in a sentence the config never supported.
		expect(runLengthSeconds({ mode: "iterations", iterations: 100_000 })).toBeNull();
		expect(runLengthSeconds(null)).toBeNull();
		expect(runLengthSeconds(undefined)).toBeNull();
	});

	it("answers null for a value it cannot read rather than a wrong number", () => {
		expect(runLengthSeconds({ duration: "" })).toBeNull();
		expect(runLengthSeconds({ duration: "forever" })).toBeNull();
		// "10m" is not a form the dialog produces, and reading it as 10 *seconds*
		// would silently stop asking about a ten-minute run.
		expect(runLengthSeconds({ duration: "10m" })).toBeNull();
	});
});

describe("isLongRun", () => {
	it("asks about a run at the threshold", () => {
		expect(isLongRun({ duration: `${LONG_RUN_SECONDS}s` })).toBe(true);
	});

	it("says nothing about a run one second under it", () => {
		expect(isLongRun({ duration: `${LONG_RUN_SECONDS - 1}s` })).toBe(false);
	});

	it("says nothing about a run with no declared length", () => {
		expect(isLongRun({ mode: "iterations" })).toBe(false);
	});
});

describe("formatRunLength", () => {
	it("keeps a short run in seconds", () => {
		expect(formatRunLength(90)).toBe("90 seconds");
	});

	it("rounds to minutes for the runs that get asked about", () => {
		expect(formatRunLength(300)).toBe("5 minutes");
		expect(formatRunLength(1800)).toBe("30 minutes");
	});

	it("moves to hours once minutes stop reading as a length", () => {
		expect(formatRunLength(7200)).toBe("2 hours");
		expect(formatRunLength(9000)).toBe("2.5 hours");
	});
});
