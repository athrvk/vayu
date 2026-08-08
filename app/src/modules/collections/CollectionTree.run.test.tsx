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
 * Running a folder from the tree.
 *
 * The entry point is the row's ⋯ menu, where every other collection action
 * already lives, and it opens the run dialog pointed at that row's collection.
 * The row that opened it is the part worth pinning: one dialog is rendered for
 * the whole tree, so nothing but the click tells it which folder to run, and
 * getting that wrong would run a different collection than the one asked for.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useTabsStore } from "@/stores";
import { useCollectionsStore } from "./collections-store";
import CollectionTree from "./CollectionTree";

const startScenarioRun = vi.fn();

const collections = [
	{ id: "root", name: "Acme", order: 0 },
	{ id: "mid", name: "Billing", parentId: "root", order: 0 },
];
const requests = new Map([
	["root", [{ id: "r-root", collectionId: "root", name: "Ping", method: "GET", order: 0 }]],
	["mid", [{ id: "r-mid", collectionId: "mid", name: "Charge", method: "POST", order: 0 }]],
]);

vi.mock("@/queries", () => ({
	useCollectionsQuery: () => ({
		data: collections,
		isLoading: false,
		isError: false,
		error: null,
		refetch: vi.fn(),
	}),
	useMultipleCollectionRequests: () => ({ requestsByCollection: requests }),
	useCreateCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useCreateRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useStartScenarioRunMutation: () => ({
		mutate: startScenarioRun,
		reset: vi.fn(),
		isPending: false,
		error: null,
	}),
}));

vi.mock("@/services", () => ({
	scenarioRunService: { startMonitoring: vi.fn() },
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

/** Radix opens the row menu on pointerdown, not click. */
async function openRunDialog(collectionName: string) {
	fireEvent.pointerDown(
		screen.getByRole("button", { name: `More actions for ${collectionName}` }),
		{ button: 0, ctrlKey: false, pointerType: "mouse" }
	);
	fireEvent.click(await screen.findByRole("menuitem", { name: /Run collection/ }));
}

beforeEach(() => {
	Element.prototype.scrollIntoView = vi.fn();
	startScenarioRun.mockReset();
	useCollectionsStore.setState({ expandedCollectionIds: new Set(["root", "mid"]) });
	useTabsStore.setState({ openTabs: [], activeTabId: null });
});

describe("running a collection from the tree", () => {
	it("offers Run collection in every collection row's menu", async () => {
		renderTree();
		fireEvent.pointerDown(screen.getByRole("button", { name: "More actions for Billing" }), {
			button: 0,
			ctrlKey: false,
			pointerType: "mouse",
		});

		expect(await screen.findByRole("menuitem", { name: /Run collection/ })).toBeTruthy();
	});

	it("runs the collection whose row opened the dialog", async () => {
		renderTree();
		await openRunDialog("Billing");

		expect(screen.getByText(/Run Billing/)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

		expect(startScenarioRun).toHaveBeenCalledTimes(1);
		expect(startScenarioRun.mock.calls[0][0].scenario).toMatchObject({
			source: "collection",
			collectionId: "mid",
		});
	});

	it("closes without starting anything when cancelled", async () => {
		renderTree();
		await openRunDialog("Acme");

		fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

		expect(startScenarioRun).not.toHaveBeenCalled();
		expect(screen.queryByText(/Run Acme/)).toBeNull();
	});
});
