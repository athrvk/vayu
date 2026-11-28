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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { useExecutionEventsStore } from "@/stores";
import { TIMING } from "@/config/timing";
import type { ResponseState } from "../../types";
import { responseFromRunResult } from "../../utils/restore-response";
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

/** What the engine does to an event it judged an error; the renderer only reads the mark (#3996). */
const flagged = (e: StreamEvent): StreamEvent => ({ ...e, isError: true });

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

	describe("when each event is placed in time (#3775)", () => {
		const SENT_AT = 1_700_000_000_000;
		const at = (offsetMs: number, data: string): StreamEvent => ({
			...event(data, "token"),
			receivedAt: SENT_AT + offsetMs,
		});
		const timingOf = {
			totalMs: 3700,
			dnsMs: 1,
			connectMs: 2,
			tlsMs: 3,
			firstByteMs: 80,
			downloadMs: 3600,
		};
		/** The three events of a stream that took 1.5 s to answer. */
		const slowStart = () => [at(1500, "a"), at(1620, "b"), at(3620, "c")];
		const storedStream = (overrides: Partial<ResponseState>) =>
			okResponse({
				events: slowStart(),
				totalEvents: 3,
				eventsTruncated: false,
				streamEndReason: "completed",
				...overrides,
			});
		/** What each row printed for one figure, in row order. */
		const figures = (since: string) =>
			screen.queryAllByTitle(since).map((el) => el.textContent);

		afterEach(() => vi.useRealTimers());

		it("shows each row's offset from the send and its gap from the previous event", () => {
			state.response = storedStream({ sentAt: SENT_AT });
			renderViewer();
			openEventsTab();

			// Mutation check: read `receivedAt` as the offset itself (skip the
			// subtraction) and these are epoch milliseconds.
			expect(figures("Since the send")).toEqual([
				"+1.50 s since the send",
				"+1.62 s since the send",
				"+3.62 s since the send",
			]);
			// The first event has no previous one, so it carries no gap.
			expect(figures("Since the previous event")).toEqual([
				"+120 ms since the previous event",
				"+2.00 s since the previous event",
			]);
		});

		it("shows the gaps alone when the send time is not known", () => {
			state.response = storedStream({});
			renderViewer();
			openEventsTab();

			expect(figures("Since the send")).toEqual([]);
			expect(figures("Since the previous event")).toHaveLength(2);
		});

		it("shows no figure on events that carry no arrival time, as a load run's samples do", () => {
			state.response = storedStream({
				sentAt: SENT_AT,
				events: [event("a", "token"), event("b", "token")],
				totalEvents: 2,
			});
			renderViewer();
			openEventsTab();

			expect(figures("Since the send")).toEqual([]);
			expect(figures("Since the previous event")).toEqual([]);
		});

		it("counts from the moment a live stream started", () => {
			vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
			vi.setSystemTime(SENT_AT);
			state.response = null;
			const store = useExecutionEventsStore.getState();
			store.startStream({
				requestId: "req_1",
				runId: "run_1",
				eventsUrl: "/runs/run_1/events",
			});
			store.noteOpen("run_1", { statusCode: 200, statusText: "OK", headers: {} });
			store.addEvents("run_1", [at(800, "first token")]);
			renderViewer();
			openEventsTab();

			// Mutation check: drop `sentAt` from the placeholder response and the
			// live rows lose their offset while the stream is open.
			expect(figures("Since the send")).toEqual(["+800 ms since the send"]);

			// The band counts the same stream's time up. Mutation check: drop
			// `sentAt` from the viewer's `streaming` prop and it reads the
			// placeholder's "0 ms" for the whole stream.
			act(() => {
				vi.setSystemTime(SENT_AT + 2500); // plus the one tick advanced below
				vi.advanceTimersByTime(TIMING.STREAM_CLOCK_TICK_MS);
			});
			expect(screen.getByText("2.60 s")).toBeTruthy();
		});

		it("never reads a negative offset when an event beats the send's own stamp", () => {
			state.response = storedStream({ sentAt: SENT_AT, events: [at(-4, "early")] });
			renderViewer();
			openEventsTab();

			// Mutation check: drop the floor in `elapsedBetween` and this is "+-4 ms".
			expect(figures("Since the send")).toEqual(["+0 ms since the send"]);
		});

		describe("on the Timing tab", () => {
			function openTimingTab() {
				const trigger = screen.getByRole("tab", { name: /timing/i });
				trigger.focus();
				fireEvent.mouseDown(trigger);
			}

			it("shows the first event and the row offsets of a stream reopened from History (#3805)", () => {
				// Through the restore funnel, as History does: the stored node's start
				// is the only zero the pane has.
				const restored = responseFromRunResult({
					timestamp: SENT_AT + 4000,
					statusCode: 200,
					statusText: "OK",
					latencyMs: 3700,
					trace: {
						request: { method: "GET", url: "https://api.example.test/sse" },
						response: { headers: { "content-type": "text/event-stream" }, body: "" },
						dnsMs: 1,
						connectMs: 2,
						tlsMs: 3,
						firstByteMs: 80,
						downloadMs: 3600,
						events: {
							items: slowStart(),
							totalEvents: 3,
							eventsTruncated: false,
							endReason: "completed",
							startedAt: SENT_AT,
						},
					},
				});
				expect(restored).not.toBeNull();
				state.response = restored;
				renderViewer();

				// Mutation check: drop the `sentAt` spread in `eventsFromTrace` and
				// neither the offsets nor the first-event row has a zero to count from.
				openEventsTab();
				expect(figures("Since the send")).toEqual([
					"+1.50 s since the send",
					"+1.62 s since the send",
					"+3.62 s since the send",
				]);
				openTimingTab();
				const label = screen.getByText("First event");
				expect(label.parentElement?.textContent).toBe("First event1.50s");
			});

			it("lists the first event as the time from the send to the first row", () => {
				state.response = storedStream({ sentAt: SENT_AT, timing: timingOf });
				renderViewer();
				openTimingTab();

				// Mutation check: pass the viewer's `firstEventMs` as undefined and
				// the row is gone from a stream that has one.
				const label = screen.getByText("First event");
				expect(label.parentElement?.textContent).toBe("First event1.50s");
			});

			it.each([
				["has no send time", { timing: timingOf }],
				[
					"has no events",
					{ sentAt: SENT_AT, timing: timingOf, events: [], totalEvents: 0 },
				],
			])("leaves the row out when the stream %s", (_name, overrides) => {
				state.response = storedStream(overrides);
				renderViewer();
				openTimingTab();

				expect(screen.getByText("Total")).toBeTruthy();
				expect(screen.queryByText("First event")).toBeNull();
			});
		});
	});
});

