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
import { STREAM_END_REASONS, type StreamEndReason, type StreamEvent } from "@/types";

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
		state.response = okResponse({ body: '{"ok":true}' });
		renderViewer();

		// Present, not absent: the constant tab set is what stops issue #59
		// coming back, and an absence would be no answer at all.
		openEventsTab();
		expect(screen.getByText(/not an event stream/i)).toBeTruthy();
		// The way out is in the same line: the inline state has no second one.
		expect(screen.getByText(/Event stream in the request's Settings tab/)).toBeTruthy();
	});

	it("says the stream is open while it has produced nothing", () => {
		state.response = okResponse();
		useExecutionEventsStore.getState().startStream({
			requestId: "req_1",
			runId: "run_1",
			eventsUrl: "/runs/run_1/events",
		});
		renderViewer();
		openEventsTab();

		expect(screen.getByText(/Waiting for the first event/)).toBeTruthy();
		expect(screen.getByText(/nothing has arrived yet/)).toBeTruthy();
	});

	it("shows live rows while the stream is open", () => {
		state.response = okResponse();
		useExecutionEventsStore.getState().startStream({
			requestId: "req_1",
			runId: "run_1",
			eventsUrl: "/runs/run_1/events",
		});
		useExecutionEventsStore.getState().addEvents("run_1", [event("first", "token")]);
		useExecutionEventsStore.getState().addEvents("run_1", [event("second", "token")]);

		renderViewer();
		openEventsTab();

		expect(screen.getByText("first")).toBeTruthy();
		expect(screen.getByText("second")).toBeTruthy();
		// The band says a stream is live; `time` and `size` describe nothing yet.
		expect(screen.getByText(/Streaming - 2 events/i)).toBeTruthy();
	});

	it("shows the live rows, not a previous run's, when no response is stored for the stream", () => {
		state.response = null;
		state.isExecuting = true;
		useExecutionEventsStore.getState().startStream({
			requestId: "req_1",
			runId: "run_2",
			eventsUrl: "/runs/run_2/events",
		});
		useExecutionEventsStore
			.getState()
			.noteOpen("run_2", { statusCode: 200, statusText: "OK", headers: {} });
		useExecutionEventsStore.getState().addEvents("run_2", [event("fresh", "token")]);

		renderViewer();
		openEventsTab();

		expect(screen.getByText("fresh")).toBeTruthy();
		expect(screen.getByText(/Streaming - 1 event/i)).toBeTruthy();
		expect(screen.queryByText(/ended/i)).toBeNull();
	});

	it("shows no live rows for a stream another request started", () => {
		state.response = okResponse();
		useExecutionEventsStore.getState().startStream({
			requestId: "req_other",
			runId: "run_1",
			eventsUrl: "/runs/run_1/events",
		});
		useExecutionEventsStore.getState().addEvents("run_1", [event("not mine")]);

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
		useExecutionEventsStore.getState().addEvents("run_1", [event("live row")]);
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

	// Typed on the union, so a reason added without a title here fails type-check;
	// the render is what proves `ResponseEvents` has a note for it.
	const END_REASON_TITLES: Record<StreamEndReason, string> = {
		completed: "Stream closed by the server",
		stopped: "Stream stopped",
		maxStreamEvents: "Event limit reached",
		maxStreamDurationMs: "Duration limit reached",
		idleTimeout: "Stream went quiet",
		shutdown: "Vayu's engine shut down",
		error: "Stream ended in an error",
	};

	it("holds a title for exactly the reasons the app accepts", () => {
		expect(Object.keys(END_REASON_TITLES).sort()).toEqual([...STREAM_END_REASONS].sort());
	});

	it.each(STREAM_END_REASONS)("shows a note when the stream ended as %s", (reason) => {
		state.response = okResponse({
			events: [event("a")],
			totalEvents: 1,
			eventsTruncated: false,
			streamEndReason: reason,
		});
		renderViewer();
		openEventsTab();

		expect(screen.getByText(END_REASON_TITLES[reason])).toBeTruthy();
	});

	it("says a daemon shutdown ended the stream, not the user", () => {
		state.response = okResponse({
			events: [event("a")],
			totalEvents: 1,
			eventsTruncated: false,
			streamEndReason: "shutdown",
		});
		renderViewer();
		openEventsTab();

		expect(screen.getByText(/engine shut down, so the stream was closed/i)).toBeTruthy();
		expect(screen.queryByText(/you stopped/i)).toBeNull();
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
		expect(screen.getByText(/server sent no events before it ended/)).toBeTruthy();
		expect(screen.queryByText(/not an event stream/i)).toBeNull();
	});

	/**
	 * A stream request whose reply was not an event stream (issue #3238): the
	 * body is on the Body tab, so the Events tab must say that instead of
	 * blaming the server for sending no events.
	 */
	describe("when the server answered with something that is not an event stream", () => {
		const jsonError = (headers: Record<string, string>) =>
			okResponse({
				status: 404,
				statusText: "Not Found",
				headers,
				body: '{"error":"no such stream"}',
				bodyRaw: '{"error":"no such stream"}',
				size: 26,
				events: [],
				totalEvents: 0,
				eventsTruncated: false,
				streamEndReason: "completed",
			});

		it("names the type and points at Body, once the run is stored", () => {
			state.response = jsonError({ "content-type": "application/json" });
			renderViewer();
			openEventsTab();

			const panel = screen.getByRole("tabpanel", { name: /events/i });
			expect(panel.textContent).toContain(
				"The server answered application/json, not an event stream - see Body."
			);
			// The type is code, not prose.
			expect(panel.querySelector("code")?.textContent).toBe("application/json");
			expect(screen.queryByText(/no events received/i)).toBeNull();
		});

		it("names it from the live open frame while the stream is still open", () => {
			state.response = null;
			state.isExecuting = true;
			useExecutionEventsStore.getState().startStream({
				requestId: "req_1",
				runId: "run_1",
				eventsUrl: "/runs/run_1/events",
			});
			useExecutionEventsStore.getState().noteOpen("run_1", {
				statusCode: 404,
				statusText: "Not Found",
				headers: { "Content-Type": "application/json; charset=utf-8" },
			});
			renderViewer();
			openEventsTab();

			expect(screen.getByText(/not an event stream - see Body/)).toBeTruthy();
			expect(screen.getByText("application/json")).toBeTruthy();
			expect(screen.queryByText(/Waiting for the first event/)).toBeNull();
		});

		it("keeps the empty-stream wording for text/event-stream, parameters and case aside", () => {
			state.response = okResponse({
				headers: { "Content-Type": "Text/Event-Stream; charset=utf-8" },
				events: [],
				totalEvents: 0,
				eventsTruncated: false,
				streamEndReason: "completed",
			});
			renderViewer();
			openEventsTab();

			expect(screen.getByText(/no events received/i)).toBeTruthy();
			expect(screen.queryByText(/not an event stream - see Body/)).toBeNull();
		});

		it("keeps the empty-stream wording when the reply carried no Content-Type", () => {
			state.response = okResponse({
				status: 0,
				statusText: "",
				headers: {},
				events: [],
				totalEvents: 0,
				eventsTruncated: false,
				streamEndReason: "error",
			});
			renderViewer();
			openEventsTab();

			expect(screen.getByText(/no events received/i)).toBeTruthy();
			expect(screen.queryByText(/see Body/)).toBeNull();
		});

		it("shows the stored body and status on the Body tab", () => {
			state.response = jsonError({ "content-type": "application/json" });
			renderViewer();
			// The strip remembers the last tab the previous case left open.
			const body = screen.getByRole("tab", { name: /^body/i });
			body.focus();
			fireEvent.mouseDown(body);

			expect(screen.getByTestId("body-content").textContent).toContain("no such stream");
			expect(screen.getByText("404 Not Found")).toBeTruthy();
		});
	});

	describe("the size chip of a stream", () => {
		it("is absent while the placeholder from the open frame is all there is", () => {
			// The relay carries no body, so `0 B` would claim an empty reply.
			state.response = null;
			state.isExecuting = true;
			useExecutionEventsStore.getState().startStream({
				requestId: "req_1",
				runId: "run_1",
				eventsUrl: "/runs/run_1/events",
			});
			useExecutionEventsStore
				.getState()
				.noteOpen("run_1", { statusCode: 200, statusText: "OK", headers: {} });
			renderViewer();

			expect(screen.getByText(/Streaming - 0 events/i)).toBeTruthy();
			expect(screen.queryByText("0 B")).toBeNull();
		});

		it("shows the bytes delivered once the stored run replaces the placeholder", () => {
			state.response = okResponse({
				size: 2048,
				bodyBytes: 2048,
				events: [event("a")],
				totalEvents: 1,
				eventsTruncated: false,
				streamEndReason: "completed",
			});
			renderViewer();

			expect(screen.getByText("2.0 KB")).toBeTruthy();
			expect(screen.queryByText("0 B")).toBeNull();
			// A size is not a truncation: `bodyBytes` on a stream is always set.
			expect(screen.queryByText(/Body truncated for storage/)).toBeNull();
		});
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

	it("squares off each row's corners - it is full-bleed in the list, never inset", () => {
		state.response = okResponse({
			events: [event('{"a":1}')],
			totalEvents: 1,
			eventsTruncated: false,
			streamEndReason: "completed",
		});
		renderViewer();
		openEventsTab();

		const row = screen.getByRole("button", { expanded: false });
		expect(row.className).toMatch(/\brounded-none\b/);
	});
});
