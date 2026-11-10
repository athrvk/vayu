/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, it } from "vitest";
import { STREAM_RETRY_JITTER, streamRetryDelayMs } from "./stream-backoff";

const LADDER = { baseMs: 400, maxMs: 5000 };

describe("streamRetryDelayMs", () => {
	it("doubles from the base and stops at the cap", () => {
		expect(streamRetryDelayMs(1, LADDER, () => 0)).toBe(400);
		expect(streamRetryDelayMs(2, LADDER, () => 0)).toBe(800);
		expect(streamRetryDelayMs(4, LADDER, () => 0)).toBe(3200);
		expect(streamRetryDelayMs(50, LADDER, () => 0)).toBe(5000);
	});

	it("treats an attempt below one as the first", () => {
		expect(streamRetryDelayMs(0, LADDER, () => 0)).toBe(400);
	});

	it("adds at most the jitter fraction of the step, the cap included", () => {
		expect(streamRetryDelayMs(1, LADDER, () => 1)).toBe(400 * (1 + STREAM_RETRY_JITTER));
		expect(streamRetryDelayMs(50, LADDER, () => 1)).toBe(5000 * (1 + STREAM_RETRY_JITTER));
	});

	it("takes a jitter of its own when one is stated", () => {
		expect(streamRetryDelayMs(1, { ...LADDER, jitter: 0 }, () => 1)).toBe(400);
		expect(streamRetryDelayMs(1, { ...LADDER, jitter: 1 }, () => 1)).toBe(800);
	});
});
