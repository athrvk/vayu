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
 * The Events tab (issue #574).
 *
 * Three things here are only true if they are rendered, and each of them is a
 * way the pane can lie:
 *
 * - **The tab is always there.** `tab-strand.test.tsx` guards the seven that
 *   came before it and the reason (issue #59: a conditional tab strands the
 *   selection). An eighth that came and went would put that bug straight back.
 * - **The two sources hand off.** While the stream runs the rows come from the
 *   store; once it ends the run's stored trace is the record. A pane that kept
 *   reading the store after the swap would show a list missing whatever the
 *   relay's ring had already dropped, with no marker saying so.
 * - **Every disclosure is in band.** A capped list of 100 out of 4,000 and a
 *   complete list of 100 must not look the same, and a stream that hit a limit
 *   must not look like one the server closed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { useExecutionEventsStore } from "@/stores";
import type { ResponseState } from "../../types";
import type { StreamEvent } from "@/types";

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

const { default: ResponseViewer } = await import("./index");

const okResponse = (overrides: Partial<ResponseState> = {}): ResponseState => ({
	status: 200,
	statusText: "OK",
	headers: { "content-type": "text/event-stream" },
	body: "",
	bodyRaw: "",
	bodyType: "text",
	size: 0,
	time: 12,
	...overrides,
});

const event = (data: string, name = "message"): StreamEvent => ({ event: name, data });

function renderViewer() {
	return render(
		<TooltipProvider>
			<ResponseViewer />
		</TooltipProvider>
	);
}

/**
 * Bring the Events panel forward - the strip opens on Body.
 *
 * `mouseDown`, not `click`: Radix's tab trigger selects on pointer-down, and a
 * jsdom `click` never produces one (same helper as `tab-strand.test.tsx`).
 */
function openEventsTab() {
	const trigger = screen.getByRole("tab", { name: /events/i });
	trigger.focus();
	fireEvent.mouseDown(trigger);
}

describe("the Events tab", () => {
	beforeEach(() => {
		cleanup();
		useExecutionEventsStore.getState().clear();
		state.response = null;
		state.isExecuting = false;
		state.request = { id: "req_1" };
	});

	it("renders on an ordinary response, and says it was not a stream", () => {
		state.response = okResponse({ body: '{"ok":true}', bodyType: "json" });
		renderViewer();

		// Present, not absent: the constant tab set is what stops issue #59
		// coming back, and an absence would be no answer at all.
		openEventsTab();
		expect(screen.getByText(/not an event stream/i)).toBeTruthy();
	});

	it("shows live rows while the stream is open", () => {
		state.response = okResponse();
		useExecutionEventsStore.getState().startStream({
			requestId: "req_1",
			runId: "run_1",
			eventsUrl: "/runs/run_1/events",
		});
		useExecutionEventsStore.getState().addEvent("run_1", event("first", "token"));
		useExecutionEventsStore.getState().addEvent("run_1", event("second", "token"));

		renderViewer();
		openEventsTab();

		expect(screen.getByText("first")).toBeTruthy();
		expect(screen.getByText("second")).toBeTruthy();
		// The band says a stream is live; `time` and `size` describe nothing yet.
		expect(screen.getByText(/Streaming - 2 events/i)).toBeTruthy();
	});

	it("shows no live rows for a stream another request started", () => {
		state.response = okResponse();
		useExecutionEventsStore.getState().startStream({
			requestId: "req_other",
			runId: "run_1",
			eventsUrl: "/runs/run_1/events",
		});
		useExecutionEventsStore.getState().addEvent("run_1", event("not mine"));

		renderViewer();
		openEventsTab();

		expect(screen.queryByText("not mine")).toBeNull();
		expect(screen.getByText(/not an event stream/i)).toBeTruthy();
	});

	it("swaps to the stored list once the response carries one", () => {
		// The handoff: the store still holds what the relay delivered, and the
		// stored trace is now the record.
		useExecutionEventsStore.getState().startStream({
			requestId: "req_1",
			runId: "run_1",
			eventsUrl: "/runs/run_1/events",
		});
		useExecutionEventsStore.getState().addEvent("run_1", event("live row"));
		useExecutionEventsStore.getState().endStream("run_1", "completed", 1);
		state.response = okResponse({
			events: [event("stored row")],
			totalEvents: 1,
			eventsTruncated: false,
			streamEndReason: "completed",
		});

		renderViewer();
		openEventsTab();

		expect(screen.getByText("stored row")).toBeTruthy();
		expect(screen.queryByText("live row")).toBeNull();
	});

	it("names why a stream ended when it was not the server's choice", () => {
		state.response = okResponse({
			events: [event("a")],
			totalEvents: 1,
			eventsTruncated: false,
			streamEndReason: "idleTimeout",
		});
		renderViewer();
		openEventsTab();

		expect(screen.getByText(/stream went quiet/i)).toBeTruthy();
	});

	it("discloses a capped list rather than letting the row count read as the total", () => {
		state.response = okResponse({
			events: [event("a"), event("b")],
			totalEvents: 4000,
			eventsTruncated: true,
			streamEndReason: "completed",
		});
		renderViewer();
		openEventsTab();

		expect(screen.getByText(/Events truncated for storage/i)).toBeTruthy();
		// The tab's own count is the received total, not the rows on screen.
		expect(screen.getByRole("tab", { name: /events/i }).textContent).toContain("4000");
	});

	it("distinguishes a stream that produced nothing from one that was never a stream", () => {
		state.response = okResponse({
			events: [],
			totalEvents: 0,
			eventsTruncated: false,
			streamEndReason: "completed",
		});
		renderViewer();
		openEventsTab();

		expect(screen.getByText(/no events received/i)).toBeTruthy();
		expect(screen.queryByText(/not an event stream/i)).toBeNull();
	});

	it("expands a row to its full payload, pretty-printed when it is JSON", () => {
		state.response = okResponse({
			events: [event('{"a":1}')],
			totalEvents: 1,
			eventsTruncated: false,
			streamEndReason: "completed",
		});
		renderViewer();
		openEventsTab();

		const row = screen.getByRole("button", { expanded: false });
		fireEvent.click(row);

		expect(screen.getByText(/"a": 1/)).toBeTruthy();
	});
});
