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
 * A collection row's two exports, from its ⋯ menu.
 *
 * `RowAction` is one flat list, so the two formats sit side by side rather
 * than under a submenu; what this locks is that each entry mounts its own
 * dialog, for the row it was chosen on. The dialogs are stubbed - what each
 * says is asserted in its own file.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useTabsStore } from "@/stores";
import type { Collection } from "@/types";
import { useCollectionsStore } from "./collections-store";
import CollectionTree from "./CollectionTree";

const collections = [{ id: "acme", name: "Acme", order: 0 }];

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

vi.mock("./ExportSpecDialog", () => ({
	default: ({ collection }: { collection: Collection }) => (
		<p data-testid="export-dialog">OpenAPI export of {collection.name}</p>
	),
}));
vi.mock("./ExportPostmanDialog", () => ({
	default: ({ collection }: { collection: Collection }) => (
		<p data-testid="export-dialog">Postman export of {collection.name}</p>
	),
}));

function renderTree() {
	return render(
		<QueryClientProvider
			client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
		>
			<TooltipProvider>
				<CollectionTree />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

/** Open the Acme row's menu the way the keyboard does (#1212). */
async function openRowMenu() {
	const row = document.querySelector<HTMLElement>('[data-collection-id="acme"]')!;
	row.focus();
	fireEvent.keyDown(row, { key: "F10", shiftKey: true });
	return await screen.findByRole("menu");
}

beforeEach(() => {
	Element.prototype.scrollIntoView = vi.fn();
	useCollectionsStore.setState({ expandedCollectionIds: new Set() });
	useTabsStore.setState({ openTabs: [], activeTabId: null });
});

describe("a collection row's export entries", () => {
	it("lists the Postman export directly under the OpenAPI one", async () => {
		renderTree();
		await openRowMenu();

		const labels = screen.getAllByRole("menuitem").map((item) => item.textContent);
		const openapi = labels.indexOf("Export as OpenAPI");
		expect(openapi).toBeGreaterThan(-1);
		expect(labels[openapi + 1]).toBe("Export as Postman Collection");
	});

	it.each([
		["Export as OpenAPI", "OpenAPI export of Acme"],
		["Export as Postman Collection", "Postman export of Acme"],
	])("%s mounts its own dialog for the row", async (entry, dialog) => {
		renderTree();
		await openRowMenu();

		fireEvent.click(screen.getByRole("menuitem", { name: entry }));

		const mounted = await screen.findAllByTestId("export-dialog");
		expect(mounted.map((node) => node.textContent)).toEqual([dialog]);
	});
});
