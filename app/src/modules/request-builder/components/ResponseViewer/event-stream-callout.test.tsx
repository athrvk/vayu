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
 * The Body tab's offer to turn Event stream on (issue #3777).
 *
 * Event stream is declared on the request and never detected from a reply, so a
 * `text/event-stream` answer to a request with the setting off is buffered:
 * Send waits for it to end and the Events tab has nothing. The Body tab is where
 * the user is looking, so it says why and carries the one-click fix.
 *
 * The action must write what the Settings tab's switch writes - the flag and the
 * `Accept` row together - not the flag alone.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ACCEPT_HEADER, SSE_ACCEPT } from "@/constants/request";
import { useExecutionEventsStore } from "@/stores";
import { useTabSelectionStore } from "@/stores/tab-selection-store";
import type { KeyValueItem } from "@/types";
import type { ResponseState } from "../../types";

// Monaco does not run in jsdom - the body editor is not what this test is about.
vi.mock("@/components/ui/code-editor", () => ({
	CodeEditor: () => <div data-testid="code-editor" />,
}));

let response: ResponseState | null = null;
let request: { id: string | null; stream: boolean; headers: KeyValueItem[] };
const setRequest = vi.fn();
vi.mock("../../context", () => ({
	useRequestBuilderContext: () => ({ response, isExecuting: false, request, setRequest }),
}));

// Imported after the mocks above are registered.
const { default: ResponseViewer } = await import("./index");

const OFFER = /Turn on event stream/;

function reply(overrides: Partial<ResponseState> = {}): ResponseState {
	return {
		status: 200,
		statusText: "OK",
		headers: { "content-type": "text/event-stream; charset=utf-8" },
		body: "data: hello\n\n",
		size: 13,
		time: 12,
		...overrides,
	};
}

function renderPane(state: ResponseState) {
	response = state;
	render(
		<TooltipProvider>
			<ResponseViewer />
		</TooltipProvider>
	);
}

beforeEach(() => {
	setRequest.mockReset();
	// A reply with events opens on the Events tab; the Body tab is the one under test.
	useTabSelectionStore.getState().clearAll();
	useExecutionEventsStore.getState().clear();
	useTabSelectionStore.getState().setResponseTab("req_1", "body");
	request = { id: "req_1", stream: false, headers: [] };
});

describe("the buffered text/event-stream callout", () => {
	it("turns the flag and the Accept header on together", () => {
		renderPane(reply());

		expect(screen.getByText("Event stream is off")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: OFFER }));

		expect(setRequest).toHaveBeenCalledTimes(1);
		const patch = setRequest.mock.calls[0][0];
		expect(patch.stream).toBe(true);
		expect(patch.headers).toHaveLength(1);
		expect(patch.headers[0]).toMatchObject({
			key: ACCEPT_HEADER,
			value: SSE_ACCEPT,
			enabled: true,
			source: "stream",
		});
	});

	it("keeps an Accept the user wrote", () => {
		const theirs: KeyValueItem = { id: "h1", key: "Accept", value: "*/*", enabled: true };
		request = { id: "req_1", stream: false, headers: [theirs] };
		renderPane(reply());

		fireEvent.click(screen.getByRole("button", { name: OFFER }));

		expect(setRequest).toHaveBeenCalledWith({ stream: true, headers: [theirs] });
	});

	it("matches the media type by whole token, in any case", () => {
		renderPane(reply({ headers: { "Content-Type": "Text/Event-Stream" } }));

		expect(screen.getByRole("button", { name: OFFER })).toBeInTheDocument();
	});

	it("is absent for a JSON reply", () => {
		renderPane(reply({ headers: { "content-type": "application/json" }, body: "{}" }));

		expect(screen.queryByText("Event stream is off")).toBeNull();
	});

	it("is absent for a reply with no Content-Type", () => {
		renderPane(reply({ headers: {} }));

		expect(screen.queryByText("Event stream is off")).toBeNull();
	});

	it("is absent when the request already has Event stream on", () => {
		request = { id: "req_1", stream: true, headers: [] };
		renderPane(reply());

		expect(screen.queryByText("Event stream is off")).toBeNull();
	});

	it("is absent when the reply carries the events of a stream that ran", () => {
		renderPane(reply({ events: [], streamEndReason: "completed" }));

		expect(screen.getByTestId("code-editor")).toBeInTheDocument();
		expect(screen.queryByText("Event stream is off")).toBeNull();
	});

	it("is absent for a client-side error, where no server answered", () => {
		renderPane(
			reply({
				status: 0,
				statusText: "",
				errorMessage: "connect ECONNREFUSED",
				errorCode: "ECONNREFUSED",
			})
		);

		expect(screen.queryByText("Event stream is off")).toBeNull();
	});

	it("is absent while this request's own live feed is open", () => {
		// The pane then shows a placeholder built from the relay's `open` frame:
		// the stream is already being read, whatever the flag says.
		useExecutionEventsStore.getState().startStream({
			requestId: "req_1",
			runId: "run_1",
			eventsUrl: "/runs/run_1/events",
		});
		useExecutionEventsStore.getState().noteOpen("run_1", {
			statusCode: 200,
			statusText: "OK",
			headers: { "content-type": SSE_ACCEPT },
		});
		response = null;
		render(
			<TooltipProvider>
				<ResponseViewer />
			</TooltipProvider>
		);

		expect(screen.getByTestId("code-editor")).toBeInTheDocument();
		expect(screen.queryByText("Event stream is off")).toBeNull();
	});
});
