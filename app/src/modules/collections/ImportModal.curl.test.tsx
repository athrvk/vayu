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
 * A curl command pasted into the Paste tab is a request, not a collection
 * (#2250): the engine would answer "Unrecognized format", so the dialog offers
 * to open it as a new request instead and never sends it.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ImportModal } from "./ImportModal";
import { useImportModalStore, useToastStore } from "@/stores";
import { stubParse } from "./import-preview.testkit";

const flow = vi.hoisted(() => ({ newRequest: vi.fn() }));

vi.mock("@/hooks/useNewRequest", () => ({
	useNewRequest: () => ({
		newRequest: flow.newRequest,
		isCreating: false,
		pickerProps: { open: false, onOpenChange: vi.fn(), collections: [], onSelect: vi.fn() },
	}),
}));

const CURL = "curl https://x.test/a -H 'a: b'";

function renderModal() {
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<ImportModal />
		</QueryClientProvider>
	);
}

function pasteAndDetect(text: string) {
	const tab = screen.getByRole("tab", { name: /^Paste$/i });
	fireEvent.mouseDown(tab);
	fireEvent.click(tab);
	fireEvent.change(screen.getByPlaceholderText(/Paste/i), { target: { value: text } });
	fireEvent.click(screen.getByRole("button", { name: /Detect and preview/i }));
}

describe("ImportModal curl paste", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		flow.newRequest.mockClear();
		useToastStore.setState({ toasts: [] });
		useImportModalStore.setState({ isOpen: true });
	});

	it("names the curl option in the tab and the placeholder", () => {
		renderModal();
		pasteAndDetect("");
		expect(screen.queryByRole("tab", { name: /Paste JSON/i })).toBeNull();
		expect(screen.getByPlaceholderText(/or a cURL command/i)).toBeTruthy();
	});

	it("offers to open the command as a request instead of sending it to the engine", async () => {
		const parse = stubParse(() => null);
		renderModal();
		pasteAndDetect(CURL);

		expect(
			await screen.findByText(/This is a cURL command\. Open it as a new request\./)
		).toBeTruthy();
		expect(screen.queryByText(/Unrecogni[sz]ed format/i)).toBeNull();
		expect(parse).not.toHaveBeenCalled();
	});

	it("creates the request from the command, closes the dialog and discloses dropped flags", async () => {
		renderModal();
		pasteAndDetect(`${CURL} --retry 3`);

		fireEvent.click(await screen.findByRole("button", { name: /Open as new request/i }));

		expect(flow.newRequest).toHaveBeenCalledTimes(1);
		expect(flow.newRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				method: "GET",
				url: "https://x.test/a",
				headers: [expect.objectContaining({ key: "a", value: "b" })],
			})
		);
		await waitFor(() => expect(useImportModalStore.getState().isOpen).toBe(false));
		expect(useToastStore.getState().toasts.map((t) => t.title)).toContain(
			"Imported, minus some flags"
		);
	});

	it("drops the offer when the text is edited", async () => {
		renderModal();
		pasteAndDetect(CURL);
		await screen.findByText(/This is a cURL command/);

		fireEvent.change(screen.getByPlaceholderText(/Paste/i), { target: { value: "{}" } });

		expect(screen.queryByText(/This is a cURL command/)).toBeNull();
	});

	it("still sends a document to the engine", async () => {
		const parse = stubParse(() => null);
		renderModal();
		pasteAndDetect('{"info":{}}');

		await waitFor(() => expect(parse).toHaveBeenCalledTimes(1));
		expect(screen.queryByText(/This is a cURL command/)).toBeNull();
		expect(flow.newRequest).not.toHaveBeenCalled();
	});
});
