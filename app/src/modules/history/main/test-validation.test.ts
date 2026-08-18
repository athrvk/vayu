/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Splitting a load run's synthetic test-validation row out of its real samples
 * (issue #726).
 *
 * The two halves are one decision seen twice: whatever `extractTestFailures`
 * lifts for the Overview to name is exactly what `sampleResultsWithoutValidationRow`
 * must keep out of the Samples tab, or the row is either shown twice or lost.
 */

import { describe, it, expect } from "vitest";
import {
	extractTestFailures,
	isTestValidationRow,
	sampleResultsWithoutValidationRow,
} from "./test-validation";
import type { SampleResult } from "../types";

const CAPTURED: SampleResult = {
	timestamp: 1_700_000_000_000,
	statusCode: 200,
	statusText: "OK",
	latencyMs: 12,
	trace: { request: { method: "GET", url: "https://example.test/" } },
};

/** A real transport failure: status 0 and an error, but no `failures` list. */
const CONNECTION_FAILURE: SampleResult = {
	timestamp: 1_700_000_000_001,
	statusCode: 0,
	latencyMs: 0,
	error: "connection refused",
	trace: { error_type: "ConnectionError" },
};

const VALIDATION_ROW: SampleResult = {
	timestamp: 1_700_000_000_002,
	statusCode: 0,
	latencyMs: 0,
	error: "Script validation failures",
	trace: {
		failures: ["status is 200: expected 404 to equal 200"],
		totalFailed: 13,
		totalPassed: 87,
	},
};

describe("isTestValidationRow", () => {
	it("identifies the synthetic row by its failures, not by its status code", () => {
		expect(isTestValidationRow(VALIDATION_ROW)).toBe(true);
		// Both are status 0 with an error string. Keying on the status would
		// swallow every connection failure the run recorded.
		expect(isTestValidationRow(CONNECTION_FAILURE)).toBe(false);
		expect(isTestValidationRow(CAPTURED)).toBe(false);
	});
});

describe("extractTestFailures", () => {
	it("lifts the failures and the engine's own totals", () => {
		const failures = extractTestFailures([CAPTURED, VALIDATION_ROW]);

		expect(failures).toEqual({
			messages: ["status is 200: expected 404 to equal 200"],
			total: 13,
			passed: 87,
		});
	});

	it("returns null for a run that recorded no failures", () => {
		expect(extractTestFailures([CAPTURED, CONNECTION_FAILURE])).toBeNull();
		expect(extractTestFailures([])).toBeNull();
		expect(extractTestFailures(undefined)).toBeNull();
	});

	it("falls back to the list length rather than zero when the count is missing", () => {
		// A row written before the counts existed. Reporting `total: 0` beside a
		// non-empty list would claim the run failed nothing while showing failures.
		const row: SampleResult = {
			...VALIDATION_ROW,
			trace: { failures: ["a: expected 1 to equal 2", "b: expected 3 to equal 4"] },
		};

		expect(extractTestFailures([row])).toEqual({
			messages: ["a: expected 1 to equal 2", "b: expected 3 to equal 4"],
			total: 2,
			passed: 0,
		});
	});
});

describe("sampleResultsWithoutValidationRow", () => {
	it("drops the synthetic row and keeps every captured sample", () => {
		const kept = sampleResultsWithoutValidationRow([
			CAPTURED,
			VALIDATION_ROW,
			CONNECTION_FAILURE,
		]);

		expect(kept).toEqual([CAPTURED, CONNECTION_FAILURE]);
	});

	it("leaves a run without one untouched", () => {
		expect(sampleResultsWithoutValidationRow([CAPTURED])).toEqual([CAPTURED]);
		expect(sampleResultsWithoutValidationRow(undefined)).toEqual([]);
	});
});
