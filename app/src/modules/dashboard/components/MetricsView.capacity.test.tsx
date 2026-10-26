/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The live capacity card reads the frame's `capacity` block through
 * `MetricsView` (#2929), the wiring `CapacitySearchCard.test.tsx` cannot see.
 *
 * Mutation check: drop `liveCapacity` from the derived bundle and this reddens.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { DisplayMetrics } from "../types";
import MetricsView from "./MetricsView";

const frame: DisplayMetrics = {
	requests_completed: 500,
	requests_failed: 0,
	current_rps: 120,
	avg_latency_ms: 27,
	bytes_sent: 5000,
	bytes_received: 25000,
	capacity: { level: 33, levelElapsedMs: 3000, levelsJudged: 9 },
};

describe("MetricsView capacity card", () => {
	it("names the level the latest frame reports", () => {
		const { container } = render(
			<TooltipProvider>
				<MetricsView
					metrics={frame}
					historicalMetrics={[]}
					mode="capacity"
					concurrency={100}
				/>
			</TooltipProvider>
		);
		const out = container.textContent ?? "";
		expect(out).toContain("33virtual users");
		expect(out).toContain("9 levels judged");
	});
});
