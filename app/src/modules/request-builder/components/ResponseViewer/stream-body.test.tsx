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
 * A finished stream's Body tab holds the bytes it received (#3770).
 *
 * The engine kept no body for a `text/event-stream` reply, so the tab was an
 * empty editor beside a full Events list. It now stores the bytes once, and the
 * pane reads them through the same funnel every restored response takes. The
 * response here is built by `responseFromRunResult` from a stored trace, so a
 * field the funnel dropped fails these cases and not only the funnel's own.
 *
 * Mutation check: drop `body` / `bodyRaw` from `responseHeadFromTrace` and the
 * bytes cases read an empty editor; make `cappedReadExtent` answer `size`
 * for a stream and the capped-stream case reads the wire count.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { useExecutionEventsStore } from "@/stores";
import { useTabSelectionStore } from "@/stores/tab-selection-store";
import { responseFromRunResult, type RunResultSample } from "../../utils/restore-response";
import type { ResponseState } from "../../types";

vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: ({ value, language }: { value?: string; language?: string }) => (
		<pre data-testid="body-content" data-language={language}>
			{value}
		</pre>
	),
}));

const state: {
	response: ResponseState | null;
	isExecuting: boolean;
	request: { id: string };
} = { response: null, isExecuting: false, request: { id: "req_1" } };
vi.mock("../../context", () => ({
	useRequestBuilderContext: () => state,
}));

const { default: ResponseViewer } = await import("./index");

const WIRE = 'event: token\ndata: {"t":"Par"}\n\nevent: token\ndata: is\n\ndata: [DONE]\n\n';
const MB32 = 33_554_432;

/** A stream's stored result, answered the way `GET /runs/:id/results/:id` serves it. */
function storedStream(response: Record<string, unknown>): ResponseState {
	const row: RunResultSample = {
		timestamp: 1_750_000_000_000,
		statusCode: 200,
		statusText: "OK",
		latencyMs: 40,
		trace: {
			request: { method: "POST", url: "https://api.example.test/chat" },
			response: { headers: { "content-type": "text/event-stream" }, ...response },
			events: {
				items: [{ event: "token", data: "is", receivedAt: 1_750_000_000_001 }],
				totalEvents: 3,
				eventsTruncated: false,
				endReason: "completed",
			},
		},
	};
	const restored = responseFromRunResult(row);
	if (!restored) throw new Error("the stored stream did not restore");
	return restored;
}

function renderBody(response: ResponseState | null) {
	state.response = response;
	return render(
		<TooltipProvider>
			<ResponseViewer />
		</TooltipProvider>
	);
}

const editorText = () => screen.getByTestId("body-content").textContent;

beforeEach(() => {
	useExecutionEventsStore.getState().clear();
	useTabSelectionStore.getState().clearAll();
	// A stream opens on Events by default; this file is about the other tab.
	useTabSelectionStore.getState().setResponseTab("req_1", "body");
	state.response = null;
	state.isExecuting = false;
});

afterEach(cleanup);

describe("the Body tab of a finished stream", () => {
	it("holds the bytes the stream delivered", () => {
		renderBody(storedStream({ body: WIRE, bodyBytes: WIRE.length }));

		expect(editorText()).toBe(WIRE);
	});

	it("reads the same in Pretty and in Raw, and neither is a JSON reindent", () => {
		renderBody(storedStream({ body: WIRE, bodyBytes: WIRE.length }));
		expect(screen.getByTestId("body-content").dataset.language).toBe("plaintext");

		fireEvent.click(screen.getByRole("radio", { name: /raw/i }));

		expect(editorText()).toBe(WIRE);
	});

	it("shows a stream stored as base64 as its decoded text", () => {
		renderBody(
			storedStream({
				body: btoa(WIRE),
				bodyEncoding: "base64",
				bodyBytes: WIRE.length,
			})
		);

		expect(editorText()).toBe(WIRE);
	});

	it("is empty while the stream is still open, which has no bytes to show yet", () => {
		useExecutionEventsStore.getState().startStream({
			requestId: "req_1",
			runId: "run_1",
			eventsUrl: "/runs/run_1/events",
		});
		useExecutionEventsStore.getState().noteOpen("run_1", {
			statusCode: 200,
			statusText: "OK",
			headers: { "content-type": "text/event-stream" },
		});
		renderBody(null);

		expect(editorText()).toBe("");
	});
});

describe("the notices over a stream's body", () => {
	it("words a capped read by the prefix held, not by the bytes the wire delivered", () => {
		// 2 KB held of a 32 MB delivered: "first 32.0 MB" would claim the engine
		// read what it kept 2 KB of.
		renderBody(storedStream({ body: "d".repeat(2048), bodyBytes: MB32, bodyCapped: true }));

		expect(screen.getByText(/Body capped while reading/)).toBeInTheDocument();
		expect(
			screen.getByText(/Only the first 2\.0 KB of this response was read/)
		).toBeInTheDocument();
		// The status bar's size chip rightly says 32.0 MB, so read the callout alone.
		expect(
			screen.getByText(/Body capped while reading/).parentElement?.textContent
		).not.toMatch(/32\.0 MB/);
	});

	it("makes no claim about the prefix once storage shortened it too", () => {
		renderBody(
			storedStream({
				body: "d".repeat(2048),
				bodyBytes: MB32,
				bodyCapped: true,
				bodyTruncated: true,
			})
		);

		expect(screen.getByText(/Only the start of this response was read/)).toBeInTheDocument();
		// Storage's own notice still counts against the wire, which is what it kept of.
		expect(screen.getByText(/Only the first 2\.0 KB of 32\.0 MB was kept/)).toBeInTheDocument();
	});

	it("shows no notice for a stream whose bytes were all kept", () => {
		renderBody(storedStream({ body: WIRE, bodyBytes: WIRE.length }));

		expect(screen.queryByText(/Body capped while reading/)).toBeNull();
		expect(screen.queryByText(/Body truncated for storage/)).toBeNull();
	});
});
