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
 * A failed send keeps the pane's other tabs (issue #1884).
 *
 * A TIMEOUT, CONNECTION_FAILED or SSL_ERROR still carries what the engine sent,
 * the headers libcurl added and how far the handshake got - the facts the error
 * hints tell the user to check. The pane used to replace itself wholesale with
 * `ClientErrorView` for `status: 0`, so all of it was recorded and none shown.
 * `ClientErrorView` is now the Body tab's content and the tab strip stays.
 *
 * The fixture is the shape both response funnels produce for a failed run, not
 * one of the synthetic status-0 responses, which have no sent side at all.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import type { ResponseState } from "../../types";
import ResponseViewer from "./index";

// Monaco does not run under jsdom; the Raw tab's text is read off this stub.
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: ({ value }: { value?: string }) => <div data-testid="code-editor">{value}</div>,
}));

const state: {
	response: ResponseState | null;
	isExecuting: boolean;
	request: { id: string | null };
} = { response: null, isExecuting: false, request: { id: "req-1" } };
vi.mock("../../context", () => ({
	useRequestBuilderContext: () => state,
}));

function failedResponse(overrides: Partial<ResponseState> = {}): ResponseState {
	return {
		status: 0,
		statusText: "",
		headers: {},
		body: "",
		size: 0,
		time: 1,
		errorCode: "TIMEOUT",
		errorMessage: "Operation timed out after 1 milliseconds",
		rawRequest: "GET /slow HTTP/1.1\r\nHost: example.test\r\n\r\n",
		requestHeaders: { "X-Sent-By": "vayu", Accept: "*/*" },
		timing: { totalMs: 1, dnsMs: 12, connectMs: 0, tlsMs: 0, firstByteMs: 0, downloadMs: 0 },
		...overrides,
	};
}

function renderViewer() {
	return render(
		<TooltipProvider>
			<ResponseViewer />
		</TooltipProvider>
	);
}

// Radix selects a trigger on `mousedown`/focus, not on a bare `click`.
function selectTab(name: RegExp) {
	const trigger = screen.getByRole("tab", { name });
	trigger.focus();
	fireEvent.mouseDown(trigger);
}

beforeEach(() => {
	state.response = failedResponse();
	state.isExecuting = false;
	state.request = { id: "req-1" };
});

afterEach(cleanup);

describe("a status 0 response", () => {
	it("keeps ClientErrorView as the Body tab's content", () => {
		renderViewer();

		expect(screen.getByRole("tab", { name: /body/i }).getAttribute("data-state")).toBe(
			"active"
		);
		expect(screen.getByText("No response before the timeout")).toBeTruthy();
		expect(screen.getByText("Error code: TIMEOUT")).toBeTruthy();
	});

	it("renders the whole tab strip", () => {
		renderViewer();

		for (const name of [/body/i, /headers/i, /timing/i, /console/i, /tests/i, /raw/i]) {
			expect(screen.queryByRole("tab", { name })).toBeTruthy();
		}
	});

	it("shows the request that went out on the Raw tab, and no response under it", () => {
		renderViewer();
		selectTab(/raw/i);

		const raw = screen.getByTestId("code-editor").textContent ?? "";
		expect(raw).toContain("> GET /slow HTTP/1.1");
		expect(raw).toContain("> Host: example.test");
		// Nothing came back, so no status line is invented for it.
		expect(raw).not.toMatch(/^</m);
		expect(raw).not.toContain("HTTP/1.1 0");
	});

	it("says so on the Raw tab when the engine recorded no request", () => {
		state.response = failedResponse({ rawRequest: undefined });
		renderViewer();
		selectTab(/raw/i);

		expect(screen.queryByTestId("code-editor")).toBeNull();
		expect(screen.getByText("No request was recorded")).toBeTruthy();
	});

	it("lists the sent header names on the Headers tab", () => {
		renderViewer();
		selectTab(/headers/i);

		// The request group starts collapsed; its toggle is the way in.
		fireEvent.click(screen.getByRole("button", { name: /request headers/i }));
		expect(screen.getByText("X-Sent-By")).toBeTruthy();
		expect(screen.getByText("Accept")).toBeTruthy();
	});

	it("shows the phases the engine measured on the Timing tab", () => {
		renderViewer();
		selectTab(/timing/i);

		expect(screen.getByText("DNS")).toBeTruthy();
		expect(screen.queryByText("No timing recorded")).toBeNull();
	});

	it("offers no Save as example, which would store an exchange that never happened", () => {
		renderViewer();

		expect(screen.queryByRole("button", { name: /save as example/i })).toBeNull();
	});

	it("offers no Copy or Download, there being no body to act on", () => {
		renderViewer();

		expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
		expect(screen.queryByRole("button", { name: /download/i })).toBeNull();
	});

	it("still offers Save as example for a response that did arrive", () => {
		state.response = failedResponse({ status: 200, statusText: "OK", errorCode: undefined });
		renderViewer();

		expect(screen.getByRole("button", { name: /save as example/i })).toBeTruthy();
	});

	it("dims under a re-send and says it is busy, like every other response", () => {
		state.isExecuting = true;
		const { container } = renderViewer();

		expect(container.querySelector("[aria-busy='true']")).toBeTruthy();
		expect(screen.getByRole("tablist").closest(".opacity-60")).toBeTruthy();
	});
});
