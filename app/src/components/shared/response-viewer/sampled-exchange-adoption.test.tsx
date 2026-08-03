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
 * Issue #76 guard: both sampled-exchange views render through the shared shell.
 *
 * The dashboard's live sample list and the history detail's stored one show the
 * same thing - a sampled HTTP exchange, expandable - and were two components.
 * #60 gave them the same per-concern primitives, which moved the drift up into
 * the shells rather than removing it: each still owned its summary row, its
 * expansion chrome and its section order, so a fix to one did not reach the
 * other.
 *
 * `SampledExchange` is replaced with a sentinel here, so a view that goes back
 * to a hand-rolled row fails - which asserting on rendered markup would not,
 * since a hand-rolled row can render the same status chip and latency. The
 * props each view passes are echoed into the DOM, because "renders the shell"
 * is only half of it: the live/stored difference has to stay in the caller.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import type { RunReport } from "@/types";
import { withQueryClient } from "@/test/query-wrapper";

vi.mock("@/components/shared/response-viewer/SampledExchange", () => ({
	SampledExchange: (props: Record<string, unknown>) => (
		<div
			data-testid="sampled-exchange"
			data-status={String(props.statusCode)}
			data-label={String(props.label)}
			data-timestamp={String(props.timestamp)}
			data-phases={String((props.phases as unknown[] | undefined)?.length ?? 0)}
		/>
	),
}));

// The history card's response path mounts Monaco via CodeEditor.
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: () => <div data-testid="code-editor" />,
}));

const trace = { dnsMs: 1, connectMs: 2, tlsMs: 3, firstByteMs: 4, downloadMs: 5 };

describe("both sampled views render through SampledExchange (#76)", () => {
	it("the dashboard's live sample list", async () => {
		const RequestResponseView = (
			await import("@/modules/dashboard/components/RequestResponseView")
		).default;

		const report = {
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
					timestamp: Date.UTC(2024, 0, 1, 10, 11, 12, 345),
					statusCode: 503,
					statusText: "Service Unavailable",
					latencyMs: 5,
					trace: { ...trace, request_number: 7 },
				},
			],
		} as unknown as RunReport;

		render(withQueryClient(<RequestResponseView report={report} />));

		const row = screen.getByTestId("sampled-exchange");
		expect(row).toHaveAttribute("data-status", "503");
		// The engine's request number, not the array index.
		expect(row).toHaveAttribute("data-label", "7");
		expect(row).toHaveAttribute("data-phases", "5");
		// A live row places a sample inside a run that is seconds old, so it
		// keeps milliseconds. Losing that to the history card's locale date is
		// exactly the drift a shared shell could otherwise introduce.
		expect(row.getAttribute("data-timestamp")).toMatch(/\d{2}:\d{2}:\d{2}\.345/);
	});

	it("the history detail's stored sample card", async () => {
		const SampleRequestCard = (
			await import("@/modules/history/main/components/SampleRequestCard")
		).default;

		render(
			<SampleRequestCard
				sample={
					{
						timestamp: Date.UTC(2024, 0, 1, 10, 11, 12, 345),
						statusCode: 200,
						latencyMs: 5,
						trace,
					} as unknown as import("@/modules/history/types").SampleResult
				}
				index={6}
				isExpanded
				onToggle={() => {}}
			/>
		);

		const row = screen.getByTestId("sampled-exchange");
		expect(row).toHaveAttribute("data-status", "200");
		// One-based, and the history side has no engine request number to use.
		expect(row).toHaveAttribute("data-label", "7");
		expect(row).toHaveAttribute("data-phases", "5");
		// A stored row dates a run rather than placing a moment inside one.
		expect(row.getAttribute("data-timestamp")).not.toMatch(/\.345/);
	});
});
