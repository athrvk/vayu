/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { computeEta } from "./computeEta";

describe("computeEta", () => {
	it("returns remaining seconds = (expected - sent) / currentRps", () => {
		expect(computeEta({ requestsExpected: 1000, requestsSent: 400, currentRps: 60 })).toBe(10);
	});

	it("is null when there is no fixed expected count (open-ended modes)", () => {
		expect(computeEta({ requestsExpected: 0, requestsSent: 400, currentRps: 60 })).toBeNull();
	});

	it("is null when currentRps is zero or negative (cannot project)", () => {
		expect(computeEta({ requestsExpected: 1000, requestsSent: 400, currentRps: 0 })).toBeNull();
	});

	it("clamps to 0 once sent meets or exceeds expected", () => {
		expect(computeEta({ requestsExpected: 1000, requestsSent: 1000, currentRps: 60 })).toBe(0);
		expect(computeEta({ requestsExpected: 1000, requestsSent: 1200, currentRps: 60 })).toBe(0);
	});
});
