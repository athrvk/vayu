/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The one predicate the Send chord and the palette's Send row both ask (#1243).
 *
 * Each case below is a state in which the builder's own Send control is absent
 * or disabled; a `true` here would be the palette offering what the button in
 * front of the user refuses.
 */

import { describe, it, expect } from "vitest";
import { canSendRequest } from "./send-gate";

const READY = { url: "https://api.test/x", isExecuting: false, isStreaming: false };

describe("when a send may run", () => {
	it("allows a send with a URL and nothing in flight", () => {
		expect(canSendRequest(READY)).toBe(true);
	});

	it("refuses a request that is already in flight", () => {
		expect(canSendRequest({ ...READY, isExecuting: true })).toBe(false);
	});

	it("refuses one whose stream is still open - Send is Stop there (#574)", () => {
		expect(canSendRequest({ ...READY, isStreaming: true })).toBe(false);
	});

	it("refuses an empty URL, whitespace included", () => {
		expect(canSendRequest({ ...READY, url: "" })).toBe(false);
		expect(canSendRequest({ ...READY, url: "   " })).toBe(false);
	});
});
