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
 * Which saved example a mock server answers with (issue #481 phase 3).
 *
 * A property of the persisted request, not of any running mock - editing it
 * here takes effect the next time a mock for this collection starts, exactly
 * like every other change to a saved example does. It is read through
 * `useRequestQuery` rather than the builder's own `RequestState`, so this test
 * drives the real query cache (`@/services/api` mocked, everything above it
 * real) instead of stubbing the hooks: a control that only ever renders
 * against a stubbed "fixed" mode would never notice the panel reading nothing
 * back after its own write, which is this codebase's most repeated defect.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RequestBuilderContext } from "../../../context/RequestBuilderContext";
import type { RequestBuilderContextValue, RequestState } from "../../../types";
import { createDefaultRequestState } from "../../../utils/request-state";
import type { RequestExample } from "@/types";
import ExamplesPanel from "./ExamplesPanel";

const getRequest = vi.fn();
const listRequestExamples = vi.fn();
const updateRequest = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: {
		getRequest: (id: string) => getRequest(id),
		listRequestExamples: (id: string) => listRequestExamples(id),
		deleteRequestExample: vi.fn(),
		updateRequest: (data: unknown) => updateRequest(data),
	},
}));

function renderPanel(request: Partial<RequestState> = {}) {
	const value = {
		request: { ...createDefaultRequestState(), ...request },
		updateField: vi.fn(),
		setRequest: vi.fn(),
		activeTab: "examples",
		setActiveTab: vi.fn(),
	} as unknown as RequestBuilderContextValue;
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	render(
		<QueryClientProvider client={client}>
			<RequestBuilderContext.Provider value={value}>
				<ExamplesPanel />
			</RequestBuilderContext.Provider>
		</QueryClientProvider>
	);
}

const example = (over: Partial<RequestExample> = {}): RequestExample => ({
	id: "exa_a",
	name: "A",
	status: 200,
	headers: [],
	body: "a",
	contentType: "text/plain",
	origin: "user",
	...over,
});

const REQUEST = {
	id: "req_1",
	collectionId: "col_1",
	name: "Req",
	method: "GET",
	url: "https://example.test",
	mockResponseMode: "first",
};

beforeEach(() => {
	getRequest.mockReset();
	listRequestExamples.mockReset();
	updateRequest.mockReset();
	getRequest.mockResolvedValue(REQUEST);
	listRequestExamples.mockResolvedValue([
		example(),
		example({ id: "exa_b", name: "B", status: 500 }),
	]);
	// Echoes the merge-patch back merged onto the stored row, the same shape
	// the engine's real PUT response has.
	updateRequest.mockImplementation((data) =>
		Promise.resolve({ ...REQUEST, ...(data as object) })
	);
});

describe("ExamplesPanel mock response mode", () => {
	it("shows First saved example selected by default", async () => {
		renderPanel({ id: "req_1" });
		expect(await screen.findByRole("radio", { name: /first/i })).toBeChecked();
	});

	it("writes fixed mode with the chosen example id", async () => {
		renderPanel({ id: "req_1" });

		fireEvent.click(await screen.findByRole("radio", { name: /specific/i }));
		fireEvent.click(await screen.findByRole("combobox"));
		fireEvent.click(await screen.findByRole("option", { name: "B" }));

		await waitFor(() =>
			expect(updateRequest).toHaveBeenLastCalledWith(
				expect.objectContaining({
					id: "req_1",
					mockResponseMode: "fixed",
					mockExampleId: "exa_b",
				})
			)
		);
	});

	it("writes random mode and clears the fixed example id", async () => {
		renderPanel({ id: "req_1" });

		fireEvent.click(await screen.findByRole("radio", { name: /random/i }));

		await waitFor(() =>
			expect(updateRequest).toHaveBeenCalledWith(
				expect.objectContaining({
					id: "req_1",
					mockResponseMode: "random",
					mockExampleId: null,
				})
			)
		);
	});
});