/**
 * The Text view (issue #3773): the reply a declared stream text path read off
 * the events, joined. It renders what the engine put on each event as `text`
 * and never reads `data` - the app declares no provider shape.
 */
describe("the Events tab's Text view", () => {
	// The data carries no trace of the reply, so any text on screen came from `text`.
	const token = (text: string, data = '{"choices":[{"delta":{}}]}'): StreamEvent => ({
		event: "message",
		data,
		text,
	});
	const textOf = () => screen.getByTestId("stream-text").textContent;
	const pick = (name: RegExp) => fireEvent.click(screen.getByRole("radio", { name }));

	beforeEach(() => {
		cleanup();
		useExecutionEventsStore.getState().clear();
		state.response = null;
		state.isExecuting = false;
		state.request = { id: "req_1" };
	});

	function startLive() {
		state.response = okResponse();
		useExecutionEventsStore.getState().startStream({
			requestId: "req_1",
			runId: "run_1",
			eventsUrl: "/runs/run_1/events",
		});
	}

	it("opens on the joined text of a live stream, from the events' text and not their data", () => {
		startLive();
		useExecutionEventsStore.getState().addEvents("run_1", [token("Hel"), token("lo")]);
		// A role-only chunk, a ping: no `text`, skipped.
		useExecutionEventsStore.getState().addEvents("run_1", [event('{"ping":true}', "ping")]);
		useExecutionEventsStore.getState().addEvents("run_1", [token(", world")]);

		renderViewer();
		openEventsTab();

		expect(textOf()).toBe("Hello, world");
	});

	it("grows as batches arrive and keeps the Rows view one switch away", async () => {
		startLive();
		useExecutionEventsStore.getState().addEvents("run_1", [token("One")]);
		renderViewer();
		openEventsTab();
		expect(textOf()).toBe("One");

		act(() => useExecutionEventsStore.getState().addEvents("run_1", [token(" two")]));
		expect(await screen.findByText("One two")).toBeTruthy();

		pick(/rows/i);
		expect(screen.queryByTestId("stream-text")).toBeNull();
		expect(screen.getAllByRole("button", { expanded: false })).toHaveLength(2);

		pick(/text/i);
		expect(textOf()).toBe("One two");
	});

	it("is not offered for a stream whose events carry no text, which keeps its rows", () => {
		startLive();
		useExecutionEventsStore.getState().addEvents("run_1", [event("plain")]);
		renderViewer();
		openEventsTab();

		expect(screen.getByText("plain")).toBeTruthy();
		expect(screen.queryByRole("radio", { name: /text/i })).toBeNull();
	});

	it("reads the stored streamText over the stored items, which the item cap cut short", () => {
		// 2 of 5 events kept: concatenating them would end at "Hel".
		state.response = okResponse({
			events: [token("Hel"), token("lo")],
			totalEvents: 5,
			eventsTruncated: true,
			streamEndReason: "completed",
			streamText: "Hello, world",
		});
		renderViewer();
		openEventsTab();

		expect(textOf()).toBe("Hello, world");
		// The engine joined it over every event, so the cap is not this view's news...
		expect(screen.queryByText(/Events truncated for storage/i)).toBeNull();
		expect(screen.queryByText(/stops where they do/i)).toBeNull();
		// ... and it is still the rows' news.
		pick(/rows/i);
		expect(screen.getByText(/Events truncated for storage/i)).toBeTruthy();
	});

	it("says the text is partial when the list was cut and no streamText came with it", () => {
		state.response = okResponse({
			events: [token("Hel"), token("lo")],
			totalEvents: 5,
			eventsTruncated: true,
			streamEndReason: "completed",
		});
		renderViewer();
		openEventsTab();

		expect(textOf()).toBe("Hello");
		expect(screen.getByText(/stops where they do/i)).toBeTruthy();
	});

	it("says no text matched when the path was declared and found nothing", () => {
		state.response = okResponse({
			events: [event('{"other":1}')],
			totalEvents: 1,
			eventsTruncated: false,
			streamEndReason: "completed",
			streamText: "",
		});
		renderViewer();
		openEventsTab();

		expect(screen.getByText(/No event matched the stream text path/i)).toBeTruthy();
		expect(screen.queryByTestId("stream-text")).toBeNull();
	});

	it("calls out an error event, in the Text view only, beside the end-reason note", () => {
		state.response = okResponse({
			events: [token("Hel"), flagged(event('{"message":"Overloaded"}', "error"))],
			totalEvents: 2,
			eventsTruncated: false,
			streamEndReason: "error",
			streamText: "Hel",
		});
		renderViewer();
		openEventsTab();

		expect(screen.getByText("The server sent an error event")).toBeTruthy();
		expect(screen.getByText('{"message":"Overloaded"}')).toBeTruthy();
		expect(screen.getByText("Stream ended in an error")).toBeTruthy();

		pick(/rows/i);
		expect(screen.queryByText("The server sent an error event")).toBeNull();
		expect(screen.getByText("Stream ended in an error")).toBeTruthy();
	});

	it("lists a few error events and counts the rest", () => {
		const errors = Array.from({ length: 5 }, (_, i) => flagged(event(`boom ${i}`, "error")));
		state.response = okResponse({
			events: [token("x"), ...errors],
			totalEvents: 6,
			eventsTruncated: false,
			streamEndReason: "error",
			streamText: "x",
		});
		renderViewer();
		openEventsTab();

		expect(screen.getAllByText("The server sent an error event")).toHaveLength(3);
		expect(screen.getByText(/2 more error events in Rows/)).toBeTruthy();
	});
});

