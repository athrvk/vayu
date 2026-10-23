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
 * What the live utilisation card is fed (#2821): the tick's trailing-window mean
 * on the wire, never the instant `current_concurrency` that reads 0 or N for
 * virtual users that wait in step, and the instant only for a tick that carries
 * no mean.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { DisplayMetrics } from "../types";
import MetricsView from "./MetricsView";

const base: DisplayMetrics = {
	requests_completed: 500,
	requests_failed: 0,
	current_rps: 120,
	avg_latency_ms: 27,
	bytes_sent: 5000,
	bytes_received: 25000,
};

function cardText(metrics: DisplayMetrics): string {
	const { container } = render(
		<TooltipProvider>
			<MetricsView
				metrics={metrics}
				historicalMetrics={[]}
				mode="constant_concurrency"
				concurrency={10}
			/>
		</TooltipProvider>
	);
	return container.textContent ?? "";
}

describe("MetricsView virtual user utilisation card", () => {
	it("shows the window's mean on the wire, not the instant of an aliased frame", () => {
		const out = cardText({ ...base, current_concurrency: 0, window_avg_in_flight: 4.2 });
		expect(out).toContain("4.2of 10 on the wire");
		expect(out).toContain("42.0% utilisation");
	});

	it("keeps a quiet window's measured 0 rather than the instant", () => {
		const out = cardText({ ...base, current_concurrency: 10, window_avg_in_flight: 0 });
		expect(out).toContain("0.0of 10 on the wire");
	});

	it.each([
		["no mean", undefined],
		["a null mean", null],
	])("falls back to the instant count of active users for a tick with %s", (_name, mean) => {
		const out = cardText({ ...base, current_concurrency: 6, window_avg_in_flight: mean });
		expect(out).toContain("6of 10 active");
		expect(out).not.toContain("on the wire");
	});
});
