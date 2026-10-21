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
 * The live detector reads one tick a second (#2589). `detectAnomalies.test.ts`
 * pins what `wholeSecondTicks` makes of a live stream; what this pins is that
 * MetricsView hands the detector that series and not the raw buffer, whose
 * frames between gates are a tenth of a second each.
 */

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { DisplayMetrics } from "../types";
import type { LoadTestMetrics } from "@/types";

const detected = vi.hoisted(() => ({ series: [] as LoadTestMetrics[][] }));

vi.mock("../utils/detectAnomalies", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../utils/detectAnomalies")>();
	return {
		...actual,
		createAnomalyDetector: () => {
			const detector = actual.createAnomalyDetector();
			return {
				detect: (history: LoadTestMetrics[]) => {
					detected.series.push(history);
					return detector.detect(history);
				},
			};
		},
	};
});

const MetricsView = (await import("./MetricsView")).default;

/** Three seconds of 100 ms frames, each tenth one a gate. */
function liveFrames(): LoadTestMetrics[] {
	return Array.from({ length: 30 }, (_, i) => {
		const gate = (i + 1) % 10 === 0;
		return {
			timestamp: i * 100,
			elapsed_seconds: (i + 1) / 10,
			requests_completed: (i + 1) * 50,
			requests_failed: 0,
			current_rps: 500,
			current_concurrency: 50,
			latency_p50_ms: 20,
			latency_p95_ms: 40,
			latency_p99_ms: 80,
			avg_latency_ms: 25,
			bytes_sent: 0,
			bytes_received: 0,
			live: true,
			...(gate
				? { second_samples: 500, second_p50_ms: 20, second_p95_ms: 40, second_p99_ms: 90 }
				: {}),
		};
	});
}

describe("MetricsView anomaly detection", () => {
	it("hands the detector the gate frames, not the frames between them", () => {
		const frames = liveFrames();
		render(
			<TooltipProvider>
				<MetricsView
					metrics={{ requests_completed: 1500, requests_failed: 0 } as DisplayMetrics}
					historicalMetrics={frames}
					mode="constant_concurrency"
					concurrency={50}
				/>
			</TooltipProvider>
		);

		expect(detected.series.length).toBeGreaterThan(0);
		const series = detected.series[detected.series.length - 1];
		expect(series.map((m) => m.elapsed_seconds)).toEqual([1, 2, 3]);
		expect(series.every((m) => m.second_samples === 500)).toBe(true);
	});
});
