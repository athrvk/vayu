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
 * The response-only view for a design run with no request left to open.
 *
 * The point of this component is that it is *not* a viewer - it is the request
 * builder's own response pane with a stub context under it. So the tests worth
 * having are the ones that would fail if it quietly grew back into the 180-line
 * duplicate it replaced: that the builder's tabs are the ones on screen, and
 * that a stored run reaches them intact.
 *
 * The old viewer showed the sent body nowhere at all - it built `requestData.body`
 * from the trace and then rendered a mode that reads only headers - so the Raw
 * tab below is a capability this view has and its predecessor did not.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import DesignRunResponse from "./DesignRunResponse";
import type { RunReport } from "@/types";

vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: ({ value }: { value: string }) => <pre data-testid="code-editor">{value}</pre>,
}));

function report(result: NonNullable<RunReport["results"]>[number] | undefined): RunReport {
	return {
		metadata: {
			runId: "run-1",
			runType: "design",
			status: "completed",
			startTime: 1_750_000_000_000,
			endTime: 1_750_000_000_300,
		},
		summary: {
			totalRequests: 1,
			successfulRequests: 1,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: 0.3,
			avgRps: 3,
		},
		latency: { min: 254, max: 254, avg: 254, p50: 254, p90: 254, p95: 254, p99: 254 },
		statusCodes: { "200": 1 },
		errors: { total: 0, withDetails: 0, types: {} },
		results: result ? [result] : [],
	};
}

const SUCCESS = {
	timestamp: 1_750_000_000_000,
	statusCode: 200,
	statusText: "OK",
	latencyMs: 254,
	trace: {
		request: {
			method: "POST",
			url: "https://api.example.test/users",
			headers: { "content-type": "application/json" },
			body: '{"name":"ada"}',
		},
		response: { headers: { "content-type": "application/json" }, body: '{"ok":true}' },
		dnsMs: 4.2,
		firstByteMs: 160.4,
	},
};

function show(result: NonNullable<RunReport["results"]>[number] | undefined) {
	return render(
		<TooltipProvider>
			<DesignRunResponse report={report(result)} runId="run-1" />
		</TooltipProvider>
	);
}

describe("an orphaned design run", () => {
	it("renders the builder's response pane, tabs and all", () => {
		show(SUCCESS);

		// Timing and Raw are conditional in that pane and were separate hand-rolled
		// renderers in the viewer this replaces.
		for (const tab of ["Body", "Headers", "Cookies", "Timing", "Raw"]) {
			expect(screen.getByRole("tab", { name: new RegExp(`^${tab}`) })).toBeTruthy();
		}
	});

	it("says how old the run is, since there is no Send here to make it current", () => {
		show(SUCCESS);

		expect(screen.getByText(/from run - /i)).toBeTruthy();
	});

	it("shows the request body that was actually sent", () => {
		show(SUCCESS);

		// Radix activates on mousedown, not on a bare synthetic click.
		const rawTab = screen.getByRole("tab", { name: /^Raw/ });
		fireEvent.mouseDown(rawTab);
		fireEvent.click(rawTab);

		// The rebuilt wire message, which is the only place in the app the sent
		// body of a stored run is reachable.
		const raw = screen.getByRole("tabpanel").textContent ?? "";
		expect(raw).toContain("POST /users HTTP/1.1");
		expect(raw).toContain('{"name":"ada"}');
	});

	it("shows a failure that never reached a server", () => {
		show({
			timestamp: 1_750_000_000_000,
			statusCode: 0,
			latencyMs: 12,
			error: "Could not connect to host",
			trace: {
				request: { method: "GET", url: "https://nope.example.test/", headers: {} },
				error_type: "CONNECTION_FAILED",
				error_message: "Could not connect to host",
			},
		});

		expect(screen.getByText(/could not get a response/i)).toBeTruthy();
		expect(screen.getByText(/could not connect to host/i)).toBeTruthy();
		// The error-code hint is the builder pane's, and is why mapping the run to
		// the live status-0 shape was worth doing.
		expect(screen.getByText(/ensure the target server is running/i)).toBeTruthy();
	});

	it("does not invite the user to press Send when the run recorded nothing", () => {
		// That is the builder pane's empty state, and this tab has no Send.
		show(undefined);

		expect(screen.queryByText(/no response yet/i)).toBeNull();
		expect(screen.getByText(/nothing was recorded for this run/i)).toBeTruthy();
	});
});
