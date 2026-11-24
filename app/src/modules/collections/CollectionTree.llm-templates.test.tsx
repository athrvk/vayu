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
 * The menu beside the sidebar's "+" lists the LLM request templates (#3778).
 * It goes through the same `useNewRequest` flow as the "+", so these cases
 * read the payload the flow hands the engine, and where it lands.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useSessionStore, useTabsStore, useToastStore } from "@/stores";
import {
	ANTHROPIC_MESSAGES_PRESET,
	LLM_REQUEST_TEMPLATES,
	OPENAI_CHAT_COMPLETION_PRESET,
} from "@/modules/welcome/llm-request-presets";
import { useCollectionsStore } from "./collections-store";
import CollectionTree from "./CollectionTree";

const createRequest = vi.fn();

const collections = [
	{ id: "alpha", name: "Alpha", order: 0 },
	{ id: "beta", name: "Beta", order: 1 },
];

vi.mock("@/queries", () => ({
	useReorderMutation: () => ({ mutate: vi.fn(), isPending: false }),
	useCollectionsQuery: () => ({
		data: collections,
		isLoading: false,
		isError: false,
		error: null,
		refetch: vi.fn(),
	}),
	useMultipleCollectionRequests: () => ({ requestsByCollection: new Map() }),
	useCreateCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useCreateRequestMutation: () => ({ mutateAsync: createRequest, isPending: false }),
	useDeleteRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useRestoreTrashMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useMockServersQuery: () => ({ data: [] }),
}));

function renderTree() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<TooltipProvider>
				<CollectionTree />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

/** Radix opens a menu trigger on a key press, which jsdom delivers (it has no pointer capture). */
function openTemplateMenu() {
	fireEvent.keyDown(screen.getByRole("button", { name: "New request from a template" }), {
		key: "Enter",
	});
}

beforeEach(() => {
	createRequest.mockReset();
	createRequest.mockResolvedValue({ id: "r-new", collectionId: "alpha" });
	useSessionStore.setState({ lastCollectionId: "alpha" });
	useTabsStore.setState({ openTabs: [], activeTabId: null });
	useToastStore.setState({ toasts: [] });
	useCollectionsStore.setState({ expandedCollectionIds: new Set() });
});

describe("the tree's template menu", () => {
	it("lists both templates by name", () => {
		renderTree();
		openTemplateMenu();

		expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(
			LLM_REQUEST_TEMPLATES.map((t) => t.preset.name)
		);
	});

	it.each([
		["Chat completion (OpenAI-compatible)", OPENAI_CHAT_COMPLETION_PRESET],
		["Messages (Anthropic-style)", ANTHROPIC_MESSAGES_PRESET],
	])("creates a request from %s", async (name, preset) => {
		renderTree();
		openTemplateMenu();

		fireEvent.click(screen.getByRole("menuitem", { name }));

		await waitFor(() => expect(createRequest).toHaveBeenCalledTimes(1));
		expect(createRequest.mock.calls[0][0]).toEqual({
			...preset,
			collectionId: "alpha",
		});
	});

	it("lands in the collection whose tab is open, as the plus button does", async () => {
		useTabsStore.getState().openTab({ type: "collection", entityId: "beta" });
		renderTree();
		openTemplateMenu();

		fireEvent.click(screen.getByRole("menuitem", { name: /Messages/ }));

		await waitFor(() => expect(createRequest).toHaveBeenCalledTimes(1));
		expect(createRequest.mock.calls[0][0]).toMatchObject({ collectionId: "beta" });
	});

	it("leaves the plain plus button creating a blank request", async () => {
		renderTree();

		fireEvent.click(screen.getByRole("button", { name: "Add request" }));

		await waitFor(() => expect(createRequest).toHaveBeenCalledTimes(1));
		const payload = createRequest.mock.calls[0][0];
		expect(payload).toMatchObject({ method: "GET", url: "", collectionId: "alpha" });
		expect(payload.stream).toBeUndefined();
	});
});
