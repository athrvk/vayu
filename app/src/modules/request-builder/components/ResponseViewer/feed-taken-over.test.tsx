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
 * The pane of a request whose live feed another request's stream took over
 * (#3352). Its run kept going at the engine, so the pane says so rather than
 * reading "No response yet" as if nothing had been sent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { useExecutionEventsStore } from "@/stores";
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
	request: { id: "req_B" },
};
vi.mock("../../context", () => ({
	useRequestBuilderContext: () => state,
}));

const NOTICE = "Live feed taken over";

function showPaneFor(requestId: string) {
	state.request = { id: requestId };
	render(
		<TooltipProvider>
			<ResponseViewer />
		</TooltipProvider>
	);
}

function stream(requestId: string, runId: string) {
	const events = useExecutionEventsStore.getState();
	events.handOver(requestId);
	events.startStream({ requestId, runId, eventsUrl: `/runs/${runId}/events` });
}

/** B streams, then A's stream takes the feed over. */
function aTakesOverFromB() {
	act(() => {
		stream("req_B", "run_B");
		stream("req_A", "run_A");
	});
}

const restoredFrom = (runId: string): ResponseState => ({
	status: 200,
	statusText: "OK",
	headers: {},
	body: "",
	size: 0,
	time: 1,
	restoredFrom: { runId, at: "2026-11-01T00:00:00.000Z" },
});

beforeEach(() => {
	state.response = null;
	useExecutionEventsStore.getState().clear();
});
afterEach(cleanup);

describe("a live feed another request's stream took over", () => {
	it("is named in the pane of the request that lost it", () => {
		aTakesOverFromB();
		showPaneFor("req_B");

		// Mutation check: drop `{feedNotice}` from the empty-state branch and
		// B reads "No response yet" with no word about its run.
		expect(screen.getByText(NOTICE)).toBeInTheDocument();
		expect(screen.getByText(/kept running in Vayu's engine/)).toBeInTheDocument();
		expect(screen.getByText("No response yet")).toBeInTheDocument();
	});

	it("is named above an earlier run restored in its place", () => {
		aTakesOverFromB();
		state.response = restoredFrom("run_earlier");
		showPaneFor("req_B");

		expect(screen.getByText(NOTICE)).toBeInTheDocument();
	});

	it("is not named once the pane shows that run's own record", () => {
		aTakesOverFromB();
		// Mutation check: drop the `restoredFrom` comparison and the notice
		// sits over the very record it points the user to.
		state.response = restoredFrom("run_B");
		showPaneFor("req_B");

		expect(screen.queryByText(NOTICE)).toBeNull();
	});

	it("is not named in the pane of the request whose stream took it", () => {
		aTakesOverFromB();
		showPaneFor("req_A");

		expect(screen.queryByText(NOTICE)).toBeNull();
	});

	it("is not named when the request's own re-send replaced it", () => {
		// Mutation check: drop the own-request test in `displacedByHandOver` and
		// a re-send reports its own previous stream as taken over.
		act(() => {
			stream("req_B", "run_B");
			stream("req_B", "run_B2");
		});
		showPaneFor("req_B");

		expect(screen.queryByText(NOTICE)).toBeNull();
	});

	it("is not named when nothing was replaced", () => {
		showPaneFor("req_B");

		expect(screen.queryByText(NOTICE)).toBeNull();
		expect(screen.getByText("No response yet")).toBeInTheDocument();
	});

	it("goes away when the request's own Send supersedes it", () => {
		aTakesOverFromB();
		showPaneFor("req_B");
		expect(screen.getByText(NOTICE)).toBeInTheDocument();

		act(() => useExecutionEventsStore.getState().beginSend("req_B"));

		expect(screen.queryByText(NOTICE)).toBeNull();
	});
});
