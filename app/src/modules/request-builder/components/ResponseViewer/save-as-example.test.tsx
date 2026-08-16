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
 * Saving a live response as an example (issue #588).
 *
 * The loop this closes - send, like the response, keep it as what the mock will
 * serve - is only as good as the payload it writes, so the assertions here are
 * on what reaches the api layer rather than on the dialog being openable:
 *
 * - **`origin: "user"`.** The one field with no reader in this app. A spec sync
 *   (#627) reads it to know it must leave the row alone, so a save that forgot
 *   it would look perfect here and lose the example on the next sync.
 * - **No `order`.** The engine appends when it is absent, and a mock server
 *   answers with the *first* example of a matched route - a save that positioned
 *   itself could change what a restarted mock serves.
 * - **The affordance's availability is honest.** An unsaved request has no id to
 *   nest an example under, and a live stream's placeholder response has no body
 *   yet; both are absent rather than a button that writes something wrong.
 * - **A truncated body says so on the row, not in the name.** The dialog warns,
 *   and `bodyTruncated: true` rides the payload (issue #659) - the name used to
 *   carry the disclosure, and a name is editable, so renaming at save time
 *   erased it.
 *
 * Rendered, not source-scanned: every one of those is decided at runtime from
 * the response and the request beside it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useExecutionEventsStore } from "@/stores";
import type { ResponseState } from "../../types";

// Monaco does not run under jsdom, and the body panel is not what this asserts.
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: ({ value }: { value?: string }) => <div data-testid="body-content">{value}</div>,
}));

const createRequestExample = vi.fn();
vi.mock("@/services/api", () => ({
	apiService: {
		createRequestExample: (requestId: string, example: unknown) =>
			createRequestExample(requestId, example),
	},
}));

const state: { response: ResponseState | null; isExecuting: boolean; request: { id?: string } } = {
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
	headers: { "Content-Type": "application/json", "X-Request-Id": "abc" },
	body: '{"id":1}',
	bodyRaw: '{"id":1}',
	bodyType: "json",
	size: 8,
	time: 12,
	...overrides,
});

function renderViewer() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<ResponseViewer />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

const saveButton = () => screen.queryByRole("button", { name: /save as example/i });

/** Opens the dialog and returns its name field. */
function openDialog(): HTMLInputElement {
	fireEvent.click(saveButton() as HTMLElement);
	return screen.getByLabelText(/^name/i) as HTMLInputElement;
}

describe("save response as example", () => {
	beforeEach(() => {
		cleanup();
		createRequestExample.mockReset();
		createRequestExample.mockResolvedValue({ id: "exa_1" });
		useExecutionEventsStore.getState().clear();
		state.response = null;
		state.isExecuting = false;
		state.request = { id: "req_1" };
	});

	it("is absent for an unsaved request, which has no id to attach one to", () => {
		state.request = {};
		state.response = okResponse();
		renderViewer();
		expect(saveButton()).toBeNull();
	});

	it("is absent while a stream is still open, whose response has no body yet", () => {
		state.response = null;
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
		renderViewer();
		expect(saveButton()).toBeNull();
	});

	it("writes the status, headers, body and a user origin - and never an order", async () => {
		state.response = okResponse();
		renderViewer();

		const name = openDialog();
		// The status line is the default, because that is what a saved response
		// is usually called.
		expect(name.value).toBe("200 OK");
		fireEvent.change(name, { target: { value: "Happy path" } });
		fireEvent.click(screen.getByRole("button", { name: /save example/i }));

		await waitFor(() => expect(createRequestExample).toHaveBeenCalledTimes(1));
		const [requestId, payload] = createRequestExample.mock.calls[0];
		expect(requestId).toBe("req_1");
		expect(payload).toEqual({
			name: "Happy path",
			status: 200,
			headers: [
				{ key: "Content-Type", value: "application/json", enabled: true },
				{ key: "X-Request-Id", value: "abc", enabled: true },
			],
			body: '{"id":1}',
			// The response's own Content-Type verbatim, the Postman importer's
			// rule - so an app-saved example and an imported one are served alike.
			contentType: "application/json",
			origin: "user",
			// The response was whole, and the payload says so rather than
			// leaving it to be assumed (issue #659).
			bodyTruncated: false,
		});
		expect("order" in payload).toBe(false);

		// The dialog closes on success rather than sitting open over the panel
		// that now lists the row.
		await waitFor(() => expect(screen.queryByLabelText(/^name/i)).toBeNull());
	});

	it("keeps a response with no Content-Type honest rather than guessing one", async () => {
		state.response = okResponse({ headers: { "X-Request-Id": "abc" } });
		renderViewer();

		openDialog();
		fireEvent.click(screen.getByRole("button", { name: /save example/i }));

		await waitFor(() => expect(createRequestExample).toHaveBeenCalledTimes(1));
		expect(createRequestExample.mock.calls[0][1].contentType).toBe("");
	});

	it("stores a truncated body as truncated, whatever the user renames it to", async () => {
		state.response = okResponse({ bodyTruncated: true, bodyBytes: 4096 });
		renderViewer();

		const name = openDialog();
		expect(screen.getByText(/not the whole response/i)).toBeTruthy();

		// The rename that used to erase the disclosure: the suffix was the only
		// record, so a user who typed over it left a partial example that a mock
		// server would then serve as a complete response.
		fireEvent.change(name, { target: { value: "Large order list" } });
		fireEvent.click(screen.getByRole("button", { name: /save example/i }));

		await waitFor(() => expect(createRequestExample).toHaveBeenCalledTimes(1));
		const payload = createRequestExample.mock.calls[0][1];
		expect(payload.name).toBe("Large order list");
		expect(payload.bodyTruncated).toBe(true);
	});

	// The other half of the flag: a whole response must not be marked partial,
	// or the chip means nothing on any row.
	it("sends bodyTruncated false for a complete response", async () => {
		state.response = okResponse();
		renderViewer();

		openDialog();
		fireEvent.click(screen.getByRole("button", { name: /save example/i }));

		await waitFor(() => expect(createRequestExample).toHaveBeenCalledTimes(1));
		expect(createRequestExample.mock.calls[0][1].bodyTruncated).toBe(false);
	});

	it("shows the engine's refusal in the dialog rather than closing over it", async () => {
		createRequestExample.mockRejectedValue(new Error("Example body is 2000000 bytes"));
		state.response = okResponse();
		renderViewer();

		openDialog();
		fireEvent.click(screen.getByRole("button", { name: /save example/i }));

		expect(await screen.findByText(/Example body is 2000000 bytes/)).toBeTruthy();
		// Still open, with the name the attempt used, so it can be retried.
		expect(screen.getByLabelText(/^name/i)).toBeTruthy();
	});

	it("refuses to save an example with no name", () => {
		state.response = okResponse();
		renderViewer();

		const name = openDialog();
		fireEvent.change(name, { target: { value: "   " } });
		const save = screen.getByRole("button", { name: /save example/i }) as HTMLButtonElement;
		expect(save.disabled).toBe(true);
		fireEvent.click(save);
		expect(createRequestExample).not.toHaveBeenCalled();
	});
});
