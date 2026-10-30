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
 * The response pane says which elements Send left out (#3066): a check added
 * and sent before it was configured must never be read as one that passed.
 * Both response shapes a live send produces are drawn here - the finished
 * response, and the placeholder a stream shows before its run is stored.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { useExecutionEventsStore } from "@/stores";
import type { LeftOutElement } from "@/lib/elements";
import type { ResponseState } from "../../types";
import ResponseViewer from "./index";

// Monaco does not run under jsdom; the body panel is not what this asserts on.
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: ({ value }: { value?: string }) => <div data-testid="body-content">{value}</div>,
}));

const state: { response: ResponseState | null; isExecuting: boolean; request: { id: string } } = {
	response: null,
	isExecuting: false,
	request: { id: "req_1" },
};
vi.mock("../../context", () => ({
	useRequestBuilderContext: () => state,
}));

const NOT_RUN: LeftOutElement[] = [
	{
		element: { id: "el_1", kind: "assert.status", enabled: true, config: {} },
		needs: { missing: ["accepted codes or a range"], invalid: {} },
	},
];

const response = (overrides: Partial<ResponseState> = {}): ResponseState => ({
	status: 200,
	statusText: "OK",
	headers: { "content-type": "application/json" },
	body: "{}",
	bodyRaw: "{}",
	bodyType: "json",
	size: 2,
	time: 10,
	...overrides,
});

function openTestsTab() {
	render(
		<TooltipProvider>
			<ResponseViewer />
		</TooltipProvider>
	);
	// Radix selects on pointer-down, which a jsdom `click` never produces.
	const trigger = screen.getByRole("tab", { name: /tests/i });
	trigger.focus();
	fireEvent.mouseDown(trigger);
}

beforeEach(() => {
	state.response = null;
	useExecutionEventsStore.getState().clear();
});
afterEach(cleanup);

describe("the response's Elements section for elements Send left out", () => {
	it("lists each as not run, in place of the empty state", () => {
		state.response = response({ leftOutElements: NOT_RUN });
		openTestsTab();

		expect(screen.getByText("Not run - needs accepted codes or a range")).toBeInTheDocument();
		expect(screen.queryByText(/No tests ran/)).toBeNull();
	});

	it("lists them beside the outcomes the engine reported", () => {
		state.response = response({
			leftOutElements: NOT_RUN,
			elements: [{ id: "el_2", kind: "extract.json", outcome: "ok" }],
		});
		openTestsTab();

		expect(screen.getByText("ok")).toBeInTheDocument();
		expect(screen.getByText(/^Not run - needs/)).toBeInTheDocument();
	});

	it("says nothing about a response that left nothing out", () => {
		state.response = response({ testResults: [] });
		openTestsTab();

		expect(screen.queryByText(/Not run/)).toBeNull();
		expect(screen.getByText(/No tests ran/)).toBeInTheDocument();
	});

	it("draws them on a streaming send's placeholder, before its run is stored", () => {
		act(() => {
			const events = useExecutionEventsStore.getState();
			events.startStream({
				requestId: "req_1",
				runId: "run_1",
				eventsUrl: "/runs/run_1/events",
				leftOut: NOT_RUN,
			});
			events.noteOpen("run_1", { statusCode: 200, statusText: "OK", headers: {} });
		});
		openTestsTab();

		expect(screen.getByText("Not run - needs accepted codes or a range")).toBeInTheDocument();
	});
});