/**
 * An in-band stream error (issue #3996). The engine decides which events are errors and marks them
 * `isError`; the pane reads that mark and nothing else, so an event named `error` the engine did
 * not mark draws no error, and an unnamed one it did mark does.
 */
describe("the Events tab's in-band error", () => {
	const marked = flagged(event('{"error":{"message":"Overloaded"}}'));
	const token = (text: string): StreamEvent => ({
		event: "message",
		data: '{"choices":[{"delta":{}}]}',
		text,
	});
	const stored = (events: StreamEvent[], overrides: Partial<ResponseState> = {}) =>
		okResponse({
			events,
			totalEvents: events.length,
			eventsTruncated: false,
			streamEndReason: "completed",
			...overrides,
		});
	const pick = (name: RegExp) => fireEvent.click(screen.getByRole("radio", { name }));

	beforeEach(() => {
		cleanup();
		useExecutionEventsStore.getState().clear();
		state.response = null;
		state.isExecuting = false;
		state.request = { id: "req_1" };
	});

	// Mutation check: compare `event.event === "error"` in `errorEventsOf` again and the
	// unnamed marked event draws no callout.
	it("calls out a marked event whatever its name, in the Text view", () => {
		state.response = stored([token("Hel"), marked], { streamText: "Hel" });
		renderViewer();
		openEventsTab();

		expect(screen.getByText("The server sent an error event")).toBeTruthy();
		expect(screen.getByText('{"error":{"message":"Overloaded"}}')).toBeTruthy();
	});

	it("puts an error chip on the marked row and not on its neighbours", () => {
		state.response = stored([event("fine"), marked]);
		renderViewer();
		openEventsTab();

		expect(screen.getAllByText("error")).toHaveLength(1);
		expect(screen.getByText("error").closest("button")?.textContent).toContain("Overloaded");
	});

	it("states how many errors the list holds beside the event count", () => {
		state.response = stored([event("fine"), marked, flagged(event("again"))]);
		renderViewer();
		openEventsTab();

		expect(screen.getByText("2 errors")).toBeTruthy();
		expect(screen.getByText(/3 events/)).toBeTruthy();
	});

	it("says one error in the singular", () => {
		state.response = stored([marked]);
		renderViewer();
		openEventsTab();

		expect(screen.getByText("1 error")).toBeTruthy();
	});

	it("trusts the mark: an event named error that the engine did not mark draws nothing", () => {
		state.response = stored([token("Hel"), event("plain", "error")], { streamText: "Hel" });
		renderViewer();
		openEventsTab();

		expect(screen.queryByText("The server sent an error event")).toBeNull();
		expect(screen.queryByText(/\d errors?$/)).toBeNull();
		pick(/rows/i);
		// The name chip is the only "error" on screen.
		expect(screen.getAllByText("error")).toHaveLength(1);
	});

	it("counts a live stream's errors from the store, batch by batch", () => {
		state.response = okResponse();
		const store = useExecutionEventsStore.getState();
		store.startStream({
			requestId: "req_1",
			runId: "run_1",
			eventsUrl: "/runs/run_1/events",
		});
		store.addEvents("run_1", [event("fine"), marked]);
		renderViewer();
		openEventsTab();
		expect(screen.getByText("1 error")).toBeTruthy();

		act(() => useExecutionEventsStore.getState().addEvents("run_1", [flagged(event("two"))]));
		expect(screen.getByText("2 errors")).toBeTruthy();
	});

	it("shows no count for a stream another request started", () => {
		state.response = okResponse();
		const store = useExecutionEventsStore.getState();
		store.startStream({
			requestId: "req_other",
			runId: "run_1",
			eventsUrl: "/runs/run_1/events",
		});
		store.addEvents("run_1", [marked]);
		renderViewer();
		openEventsTab();

		expect(screen.queryByText(/\d errors?$/)).toBeNull();
	});
});
