/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import {
	DEFAULT_LIVE_WINDOW,
	LIVE_WINDOW_OPTIONS,
	liveWindowFromMs,
	liveWindowSeconds,
	liveWindowToMs,
	DEFAULT_MAX_RETAINED_TICKS,
	type LiveWindow,
} from "./live-window";

describe("live window <-> engine milliseconds", () => {
	it("round-trips every option the picker offers", () => {
		for (const option of LIVE_WINDOW_OPTIONS) {
			expect(liveWindowFromMs(liveWindowToMs(option.value))).toBe(option.value);
		}
	});

	// The engine stores an integer, so "no time limit" needs a representable
	// value. 0 is that value on both sides - live_ring_size() reads it the same
	// way. Mapping it to the default instead would silently demote a user's
	// "Full run" to 5 minutes on every reload.
	it("uses 0 for full run in both directions", () => {
		expect(liveWindowToMs("full")).toBe(0);
		expect(liveWindowFromMs(0)).toBe("full");
		expect(liveWindowSeconds("full")).toBeNull();
	});

	it("converts the bounded options to milliseconds", () => {
		expect(liveWindowToMs("1m")).toBe(60000);
		expect(liveWindowToMs("5m")).toBe(300000);
		expect(liveWindowToMs("30m")).toBe(1800000);
	});

	// The engine's settings list renders liveReplayWindowMs as a free integer
	// field, so a value matching no option is reachable without editing the DB.
	// Rounding *down* keeps the invariant that matters: the chart never claims
	// more history than the engine retained.
	it("resolves an off-option value to the nearest option that does not exceed it", () => {
		expect(liveWindowFromMs(90000)).toBe("1m");
		expect(liveWindowFromMs(299999)).toBe("1m");
		expect(liveWindowFromMs(300001)).toBe("5m");
		expect(liveWindowFromMs(3600000)).toBe("30m");
	});

	it("falls back to the default for values below the shortest option", () => {
		expect(liveWindowFromMs(1)).toBe(DEFAULT_LIVE_WINDOW);
		expect(liveWindowFromMs(59999)).toBe(DEFAULT_LIVE_WINDOW);
	});

	// `Number(undefined)` is NaN and `Number("")` is 0 - the latter would read as
	// "full run" if it reached here, so the hook passes undefined for a missing
	// entry rather than an empty string.
	it("falls back to the default for absent or unparseable values", () => {
		expect(liveWindowFromMs(undefined)).toBe(DEFAULT_LIVE_WINDOW);
		expect(liveWindowFromMs(null)).toBe(DEFAULT_LIVE_WINDOW);
		expect(liveWindowFromMs(Number("nope"))).toBe(DEFAULT_LIVE_WINDOW);
		expect(liveWindowFromMs(-1)).toBe(DEFAULT_LIVE_WINDOW);
		expect(liveWindowFromMs(Infinity)).toBe(DEFAULT_LIVE_WINDOW);
	});

	// The renderer's default backstop and the engine's DEFAULT_MAX_LIVE_TICKS are
	// a matched pair: the engine must not retain ticks this side will discard,
	// and must not retain fewer than a "full run" here can show. The live value
	// is the shared `liveMaxRetainedTicks` setting; this is the pre-config
	// default, and if the two constants drift the two sides drift with them.
	it("keeps the default tick backstop equal to the engine's", () => {
		expect(DEFAULT_MAX_RETAINED_TICKS).toBe(50000);
	});

	// The ceiling is chosen so the longest window the picker offers is honoured
	// in full at the default tick interval - otherwise "Full run" would quietly
	// mean "however much fits", which is the failure this whole setting fixes.
	it("holds the longest configurable window at the default tick interval", () => {
		const longestMs = 3600000; // liveReplayWindowMs max
		const defaultTickMs = 100;
		expect(longestMs / defaultTickMs).toBeLessThan(DEFAULT_MAX_RETAINED_TICKS);
	});

	it("every option is a valid LiveWindow with a distinct span", () => {
		const spans = LIVE_WINDOW_OPTIONS.map((o) => liveWindowToMs(o.value as LiveWindow));
		expect(new Set(spans).size).toBe(LIVE_WINDOW_OPTIONS.length);
	});
});
