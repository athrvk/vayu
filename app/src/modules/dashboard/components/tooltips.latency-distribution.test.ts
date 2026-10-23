/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the Latency distribution tooltip says the curve is drawn through (#2406).
 * "Sourced from Vayu's HdrHistogram" read as if the plot held every percentile;
 * `HdrPercentileChart` draws eight points, and the tail one (p99.9) is the one a
 * reader most wants to know is there.
 */

import { describe, it, expect } from "vitest";
import { TOOLTIPS } from "./tooltips";

describe("latencyDistribution tooltip", () => {
	const tip = TOOLTIPS.latencyDistribution;

	it("names the points the curve is drawn through, tail included", () => {
		expect(tip).toContain("min, p50, p75, p90, p95, p99, p99.9 and max");
	});

	it("no longer claims the plot is simply sourced from the histogram", () => {
		expect(tip).not.toContain("Sourced from Vayu's HdrHistogram");
	});
});
