/**
 * @vitest-environment jsdom
 */
/**
 * Characterization snapshots for the mode-adaptive history detail. Render
 * LoadTestDetail with a fixed RunReport per mode; lock the DOM so future
 * refactors stay byte-identical. The default (Overview) tab renders the
 * mode-adaptive HeroRow + ModeStatsRow without the query-backed Performance tab.
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import LoadTestDetail from "../LoadTestDetail";
import type { RunReport } from "@/types";

/**
 * LoadTestDetail now fetches the per-tick time-series (for the breakpoint /
 * percentile surfaces), so it needs a QueryClient. The default (Overview) tab
 * snapshotted here doesn't depend on that data - the query stays in its loading
 * state during the synchronous render - so the locked DOM is unaffected.
 */
function renderWithClient(ui: ReactElement) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function report(mode: string, cfg: Record<string, unknown>): RunReport {
	return {
		metadata: {
			runId: "r",
			runType: "load",
			status: "completed",
			startTime: 0,
			endTime: 1000,
			requestUrl: "http://127.0.0.1:8080/x",
			requestMethod: "GET",
			configuration: { mode, duration: "3s", ...cfg },
		},
		summary: {
			totalRequests: 600,
			successfulRequests: 600,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: 3,
			avgRps: 195,
			throughput: 190,
			sendRate: 198,
			testDuration: 3,
			setupOverhead: 0.03,
			peakConcurrency: 20,
			droppedRequests: 0,
			avgQueueWaitMs: 1.0,
			bytesSent: 1000,
			bytesReceived: 2000,
			throughputBytesPerSec: 666,
		},
		latency: {
			min: 100,
			max: 130,
			avg: 101,
			median: 101,
			p50: 101,
			p75: 101,
			p90: 102,
			p95: 103,
			p99: 108,
			p999: 120,
		},
		statusCodes: { "200": 600 },
		errors: { total: 0, withDetails: 0, types: {} },
		rateControl: { targetRps: 200, actualRps: 195, achievement: 97.5 },
	};
}

describe("LoadTestDetail (mode-adaptive)", () => {
	it("constant_rps", () => {
		const { container } = renderWithClient(
			<LoadTestDetail report={report("constant_rps", { targetRps: 200 })} runId="r" />
		);
		expect(container.innerHTML).toMatchSnapshot();
	});
	it("constant_concurrency", () => {
		const { container } = renderWithClient(
			<LoadTestDetail
				report={report("constant_concurrency", { concurrency: 50 })}
				runId="r"
			/>
		);
		expect(container.innerHTML).toMatchSnapshot();
	});
	it("iterations", () => {
		const { container } = renderWithClient(
			<LoadTestDetail report={report("iterations", { concurrency: 20 })} runId="r" />
		);
		expect(container.innerHTML).toMatchSnapshot();
	});
	it("ramp_up", () => {
		const { container } = renderWithClient(
			<LoadTestDetail
				report={report("ramp_up", {
					concurrency: 50,
					startConcurrency: 1,
					rampUpDuration: "2s",
				})}
				runId="r"
			/>
		);
		expect(container.innerHTML).toMatchSnapshot();
	});
});
