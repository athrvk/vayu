/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One formatter for a timing phase, because there were three.
 *
 * DNS, connect, TLS, first byte and download were rendered by the dashboard at
 * `toFixed(2)`, by the history breakdown at `toFixed(1)`, and by the
 * request-builder timing tab with significant digits. Same five numbers, three
 * answers, depending which screen you were on. The third was already right; it
 * moved somewhere the other two could reach it.
 */

import { describe, it, expect } from "vitest";
import { formatPhaseMs, formatResponseTime } from "./utils";

describe("formatPhaseMs", () => {
	it("keeps two decimals below 10ms, where a phase often lives", () => {
		// A cached DNS lookup or a warm local connect. `toFixed(1)` rounds these
		// to "0.0" and loses the only signal there is.
		expect(formatPhaseMs(0.04)).toBe("0.04");
		expect(formatPhaseMs(3.216)).toBe("3.22");
	});

	it("drops to one decimal in the tens", () => {
		expect(formatPhaseMs(10)).toBe("10.0");
		expect(formatPhaseMs(47.83)).toBe("47.8");
	});

	it("drops decimals entirely past 100ms, where they are noise", () => {
		expect(formatPhaseMs(100)).toBe("100");
		expect(formatPhaseMs(312.7)).toBe("313");
	});

	it("never renders a phase in a unit other than ms", () => {
		// Unlike a whole response time, phases are compared across a row, so the
		// unit must not change under one of them.
		expect(formatPhaseMs(5_000)).toBe("5000");
		expect(formatPhaseMs(5_000)).not.toContain("s");
	});

	it("is a different job from formatResponseTime, which does switch unit", () => {
		expect(formatResponseTime(5_000)).toBe("5.00 s");
		expect(formatPhaseMs(5_000)).toBe("5000");
	});
});
