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
 * A streamed response opens on Events, and the strip puts Events next to Body
 * (#3691).
 *
 * Send used to open an empty Body pane while Events, seventh of eight, was the
 * first tab into the "+N" menu. The default is derived from what the response
 * is and is never written to `tab-selection-store`, so it yields to a tab the
 * user chose, and a later ordinary response for the same request opens on
 * Body again.
 *
 * Mutation check: make `activeTab` fall back to "body" regardless of
 * `streamView` and the "opens on Events" cases fail; return `DEFAULT_TAB_SET`
 * from `responseTabSet` and the order cases fail; widen `streamView` to
 * `isStream` and the ordinary-Send-after-a-stream case fails; drop the
 * `response ?` branch and the stays-on-Events-after-`endStream` case fails; have
 * the default call `setResponseTab` and the two remembers-nothing cases fail.
 */

import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { useExecutionEventsStore } from "@/stores";
import { useTabSelectionStore } from "@/stores/tab-selection-store";
import type { ResponseState } from "../../types";
import ResponseViewer from "./index";

vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: ({ value }: { value?: string }) => <div data-testid="body-content">{value}</div>,
}));

const state: {
	response: ResponseState | null;
	isExecuting: boolean;
	request: { id: string };
} = { response: null, isExecuting: false, request: { id: "req_1" } };
vi.mock("../../context", () => ({
	useRequestBuilderContext: () => state,
}));

const STREAM_ORDER = ["Body", "Events", "Headers", "Cookies", "Timing", "Console", "Tests", "Raw"];
const PLAIN_ORDER = ["Body", "Headers", "Cookies", "Timing", "Console", "Tests", "Events", "Raw"];

const plainResponse = (): ResponseState => ({
	status: 200,
	statusText: "OK",
	headers: { "content-type": "application/json" },
	body: "the-response-body",
	size: 18,
	time: 12,
});

const storedStream = (): ResponseState => ({
	...plainResponse(),
	headers: { "content-type": "text/event-stream" },
	events: [{ event: "message", data: "stored row" }],
	totalEvents: 1,
	eventsTruncated: false,
	streamEndReason: "completed",
});

const startLiveStream = (requestId = "req_1") =>
	useExecutionEventsStore.getState().startStream({
		requestId,
		runId: "run_1",
		eventsUrl: "/runs/run_1/events",
	});

function renderViewer() {
	return render(
		<TooltipProvider>
			<ResponseViewer />
		</TooltipProvider>
	);
}

/** The visible label only: `TabLabel` renders a hidden bold twin before it. */
const labelOf = (tab: HTMLElement) =>
	tab.querySelector('[data-slot="tab-label-reserve"]')?.nextElementSibling?.textContent ?? "";

const shownLabels = () => screen.getAllByRole("tab").map(labelOf);

function activeTabLabel(): string {
	const active = screen
		.getAllByRole("tab")
		.filter((t) => t.getAttribute("data-state") === "active");
	expect(active.length, "exactly one tab must be selected").toBe(1);
	return labelOf(active[0] as HTMLElement);
}

/** `src/test/setup.ts` measures every string as 0 wide; give the fit real widths. */
function stubTextMeasure() {
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
		font: "",
		measureText: (text: string) => ({ width: text.length * 7 }),
	} as unknown as CanvasRenderingContext2D);
}

/** jsdom lays nothing out, so the measuring wrapper's width has to be supplied. */
function stubStripWidth(px: number) {
	Object.defineProperty(HTMLElement.prototype, "clientWidth", {
		configurable: true,
		get(this: HTMLElement) {
			return this.querySelector(':scope > [role="tablist"]') ? px : 0;
		},
	});
}

beforeEach(() => {
	useTabSelectionStore.getState().clearAll();
	useExecutionEventsStore.getState().clear();
	state.response = null;
	state.isExecuting = false;
	state.request = { id: "req_1" };
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	// @ts-expect-error - restore jsdom's own getter
	delete HTMLElement.prototype.clientWidth;
});

