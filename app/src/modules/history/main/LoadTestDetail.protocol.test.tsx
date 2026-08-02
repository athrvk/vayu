/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @vitest-environment jsdom
 */

/**
 * The protocol chip in LoadTestDetail's "Test config" row - the requested
 * protocol (`metadata.configuration.httpVersion`), not the negotiated one.
 * Separate file from historyDetail.characterization.test.tsx so a snapshot
 * refresh there never masks a regression here.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import type { ReactElement } from "react";
import LoadTestDetail from "./LoadTestDetail";
import type { RunReport } from "@/types";

function renderWithClient(ui: ReactElement) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<TooltipProvider>{ui}</TooltipProvider>
		</QueryClientProvider>
	);
}

function report(httpVersion: string | undefined, httpVersionDowngraded?: number): RunReport {
	return {
		metadata: {
			runId: "r",
			runType: "load",
			status: "completed",
			startTime: 0,
			endTime: 1000,
			requestUrl: "http://127.0.0.1:8080/x",
			requestMethod: "GET",
			configuration: { mode: "constant_rps", duration: "3s", targetRps: 200, httpVersion },
		},
		summary: {
			totalRequests: 600,
			successfulRequests: 600,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: 3,
			avgRps: 195,
			httpVersionDowngraded,
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
	};
}

describe("LoadTestDetail protocol chip", () => {
	it("shows the requested protocol's label from metadata.configuration", () => {
		renderWithClient(<LoadTestDetail report={report("http2")} runId="r" />);

		expect(screen.getByText("Protocol:")).toBeInTheDocument();
		// The label comes from the shared HTTP_VERSIONS list, not a local map.
		expect(screen.getByText("HTTP/2")).toBeInTheDocument();
	});

	it("labels a run that requested auto negotiation as Auto, not blank", () => {
		renderWithClient(<LoadTestDetail report={report("auto")} runId="r" />);

		expect(screen.getByText("Auto")).toBeInTheDocument();
	});

	it("omits the Protocol row when configuration carries no recognizable httpVersion", () => {
		renderWithClient(<LoadTestDetail report={report(undefined)} runId="r" />);

		expect(screen.queryByText("Protocol:")).not.toBeInTheDocument();
	});

	it("shows the Protocol row even when the run has neither mode nor comment", () => {
		// POST /runs accepts an iterations-only body with no `mode` key
		// (execution.cpp requires mode+duration OR iterations, not both), so the
		// "Test config" wrapper must not gate solely on mode/comment - a run with
		// neither can still have a protocol worth showing.
		const modeless = report("http2");
		delete modeless.metadata!.configuration!.mode;

		renderWithClient(<LoadTestDetail report={modeless} runId="r" />);

		expect(screen.getByText("Protocol:")).toBeInTheDocument();
		expect(screen.getByText("HTTP/2")).toBeInTheDocument();
	});

	/**
	 * The chip above is what the run *asked for*. On its own that is the exact
	 * mislabelling issue #215 describes: a run whose every request fell back to
	 * HTTP/1.1 still reads "HTTP/2" here, over latency and throughput measured on
	 * HTTP/1.1. The correction has to appear beside it, and only when it applies.
	 */
	it("marks the protocol as not negotiated when the run counted downgrades", () => {
		renderWithClient(<LoadTestDetail report={report("http2", 600)} runId="r" />);

		expect(screen.getByText("HTTP/2")).toBeInTheDocument();
		expect(screen.getByText(/not negotiated/i)).toBeInTheDocument();
	});

	it("stays quiet when every request got the protocol it asked for", () => {
		renderWithClient(<LoadTestDetail report={report("http2", 0)} runId="r" />);

		expect(screen.queryByText(/not negotiated/i)).not.toBeInTheDocument();
	});

	it("stays quiet for a run stored before the engine counted downgrades", () => {
		// `undefined` means nobody looked, not "none" - a warning invented for it
		// would be worse than the silence it replaces.
		renderWithClient(<LoadTestDetail report={report("http2", undefined)} runId="r" />);

		expect(screen.queryByText(/not negotiated/i)).not.toBeInTheDocument();
	});
});
