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
 * The dashboard's sampled list is the second surface that shows a captured
 * exchange, and issue #657's events node reaches it the same way the history
 * card's does - through the shared `ResponseEvents`.
 *
 * Wiring guard, not a rendering one: the component's own behaviour is covered
 * where it lives. What this pins is that a streamed sample's list is read here
 * at all, since the failure mode is the one CLAUDE.md names most often - a
 * field the engine writes and one of two readers forgets.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import RequestResponseView from "./RequestResponseView";
import { withQueryClient } from "@/test/query-wrapper";
import type { RunReport, RunSamplesResponse } from "@/types";

vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: () => <div data-testid="code-editor" />,
}));

const getRunSamples = vi.fn<() => Promise<RunSamplesResponse>>();
vi.mock("@/services/api", () => ({
	apiService: { getRunSamples: (...args: unknown[]) => getRunSamples(...(args as [])) },
}));

const REPORT: RunReport = {
	metadata: {
		runId: "r1",
		runType: "load",
		status: "completed",
		startTime: 0,
		endTime: 1_000,
		configuration: { mode: "constant_rps", duration: "1s", targetRps: 1 },
	},
	summary: {
		totalRequests: 1,
		successfulRequests: 1,
		failedRequests: 0,
		errorRate: 0,
		totalDurationSeconds: 1,
		avgRps: 1,
	},
	latency: { min: 1, max: 1, avg: 1, p50: 1, p90: 1, p95: 1, p99: 1 },
	statusCodes: {},
	errors: { total: 0, withDetails: 0, types: {} },
	results: [
		{
			id: 5,
			timestamp: 1_700_000_000_000,
			statusCode: 200,
			statusText: "OK",
			latencyMs: 2,
		},
	],
};

function samplesPage(withEvents: boolean): RunSamplesResponse {
	return {
		data: [
			{
				resultId: 5,
				response: {
					headers: { "content-type": "text/event-stream" },
					body: "data: hello\n\n",
					bodyBytes: 13,
					contentType: "text/event-stream",
					events: withEvents
						? {
								items: [{ event: "token", data: "hello" }],
								totalEvents: 1,
								eventsTruncated: false,
							}
						: undefined,
				},
			},
		],
		pagination: { total: 1, limit: 50, offset: 0, hasMore: false, returned: 1 },
	};
}

const renderAndExpand = async () => {
	render(
		withQueryClient(
			<TooltipProvider>
				<RequestResponseView report={REPORT} />
			</TooltipProvider>
		)
	);
	// The captured exchange is fetched only once a row is open, which is also
	// the only state in which any of this renders.
	fireEvent.click(screen.getByRole("button", { expanded: false }));
};

describe("RequestResponseView captured stream events", () => {
	it("renders a streamed sample's events beside its body", async () => {
		getRunSamples.mockResolvedValue(samplesPage(true));
		await renderAndExpand();

		await waitFor(() => expect(screen.getByText("Events")).toBeInTheDocument());
		expect(screen.getByText("token")).toBeInTheDocument();
		expect(screen.getByText("1 event")).toBeInTheDocument();
		// The raw bytes stay: the parsed list is a reading aid, not a
		// replacement for what came back.
		expect(screen.getByText("Response Body")).toBeInTheDocument();
	});

	it("shows no events block for a capture that did not stream", async () => {
		getRunSamples.mockResolvedValue(samplesPage(false));
		await renderAndExpand();

		await waitFor(() => expect(screen.getByText("Response Body")).toBeInTheDocument());
		expect(screen.queryByText("Events")).not.toBeInTheDocument();
	});
});
