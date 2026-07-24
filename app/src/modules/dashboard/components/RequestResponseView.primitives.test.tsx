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
 * Issue #60 guard: `RequestResponseView` - the load test's fourth response
 * inspector - must consume the shared response-viewer primitives.
 *
 * The load-bearing mutation check is the per-sample timing card. The file
 * imported `formatPhaseDuration` for the run-level averages and then fell back
 * to raw `.toFixed(1)` for the per-sample phase cards, so a 0.04ms cached DNS
 * lookup rendered as `0.0ms` - the only signal there is, rounded away. Revert
 * the cards to `.toFixed(1)` and the `0.04ms` assertion below fails.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import RequestResponseView from "./RequestResponseView";
import type { RunReport } from "@/types";

// ResponseBody mounts Monaco via CodeEditor; stub it so the expanded sample
// renders in jsdom.
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: () => <div data-testid="code-editor" />,
}));

function makeReport(): RunReport {
	return {
		summary: {
			totalRequests: 1,
			successfulRequests: 1,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: 1,
			avgRps: 1,
		},
		latency: { min: 5, max: 5, avg: 5, p50: 5, p90: 5, p95: 5, p99: 5 },
		statusCodes: {},
		errors: { total: 0, withDetails: 0, types: {} },
		results: [
			{
				timestamp: 1_700_000_000_000,
				statusCode: 200,
				statusText: "OK",
				latencyMs: 5,
				trace: {
					dnsMs: 0.04,
					connectMs: 12.5,
					headers: { "content-type": "application/json" },
					body: '{"ok":true}',
				},
			},
		],
	};
}

describe("RequestResponseView shared-primitive adoption (#60)", () => {
	it("renders the sample status through StatusCodeBadge", () => {
		render(<RequestResponseView report={makeReport()} />);
		const chip = screen.getByText("200 OK");
		// The chip variant, not the old semantic-variant Badge.
		expect(chip.className).toContain("text-primary-foreground");
	});

	it("formats per-sample phase durations with formatPhaseDuration, not raw toFixed(1)", () => {
		render(<RequestResponseView report={makeReport()} />);
		fireEvent.click(screen.getByRole("button", { name: /200 OK/ }));

		// 0.04ms keeps its significant digits through formatPhaseDuration; the
		// reverted `.toFixed(1)` collapses it to "0.0ms".
		expect(screen.getByText(/0\.04ms/)).toBeTruthy();
		expect(screen.queryByText(/0\.0ms/)).toBeNull();
	});

	it("renders response headers through the shared CompactHeadersViewer", () => {
		render(<RequestResponseView report={makeReport()} />);
		fireEvent.click(screen.getByRole("button", { name: /200 OK/ }));

		// CompactHeadersViewer renders each name as `key:`; the reverted
		// hand-rolled div map did too, so pin the shared surface it declares.
		const header = screen.getByText("content-type:");
		expect(header.closest(".surface-sunken")).not.toBeNull();
	});
});
