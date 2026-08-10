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
 * The data row a sampled load result bound (issue #449).
 *
 * A scenario load run stores no per-step `results` rows, so `trace.dataRowIndex`
 * is the only thing that says which row of the file produced a sample - and for
 * a failure it is the row the reader has to go and open. The engine writes it;
 * this is the layer that has to read it, which is exactly the wiring this
 * codebase has lost nine times.
 *
 * Mutation-check: delete the `trace.dataRowIndex` block in
 * RequestResponseView.tsx and the first case fails.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import RequestResponseView from "./RequestResponseView";
import { withQueryClient } from "@/test/query-wrapper";
import type { RunReport, RunResultTrace } from "@/types";

// ResponseBody mounts Monaco via CodeEditor; stub it so an expanded sample
// renders in jsdom.
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: () => <div data-testid="code-editor" />,
}));

function reportWithTrace(trace: RunResultTrace): RunReport {
	return {
		summary: {
			totalRequests: 1,
			successfulRequests: 0,
			failedRequests: 1,
			errorRate: 100,
			totalDurationSeconds: 1,
			avgRps: 1,
		},
		latency: { min: 5, max: 5, avg: 5, p50: 5, p90: 5, p95: 5, p99: 5 },
		statusCodes: {},
		errors: { total: 1, withDetails: 1, types: {} },
		results: [
			{
				timestamp: 1_700_000_000_000,
				statusCode: 500,
				latencyMs: 12,
				error: "server error",
				trace,
			},
		],
	};
}

describe("RequestResponseView renders a sample's data row (#449)", () => {
	it("names the row an expanded sample was bound to", () => {
		render(
			withQueryClient(
				<RequestResponseView report={reportWithTrace({ dataRowIndex: 7, totalMs: 12 })} />
			)
		);

		fireEvent.click(screen.getByRole("button", { name: /server error/ }));

		expect(screen.getByText(/Data Row:/)).toBeTruthy();
		expect(screen.getByText("7")).toBeTruthy();
	});

	it("shows row 0 rather than treating it as absent", () => {
		// The reason the engine omits the key instead of writing a default: a
		// falsy check here would hide the first row of every data file.
		render(
			withQueryClient(
				<RequestResponseView report={reportWithTrace({ dataRowIndex: 0, totalMs: 12 })} />
			)
		);

		fireEvent.click(screen.getByRole("button", { name: /server error/ }));

		expect(screen.getByText(/Data Row:/)).toBeTruthy();
		expect(screen.getByText("0")).toBeTruthy();
	});

	it("says nothing about rows for a run that had none", () => {
		render(withQueryClient(<RequestResponseView report={reportWithTrace({ totalMs: 12 })} />));

		fireEvent.click(screen.getByRole("button", { name: /server error/ }));

		expect(screen.queryByText(/Data Row:/)).toBeNull();
	});
});
