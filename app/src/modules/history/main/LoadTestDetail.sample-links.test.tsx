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
 * The Overview's error rows open the Samples tab at an example (#2213).
 *
 * The tabs unmount when another is chosen, so the chip and the open row have to
 * outlive the Overview and the Samples tab alike; the pane owns them. The
 * assertions here are the wiring between the three: the row's click, the chip
 * it sets, the sample it opens, and that the opening happens once.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import LoadTestDetail from "./LoadTestDetail";
import type { RunReport } from "@/types";

vi.mock("@/queries/runs", () => ({
	useRunTimeSeriesQuery: () => ({
		data: undefined,
		isLoading: false,
		isFetchingNextPage: false,
		fetchNextPage: vi.fn(),
		hasNextPage: false,
	}),
	useRunMonitorSeriesQuery: () => ({
		data: undefined,
		isFetchingNextPage: false,
		fetchNextPage: vi.fn(),
		hasNextPage: false,
	}),
	useRunQuery: () => ({ data: undefined }),
	useBaselineRunQuery: () => ({ data: undefined }),
	useRunReportQuery: () => ({ data: undefined }),
	// Fetched once a row is open; these cases read the card's own state.
	useRunSamplesQuery: () => ({ data: undefined }),
}));

// In time order: #1 200, #2 404, #3 500, #4 timeout, #5 500 (a later 500).
// The latency is the number times ten, so a row reads off the screen as "30.0ms".
const REPORT = {
	metadata: {
		runId: "run_1",
		runType: "load",
		status: "completed",
		startTime: 0,
		endTime: 60_000,
		requestUrl: "https://api.test/ping",
		requestMethod: "GET",
	},
	summary: {
		totalRequests: 100,
		successfulRequests: 94,
		failedRequests: 6,
		httpErrorRequests: 5,
		noResponseRequests: 1,
		errorRate: 6,
		requestsPerSecond: 2,
		testDuration: 60,
	},
	latency: { min: 1, max: 9, avg: 2, p50: 2, p90: 3, p95: 4, p99: 5 },
	statusCodes: { "200": 94, "404": 1, "500": 4, "0": 1 },
	errors: {
		total: 6,
		withDetails: 1,
		types: { timeout: 1 },
		byStatusCode: { "404": 1, "500": 4, "0": 1 },
	},
	results: [
		{ timestamp: 5000, statusCode: 500, latencyMs: 50 },
		{ timestamp: 1000, statusCode: 200, latencyMs: 10 },
		{ timestamp: 3000, statusCode: 500, latencyMs: 30 },
		{ timestamp: 2000, statusCode: 404, latencyMs: 20 },
		{ timestamp: 4000, statusCode: 0, latencyMs: 40, trace: { error_type: "timeout" } },
	],
} as unknown as RunReport;

function renderDetail() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<TooltipProvider>
				<LoadTestDetail report={REPORT} runId="run_1" />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

/** Radix TabsTrigger activates on mousedown, not on a bare synthetic click. */
const openTab = (name: RegExp) => fireEvent.mouseDown(screen.getByRole("tab", { name }));
const tabIsActive = (name: RegExp) =>
	screen.getByRole("tab", { name }).getAttribute("aria-selected") === "true";
const chip = (name: string) => screen.getByRole("radio", { name: new RegExp(`^${name}\\s*\\d+$`) });
const sampleRow = (number: number) =>
	screen.getByText(`#${number}`).closest("button") as HTMLElement;
const openRows = () =>
	screen
		.queryAllByText(/^#\d+$/)
		.filter((el) => el.closest("button")?.getAttribute("aria-expanded") === "true")
		.map((el) => el.textContent);

describe("Overview error rows into the Samples tab", () => {
	it("lands on the first 500 sample, expanded, under the 5xx chip", () => {
		renderDetail();

		fireEvent.click(screen.getByRole("button", { name: /HTTP 500/ }));

		expect(tabIsActive(/sampled requests/i)).toBe(true);
		expect(chip("5xx")).toHaveAttribute("aria-checked", "true");
		// #3 is the first 500 in time, though the report lists another one first.
		expect(openRows()).toEqual(["#3"]);
		expect(screen.queryByText("#2")).toBeNull();
	});

	it("opens the sample of an error type under the Errors chip", () => {
		renderDetail();

		fireEvent.click(screen.getByRole("button", { name: /Timeout/ }));

		expect(chip("Errors")).toHaveAttribute("aria-checked", "true");
		expect(openRows()).toEqual(["#4"]);
	});

	it("lands a 4xx and a no-response row on their own chips", () => {
		renderDetail();
		fireEvent.click(screen.getByRole("button", { name: /HTTP 404/ }));
		expect(chip("4xx")).toHaveAttribute("aria-checked", "true");
		expect(openRows()).toEqual(["#2"]);

		openTab(/overview/i);
		fireEvent.click(screen.getByRole("button", { name: /No response \(status 0\)/ }));
		expect(chip("No response")).toHaveAttribute("aria-checked", "true");
		expect(openRows()).toEqual(["#4"]);
	});

	it("opens the row once: going back to the tab does not re-expand it", () => {
		renderDetail();
		fireEvent.click(screen.getByRole("button", { name: /HTTP 500/ }));
		expect(openRows()).toEqual(["#3"]);

		openTab(/overview/i);
		expect(tabIsActive(/overview/i)).toBe(true);
		openTab(/sampled requests/i);

		expect(tabIsActive(/sampled requests/i)).toBe(true);
		expect(openRows()).toEqual([]);
		// The chip is the user's, and stays where it was left.
		expect(chip("5xx")).toHaveAttribute("aria-checked", "true");
	});

	it("keeps the chip the user picked after the link", () => {
		renderDetail();
		fireEvent.click(screen.getByRole("button", { name: /HTTP 500/ }));
		fireEvent.click(chip("4xx"));

		openTab(/overview/i);
		openTab(/sampled requests/i);

		expect(chip("4xx")).toHaveAttribute("aria-checked", "true");
	});

	it("opens the Samples tab on All when reached by the tab itself", () => {
		renderDetail();

		openTab(/sampled requests/i);

		expect(chip("All")).toHaveAttribute("aria-checked", "true");
		expect(openRows()).toEqual([]);
		expect(sampleRow(1)).toBeTruthy();
	});
});
