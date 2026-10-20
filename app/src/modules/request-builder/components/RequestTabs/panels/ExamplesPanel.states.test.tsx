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
 * The Examples tab's states and row actions go through the shared primitives
 * (#2314): the skeleton, `ErrorState`, `EmptyState` and `Callout`, the row's
 * `CopyForAgentButton`, and the `rowActionDestructive` Delete. A hand-rolled
 * line of text for any of them misses the fixes those primitives receive, so
 * these assert on the rendered primitive, not on the words it happens to say.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useImportModalStore } from "@/stores";
import { RequestBuilderContext } from "../../../context/RequestBuilderContext";
import type { RequestBuilderContextValue, RequestState } from "../../../types";
import { createDefaultRequestState } from "../../../utils/request-state";
import type { RequestExample } from "@/types";
import ExamplesPanel from "./ExamplesPanel";

const getRequest = vi.fn();
const listRequestExamples = vi.fn();
const listCollections = vi.fn();
const deleteRequestExample = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: {
		getRequest: (id: string) => getRequest(id),
		listRequestExamples: (id: string) => listRequestExamples(id),
		listCollections: () => listCollections(),
		deleteRequestExample: (requestId: string, exampleId: string) =>
			deleteRequestExample(requestId, exampleId),
		updateRequest: vi.fn(),
	},
}));

const EXAMPLE: RequestExample = {
	id: "exa_a",
	name: "Happy path",
	status: 200,
	headers: [],
	body: "{}",
	contentType: "application/json",
	origin: "user",
};

beforeEach(() => {
	cleanup();
	getRequest
		.mockReset()
		.mockResolvedValue({ id: "req_1", collectionId: "col_1", name: "List pets" });
	listRequestExamples.mockReset().mockResolvedValue([EXAMPLE]);
	listCollections.mockReset().mockResolvedValue([{ id: "col_1", name: "Pets", parentId: null }]);
	deleteRequestExample.mockReset().mockResolvedValue(undefined);
	useImportModalStore.setState({ isOpen: false });
});

function renderPanel(request: Partial<RequestState> = { id: "req_1" }) {
	const value = {
		request: { ...createDefaultRequestState(), ...request },
		updateField: vi.fn(),
		setRequest: vi.fn(),
		activeTab: "examples",
		setActiveTab: vi.fn(),
	} as unknown as RequestBuilderContextValue;
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	render(
		<QueryClientProvider client={client}>
			<RequestBuilderContext.Provider value={value}>
				<ExamplesPanel />
			</RequestBuilderContext.Provider>
		</QueryClientProvider>
	);
	return client;
}

const emptyState = () => document.querySelector('[data-slot="empty-state"]');

describe("the Examples panel's states", () => {
	it("draws an unsaved request as an inline EmptyState", () => {
		renderPanel({ id: undefined });
		expect(emptyState()?.textContent).toMatch(/Save this request/i);
		expect(listRequestExamples).not.toHaveBeenCalled();
	});

	it("labels the loading skeleton instead of printing a loading sentence", async () => {
		listRequestExamples.mockReturnValue(new Promise(() => {}));
		renderPanel();

		expect(
			await screen.findByRole("status", { name: "Loading example responses" })
		).toBeTruthy();
		expect(screen.queryByText(/Loading examples/)).toBeNull();
	});

	it("draws a failed read as an ErrorState with the reason and a working Try again", async () => {
		listRequestExamples.mockRejectedValueOnce(new Error("engine unreachable"));
		renderPanel();

		expect(await screen.findByText("Couldn't load example responses")).toBeTruthy();
		expect(screen.getByText("engine unreachable")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(await screen.findByText("Happy path")).toBeTruthy();
		expect(listRequestExamples).toHaveBeenCalledTimes(2);
	});

	it("keeps still-valid rows when a background refetch fails", async () => {
		const client = renderPanel();
		expect(await screen.findByText("Happy path")).toBeTruthy();

		listRequestExamples.mockRejectedValue(new Error("engine unreachable"));
		await client.refetchQueries();
		await waitFor(() => expect(listRequestExamples).toHaveBeenCalledTimes(2));

		expect(screen.getByText("Happy path")).toBeTruthy();
		expect(screen.queryByText(/Couldn.t load example responses/)).toBeNull();
	});

	it("draws no examples as an EmptyState whose action opens the import dialog", async () => {
		listRequestExamples.mockResolvedValue([]);
		renderPanel();

		expect(await screen.findByText("No example responses")).toBeTruthy();
		expect(emptyState()).not.toBeNull();
		// The rich sentence names the Save as example action it points at.
		expect(emptyState()?.textContent).toContain("Save as example");

		fireEvent.click(screen.getByRole("button", { name: "Import a collection" }));
		expect(useImportModalStore.getState().isOpen).toBe(true);
	});
});

describe("an example row's actions", () => {
	it("takes Copy from CopyForAgentButton, under the same name", async () => {
		renderPanel();
		const copy = await screen.findByRole("button", {
			name: "Copy example Happy path for agent",
		});
		// The shared button's compact hit area; the hand-rolled one was `size-target`.
		expect(copy.className).toContain("size-control-sm");
		expect(copy.getAttribute("title")).toBe("Copy for agent");
	});

	it("hovers Delete's glyph to destructive, not the ghost fill", async () => {
		renderPanel();
		const del = await screen.findByRole("button", { name: "Delete example Happy path" });
		expect(del.className).toContain("hover:text-destructive-text");
		expect(del.className).toContain("hover:bg-accent-active");
	});

	it("shows the engine's refusal as a blocking Callout outside the description", async () => {
		deleteRequestExample.mockRejectedValue(new Error("Example not found"));
		renderPanel();

		fireEvent.click(await screen.findByRole("button", { name: "Delete example Happy path" }));
		fireEvent.click(screen.getByRole("button", { name: /^delete example$/i }));

		const refusal = await screen.findByText(/Couldn.t delete the example: Example not found/);
		expect(refusal.closest('[class*="border-destructive/40"]')).not.toBeNull();
		expect(refusal.closest("p")).toBeNull();
	});
});
