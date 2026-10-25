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
 * The Dropped / Skipped requests card replaces Rate fidelity by one rule, and
 * a run must read the same while it is live (`MetricsView`'s derived bundle)
 * and once it is stored (`reportToDerived`). Both call `shouldShowDropped`;
 * this proves the two bundles still agree on every input that matters, and
 * that a run that only skipped (#2911) is not left on the Rate fidelity card.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RunReport } from "@/types";
import type { DisplayMetrics } from "../types";
import { reportToDerived } from "../utils/reportToDerived";
import MetricsView from "./MetricsView";

const TARGET_RPS = 500;

const liveMetrics: DisplayMetrics = {
	requests_completed: 900,
	requests_failed: 0,
	current_rps: 480,
	avg_latency_ms: 20,
	bytes_sent: 0,
	bytes_received: 0,
};

function storedReport(
	mode: string | undefined,
	counts: { dropped: number; skipped: number }
): RunReport {
	return {
		metadata: {
			runId: "r1",
			runType: "load",
			status: "completed",
			startTime: 0,
			endTime: 1000,
			requestUrl: "http://x",
			requestMethod: "GET",
			configuration: { mode, duration: "3s", targetRps: TARGET_RPS },
		},
		summary: {
			totalRequests: 900,
			successfulRequests: 900,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: 3,
			avgRps: 300,
			droppedRequests: counts.dropped,
			skippedRequests: counts.skipped,
			stalledMs: counts.skipped * 2,
		},
		latency: { min: 1, max: 9, avg: 5, p50: 5, p90: 8, p95: 9, p99: 9, p999: 9 },
		statusCodes: { "200": 900 },
		errors: { total: 0, withDetails: 0, types: {} },
	};
}

const SWAPPED_CARD = /^(Dropped|Skipped) requests$/;

interface Case {
	name: string;
	mode: string | undefined;
	dropped: number;
	skipped: number;
	card: "Dropped requests" | "Skipped requests" | null;
}

const CASES: Case[] = [
	{ name: "no losses", mode: "constant_rps", dropped: 0, skipped: 0, card: null },
	{ name: "drops only", mode: "constant_rps", dropped: 5, skipped: 0, card: "Dropped requests" },
	{ name: "skips only", mode: "constant_rps", dropped: 0, skipped: 30, card: "Skipped requests" },
	{
		name: "drops and skips",
		mode: "constant_rps",
		dropped: 5,
		skipped: 30,
		card: "Dropped requests",
	},
	{
		name: "skips on a closed loop",
		mode: "constant_concurrency",
		dropped: 0,
		skipped: 30,
		card: null,
	},
	{
		name: "skips with no mode named",
		mode: undefined,
		dropped: 0,
		skipped: 30,
		card: "Skipped requests",
	},
];

describe("the dropped-requests gate, live and stored", () => {
	it.each(CASES)(
		"$name: both bundles choose the same card",
		({ mode, dropped, skipped, card }) => {
			const stored = reportToDerived(storedReport(mode, { dropped, skipped }));

			render(
				<TooltipProvider>
					<MetricsView
						metrics={{
							...liveMetrics,
							dropped_requests: dropped,
							skipped_requests: skipped,
						}}
						historicalMetrics={[]}
						mode={mode}
						targetRps={TARGET_RPS}
					/>
				</TooltipProvider>
			);

			expect(stored.showDropped).toBe(card !== null);
			const live = screen.queryByText(SWAPPED_CARD);
			expect(live?.textContent ?? null).toBe(card);
		}
	);

	it("states the skip count and the stall on the live card", () => {
		render(
			<TooltipProvider>
				<MetricsView
					metrics={{ ...liveMetrics, skipped_requests: 30, stalled_ms: 60 }}
					historicalMetrics={[]}
					mode="constant_rps"
					targetRps={TARGET_RPS}
				/>
			</TooltipProvider>
		);

		expect(
			screen.getByText(/30 requests skipped: the load generator stalled for 60ms/)
		).toBeTruthy();
		expect(screen.queryByText(/Server saturating/)).toBeNull();
	});
});
