/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import type { LoadTestMetrics } from "@/types";
import { CustomMetricsChart } from "./index";

function tick(partial: Partial<LoadTestMetrics>): LoadTestMetrics {
	return {
		timestamp: 0,
		elapsed_seconds: 0,
		requests_completed: 0,
		requests_failed: 0,
		current_rps: 0,
		current_concurrency: 0,
		latency_p50_ms: 0,
		latency_p95_ms: 0,
		latency_p99_ms: 0,
		avg_latency_ms: 0,
		bytes_sent: 0,
		bytes_received: 0,
		...partial,
	};
}

describe("CustomMetricsChart", () => {
	// Same "no card, not an empty one" rule ServerVitalsChart follows for a run
	// that scraped nothing.
	it("renders nothing when no tick carries custom_metrics", () => {
		const history = [tick({ elapsed_seconds: 0 }), tick({ elapsed_seconds: 1 })];
		const { container } = render(<CustomMetricsChart history={history} />);
		expect(container.innerHTML).toBe("");
	});

	it("renders nothing below 2 buckets, same guard every time-series chart uses", () => {
		const history = [
			tick({
				elapsed_seconds: 0,
				custom_metrics: { orders: { type: "counter", count: 1, value: 5 } },
			}),
		];
		const { container } = render(<CustomMetricsChart history={history} />);
		expect(container.innerHTML).toBe("");
	});

	it("mounts one series per declared name, a trend and a counter/rate mixed, without throwing", () => {
		const history = Array.from({ length: 4 }, (_, i) =>
			tick({
				elapsed_seconds: i,
				custom_metrics: {
					latency: { type: "trend", count: i + 1, p50: 10 + i, p95: 40 + i, p99: 80 + i },
					orders: { type: "counter", count: i + 1, value: i * 3 },
					cacheHitRate: { type: "rate", count: i + 1, value: 50 + i },
				},
			})
		);
		const { container, unmount } = render(<CustomMetricsChart history={history} />);
		// Not the "nothing to draw" empty case - a chart actually mounted.
		expect(container.innerHTML).not.toBe("");
		expect(container.querySelector("canvas")).not.toBeNull();
		unmount();
	});

	// A gap in one series (a metric that hadn't fired yet) must not stop the
	// others from drawing, or keep the chart from mounting at all.
	it("mounts when one declared name is absent from an earlier tick", () => {
		const history = [
			tick({
				elapsed_seconds: 0,
				custom_metrics: { orders: { type: "counter", count: 1, value: 5 } },
			}),
			tick({
				elapsed_seconds: 1,
				custom_metrics: {
					orders: { type: "counter", count: 2, value: 8 },
					latency: { type: "trend", count: 1, p95: 30 },
				},
			}),
		];
		const { container, unmount } = render(<CustomMetricsChart history={history} />);
		expect(container.innerHTML).not.toBe("");
		unmount();
	});
});
