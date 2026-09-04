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
 * Right-click on a tree row (#1360).
 *
 * The tree answered the Menu key, Shift+F10 and Shift+Enter long before it
 * answered the mouse gesture every other desktop tool answers. What these cases
 * pin is not that *a* menu opens but that it is the *same* menu: both routes are
 * driven here and their item labels compared, so a row that grows an action for
 * one route and not the other fails.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useTabsStore } from "@/stores";
import { CONTEXT_ATTRIBUTE } from "@/lib/context-menu";
import { useCollectionsStore } from "./collections-store";
import CollectionTree from "./CollectionTree";

const collections = [{ id: "acme", name: "Acme", order: 0 }];
const requests = new Map([
	[
		"acme",
		[
			{ id: "r-ping", collectionId: "acme", name: "Ping", method: "GET", order: 0 },
			{ id: "r-pong", collectionId: "acme", name: "Pong", method: "POST", order: 1 },
		],
	],
]);

/** The create call a Duplicate makes, so a test can see which row it copied. */
const createRequest = vi.fn().mockResolvedValue({ id: "r-copy" });

vi.mock("@/queries", () => ({
	useReorderMutation: () => ({ mutate: vi.fn(), isPending: false }),
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
	useCreateRequestMutation: () => ({ mutateAsync: createRequest, isPending: false }),
	useDeleteRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useRestoreTrashMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
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

const collectionRow = () => document.querySelector<HTMLElement>('[data-collection-id="acme"]')!;
const requestRow = (id = "r-ping") =>
	document.querySelector<HTMLElement>(`[data-request-id="${id}"]`)!;

/** The labels the open menu is offering, in order. */
function menuLabels(): string[] {
	return screen.getAllByRole("menuitem").map((item) => item.textContent?.trim() ?? "");
}

async function closeMenu() {
	fireEvent.keyDown(await screen.findByRole("menu"), { key: "Escape" });
	await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
}

beforeEach(() => {
	createRequest.mockClear();
	Element.prototype.scrollIntoView = vi.fn();
	useCollectionsStore.setState({ expandedCollectionIds: new Set(["acme"]) });
	useTabsStore.setState({ openTabs: [], activeTabId: null });
});

describe("right-click on a tree row", () => {
	const ROWS: [string, () => HTMLElement][] = [
		["a collection row", collectionRow],
		["a request row", requestRow],
	];

	for (const [name, row] of ROWS) {
		it(`offers ${name} exactly what its ⋯ menu offers`, async () => {
			renderTree();

			// The keyboard route, which reaches the ⋯ menu.
			row().focus();
			fireEvent.keyDown(row(), { key: "F10", shiftKey: true });
			await screen.findByRole("menu");
			const fromMenuButton = menuLabels();
			await closeMenu();

			fireEvent.contextMenu(row());

			await screen.findByRole("menu");
			expect(menuLabels()).toEqual(fromMenuButton);
			expect(fromMenuButton.length).toBeGreaterThan(0);
		});
	}

	it("acts on the row under the pointer, not the one that is open", async () => {
		renderTree();
		// Open "Ping", which is what selection means in this tree: the row with
		// the active tab is the selected one (`CollectionTree.tsx`).
		fireEvent.click(requestRow("r-ping"));
		await waitFor(() => expect(requestRow("r-ping")).toHaveAttribute("aria-selected", "true"));

		fireEvent.contextMenu(requestRow("r-pong"));
		fireEvent.click(await screen.findByRole("menuitem", { name: /Duplicate/ }));

		// The pointed-at row's request, not the open one's - the property the
		// issue's "select the row first" step exists to guarantee, which each
		// row's actions give for free by closing over their own entity.
		await waitFor(() => expect(createRequest).toHaveBeenCalledTimes(1));
		expect(createRequest.mock.calls[0][0]).toMatchObject({ name: "Pong (Copy)" });
	});

	it("offers a request row its own actions and not a folder's", async () => {
		renderTree();

		fireEvent.contextMenu(requestRow());

		await screen.findByRole("menu");
		expect(screen.getByRole("menuitem", { name: /Duplicate/ })).toBeInTheDocument();
		expect(screen.queryByRole("menuitem", { name: /Export as OpenAPI/ })).toBeNull();
	});

	// Both row types: a folder row missing what a request row has is how the
	// Delete key went dead in this tree for months.
	for (const [name, row] of ROWS) {
		it(`hands focus back to ${name} on Escape`, async () => {
			renderTree();

			fireEvent.contextMenu(row());
			await screen.findByRole("menu");
			await closeMenu();

			await waitFor(() => expect(document.activeElement).toBe(row()));
		});
	}

	it("marks the rows so the main process draws no menu of its own over them", () => {
		renderTree();

		expect(collectionRow()).toHaveAttribute(CONTEXT_ATTRIBUTE, "own-menu");
		expect(requestRow()).toHaveAttribute(CONTEXT_ATTRIBUTE, "own-menu");
	});

	it("stands down while a row is being renamed, so the field keeps Cut/Copy/Paste", async () => {
		renderTree();

		requestRow().focus();
		fireEvent.keyDown(requestRow(), { key: "F2" });
		await waitFor(() => expect(requestRow().querySelector("input")).not.toBeNull());

		// The marker is what refuses the main process's edit menu, so it has to
		// come off with the row's own menu - otherwise a right-click in the
		// rename field offers nothing at all.
		expect(requestRow()).not.toHaveAttribute(CONTEXT_ATTRIBUTE);
		fireEvent.contextMenu(requestRow().querySelector("input")!);
		expect(screen.queryByRole("menu")).not.toBeInTheDocument();
	});
});
