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
 * LoadTestDetail's "Test config" box names the data set a run bound (#1940),
 * under its "Details" disclosure.
 * The rows are never stored; the report's `dataRowCount` is the whole record.
 *
 * Since #2051 the row also names the file (`2 rows · users.csv`); the hash
 * is never drawn.
 *
 * Mutation check: remove the `Data:` entry from `LoadTestDetail` and the
 * shown-count cases redden; drop the file-name suffix and the named case reddens.
 */
import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import LoadTestDetail from "./LoadTestDetail";
import { CONCURRENCY_LABEL } from "@/constants/load-test-modes";
import type { RunReport } from "@/types";

function report(
	dataRowCount: number | undefined,
	file: { dataFileName?: string; dataFileHash?: string; dataFileCastNumbers?: boolean } = {},
	config: { targetRps?: number; concurrency?: number } = {}
): RunReport {
	return {
		metadata: {
			runId: "r",
			runType: "load",
			status: "completed",
			startTime: 0,
			endTime: 1000,
			requestUrl: "http://127.0.0.1:8080/x",
			requestMethod: "GET",
			configuration: {
				mode: "constant_rps",
				duration: "3s",
				targetRps: 200,
				dataRowCount,
				...file,
				...config,
			},
		},
		summary: {
			totalRequests: 600,
			successfulRequests: 600,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: 3,
			avgRps: 195,
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

function mount(
	dataRowCount: number | undefined,
	file: { dataFileName?: string; dataFileHash?: string; dataFileCastNumbers?: boolean } = {},
	config: { targetRps?: number; concurrency?: number } = {}
) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const view = render(
		<QueryClientProvider client={qc}>
			<TooltipProvider>
				<LoadTestDetail report={report(dataRowCount, file, config)} runId="r" />
			</TooltipProvider>
		</QueryClientProvider>
	);
	// The fixture always carries a target rate, so the disclosure is always there.
	fireEvent.click(screen.getByRole("button", { name: "Details" }));
	return view;
}

describe("LoadTestDetail data row count", () => {
	it("shows how many rows the run bound", () => {
		mount(12);

		expect(screen.getByText("Data:")).toBeInTheDocument();
		expect(screen.getByText("12 rows")).toBeInTheDocument();
	});

	it("names the file beside the count", () => {
		mount(2, { dataFileName: "users.csv", dataFileHash: "a".repeat(64) });

		expect(screen.getByText("2 rows · users.csv")).toBeInTheDocument();
		expect(screen.queryByText(/a{64}/)).toBeNull();
	});

	// Mutation check: print `config.dataFileName` bare again and this fails (#2540).
	it("says when the file's numbers were read as numbers", () => {
		mount(2, { dataFileName: "plans.csv", dataFileCastNumbers: true });

		expect(
			screen.getByText("2 rows · plans.csv (numbers read as numbers)")
		).toBeInTheDocument();
	});

	it("keeps the bare count for a run recorded without a file name", () => {
		mount(2);

		expect(screen.getByText("2 rows")).toBeInTheDocument();
	});

	it("uses the singular for one row", () => {
		mount(1);

		expect(screen.getByText("1 row")).toBeInTheDocument();
	});

	it.each([
		["absent", undefined],
		["zero", 0],
	])("omits the entry when the count is %s", (_label, count) => {
		mount(count);

		expect(screen.queryByText("Data:")).toBeNull();
	});
});

describe("LoadTestDetail config box number grouping", () => {
	it("groups thousands in the target rate, the concurrency and the row count", () => {
		// Mutation check: put a raw `{config.targetRps}`, `{config.concurrency}`
		// or `{config.dataRowCount}` interpolation back and the matching
		// assertion reddens.
		mount(34567, {}, { targetRps: 12345, concurrency: 23456 });

		// The rate card repeats the target, so read each value off its own label.
		const valueOf = (label: string) => screen.getByText(label).nextElementSibling?.textContent;
		expect(valueOf("Target RPS:")).toBe("12,345");
		expect(valueOf(`${CONCURRENCY_LABEL}:`)).toBe("23,456");
		expect(screen.getByText("34,567 rows")).toBeInTheDocument();
	});
});
