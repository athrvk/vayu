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
 * "Copy for agent" on a collection row (#2047).
 *
 * `collectionReference` takes the chain *above* the collection, so a folder's
 * own name must not be said twice, and a root collection carries no `in`
 * tail. The collection's variables and auth hold secrets that must not ride.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useTabsStore, useToastStore } from "@/stores";
import { useCollectionsStore } from "./collections-store";
import CollectionTree from "./CollectionTree";

const SENTINEL = "s3cr3t-sentinel";

const secrets = { variables: { token: SENTINEL }, auth: { mode: "bearer", token: SENTINEL } };

const collections = [
	{ id: "acme", name: "Acme API", order: 0, ...secrets },
	{ id: "billing", name: "Billing", parentId: "acme", order: 0, ...secrets },
	{ id: "invoices", name: "Invoices", parentId: "billing", order: 0, ...secrets },
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
	useCreateRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useRestoreTrashMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useMockServersQuery: () => ({ data: [] }),
	useStopMockServerMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const writeText = vi.fn();

beforeEach(() => {
	writeText.mockReset().mockResolvedValue(undefined);
	// jsdom ships no clipboard, and `useCopy` reports a rejection rather than
	// claiming a copy that did not happen - so the stub has to resolve.
	Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
	Element.prototype.scrollIntoView = vi.fn();
	useToastStore.setState({ toasts: [] });
	useTabsStore.setState({ openTabs: [], activeTabId: null });
	useCollectionsStore.setState({
		expandedCollectionIds: new Set(["acme", "billing", "invoices"]),
	});
});

async function copyForAgent(collectionId: string) {
	render(
		<QueryClientProvider
			client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
		>
			<TooltipProvider>
				<CollectionTree />
			</TooltipProvider>
		</QueryClientProvider>
	);
	const row = document.querySelector<HTMLElement>(`[data-collection-id="${collectionId}"]`)!;
	fireEvent.contextMenu(row);
	fireEvent.click(await screen.findByRole("menuitem", { name: /Copy for agent/ }));
	await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
	return writeText.mock.calls[0][0] as string;
}

describe("Copy for agent on a collection row", () => {
	it("copies a nested collection with the chain above it, not its own name twice", async () => {
		expect(await copyForAgent("invoices")).toBe(
			'Vayu collection "Invoices" (invoices) in Acme API / Billing'
		);
		await waitFor(() =>
			expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
				"Reference copied",
			])
		);
	});

	it("copies a root collection with no `in` tail", async () => {
		expect(await copyForAgent("acme")).toBe('Vayu collection "Acme API" (acme)');
	});

	it("never carries the collection's variables or auth", async () => {
		expect(await copyForAgent("billing")).not.toContain(SENTINEL);
	});
});
