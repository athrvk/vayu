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
 * "Copy for agent" on an example row (#2047).
 *
 * An icon button: a landed copy swaps the glyph and raises no toast. The line
 * names the example, the SAVED request that owns it and that request's
 * collection chain - not the builder's draft, whose unsaved rename the engine
 * and the agent's tools do not know. The real query cache runs under a mocked
 * transport, so the saved row and the collection list arrive the way they do in
 * the app.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useToastStore } from "@/stores";
import { RequestBuilderContext } from "../../../context/RequestBuilderContext";
import type { RequestBuilderContextValue } from "../../../types";
import { createDefaultRequestState } from "../../../utils/request-state";
import type { RequestExample } from "@/types";
import ExamplesPanel from "./ExamplesPanel";

const SENTINEL = "s3cr3t-sentinel";

const getRequest = vi.fn();
const listRequestExamples = vi.fn();
const listCollections = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: {
		getRequest: (id: string) => getRequest(id),
		listRequestExamples: (id: string) => listRequestExamples(id),
		listCollections: () => listCollections(),
		deleteRequestExample: vi.fn(),
		updateRequest: vi.fn(),
	},
}));

const SAVED_REQUEST = {
	id: "req_1",
	collectionId: "col_v2",
	name: "List pets",
	method: "GET",
	url: `https://api.test/pets?token=${SENTINEL}`,
	headers: { Authorization: `Bearer ${SENTINEL}` },
	auth: { type: "bearer", bearer: { token: SENTINEL } },
	variables: { secret: SENTINEL },
	mockResponseMode: "first",
};

const EXAMPLE: RequestExample = {
	id: "exa_a",
	name: "Happy path",
	status: 200,
	headers: [{ key: "X-Key", value: SENTINEL, enabled: true }],
	body: SENTINEL,
	contentType: "text/plain",
	origin: "user",
};

const writeText = vi.fn();

beforeEach(() => {
	cleanup();
	getRequest.mockReset().mockResolvedValue(SAVED_REQUEST);
	listRequestExamples.mockReset().mockResolvedValue([EXAMPLE]);
	listCollections.mockReset().mockResolvedValue([
		{ id: "col_root", name: "Pets", parentId: null },
		{ id: "col_v2", name: "v2", parentId: "col_root" },
	]);
	writeText.mockReset().mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
	useToastStore.setState({ toasts: [] });
});

function renderPanel() {
	const value = {
		// An unsaved rename the saved row does not have.
		request: { ...createDefaultRequestState(), id: "req_1", name: "Draft rename" },
		updateField: vi.fn(),
		setRequest: vi.fn(),
		activeTab: "examples",
		setActiveTab: vi.fn(),
	} as unknown as RequestBuilderContextValue;
	render(
		<QueryClientProvider
			client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
		>
			<RequestBuilderContext.Provider value={value}>
				<ExamplesPanel />
			</RequestBuilderContext.Provider>
		</QueryClientProvider>
	);
}

const copyButton = () => screen.findByRole("button", { name: "Copy example Happy path for agent" });

/** The glyph a button shows now; `IconSwap` keeps the other one invisible beside it. */
function liveGlyph(button: HTMLElement): string {
	return button.querySelector(".enter-fade svg")?.getAttribute("class") ?? "";
}

describe("Copy for agent on an example row", () => {
	it("copies the example, its saved request and the collection chain", async () => {
		renderPanel();
		fireEvent.click(await copyButton());

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText).toHaveBeenCalledWith(
			'Vayu example "Happy path" (exa_a) of request "List pets" (req_1) in Pets / v2'
		);
	});

	it("swaps the glyph to a check and raises no toast", async () => {
		renderPanel();
		const button = await copyButton();
		expect(liveGlyph(button)).toContain("lucide-copy");

		fireEvent.click(button);

		await waitFor(() => expect(liveGlyph(button)).toContain("lucide-check"));
		expect(useToastStore.getState().toasts).toEqual([]);
	});

	it("keeps the request's url, headers, auth and variables and the example's body off the clipboard", async () => {
		renderPanel();
		fireEvent.click(await copyButton());

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText.mock.calls[0][0]).not.toContain(SENTINEL);
	});

	it("offers no copy until the saved request has loaded", async () => {
		getRequest.mockReturnValue(new Promise(() => {}));
		renderPanel();

		await screen.findByText("Happy path");
		expect(screen.queryByRole("button", { name: /for agent/ })).toBeNull();
	});
});