/** A stream whose `open` frame has arrived and whose stored run has not: what Send shows. */
function liveStreamPlaceholder(requestId = "req_1") {
	startLiveStream(requestId);
	useExecutionEventsStore
		.getState()
		.noteOpen("run_1", { statusCode: 200, statusText: "OK", headers: {} });
}

const rerenderViewer = (rerender: (ui: ReactElement) => void) =>
	rerender(
		<TooltipProvider>
			<ResponseViewer />
		</TooltipProvider>
	);

describe("the response pane's default tab for a stream", () => {
	it("opens on Events while a live stream has no remembered tab, and remembers nothing", () => {
		state.isExecuting = true;
		liveStreamPlaceholder();
		renderViewer();

		expect(activeTabLabel()).toMatch(/^Events/);
		expect(useTabSelectionStore.getState().getResponseTab("req_1")).toBeNull();
	});

	it("keeps the tab the user chose for this request", () => {
		useTabSelectionStore.getState().setResponseTab("req_1", "headers");
		liveStreamPlaceholder();
		renderViewer();

		expect(activeTabLabel()).toMatch(/^Headers/);
	});

	it("stays on Events once the stream ends and the stored run replaces the live rows", () => {
		liveStreamPlaceholder();
		const { rerender } = renderViewer();
		expect(activeTabLabel()).toMatch(/^Events/);

		// Ended, and the stored run has not landed: the placeholder is still on
		// screen and must not fall back to Body while the report is fetched.
		act(() => useExecutionEventsStore.getState().endStream("run_1", "stopped", 0));
		expect(activeTabLabel()).toMatch(/^Events/);

		state.response = storedStream();
		rerenderViewer(rerender);
		expect(activeTabLabel()).toMatch(/^Events/);
	});

	it("writes no default to the remembered tab for a stored stream either", () => {
		state.response = storedStream();
		renderViewer();

		expect(activeTabLabel()).toMatch(/^Events/);
		expect(useTabSelectionStore.getState().getResponseTab("req_1")).toBeNull();
	});

	it("opens an ordinary Send after a stream on Body, in the ordinary order", () => {
		stubTextMeasure();
		stubStripWidth(2000);
		// The production sequence: the stream ends and its stored run lands, and
		// then an ordinary Send calls only `beginSend`, so the store still holds
		// this request's id from the stream.
		liveStreamPlaceholder();
		act(() => useExecutionEventsStore.getState().endStream("run_1", "completed", 1));
		state.response = storedStream();
		const { rerender } = renderViewer();
		expect(activeTabLabel()).toMatch(/^Events/);
		expect(shownLabels()).toEqual(STREAM_ORDER);

		act(() => useExecutionEventsStore.getState().beginSend("req_1"));
		state.response = plainResponse();
		rerenderViewer(rerender);

		expect(activeTabLabel()).toMatch(/^Body/);
		expect(shownLabels()).toEqual(PLAIN_ORDER);
	});

	it("opens an ordinary response on Body", () => {
		state.response = plainResponse();
		renderViewer();

		expect(activeTabLabel()).toMatch(/^Body/);
	});

	it("ignores a stream another request started", () => {
		state.response = plainResponse();
		liveStreamPlaceholder("req_other");
		renderViewer();

		expect(activeTabLabel()).toMatch(/^Body/);
	});
});

describe("the response strip's order for a stream", () => {
	beforeEach(stubTextMeasure);

	it("puts Events directly after Body, ahead of Cookies", () => {
		stubStripWidth(2000);
		state.response = storedStream();
		renderViewer();

		expect(shownLabels()).toEqual(STREAM_ORDER);
	});

	it("keeps Events in its ordinary place for a response that is not a stream", () => {
		stubStripWidth(2000);
		state.response = plainResponse();
		renderViewer();

		expect(shownLabels()).toEqual(PLAIN_ORDER);
	});

	it("keeps Events on the strip, beside Body, when the room is short", () => {
		stubStripWidth(300);
		useTabSelectionStore.getState().setResponseTab("req_1", "body");
		state.response = storedStream();
		renderViewer();

		expect(shownLabels().slice(0, 2)).toEqual(["Body", "Events"]);
	});
});
