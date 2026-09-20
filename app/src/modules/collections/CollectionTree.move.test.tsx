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
 * Move up / Move down in a tree row's menu (issue #1690).
 *
 * The tree reordered by drag and by Alt+Arrow only: one needs a pointer, the
 * other needs to be known already, so a keyboard user who had not read the
 * shortcut list could not reorder the tree at all - while the element list has
 * carried the same two items in its menu all along.
 *
 * These cases drive the menu, not the chord, and assert the write: the items go
 * through the same `moveByKeyboard` the chords do, so what is under test here is
 * that the menu reaches it and that the ends are gated off the same block the
 * announcement is computed from. The drag and chord halves of that path are
 * covered in `CollectionTree.dnd.test.tsx`; this file needs no layout stubs,
 * because a menu click is not a pointer gesture.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useCollectionsStore } from "./collections-store";
import { useTabsStore, useToastStore } from "@/stores";
import type { ReorderRequest } from "@/types";
import CollectionTree from "./CollectionTree";

/**
 * Alpha [c1] - One [r1], Two [r2], Three [r3]
 * Beta  [c2] - empty
 */
interface Fixture {
	collections: { id: string; name: string; order: number; parentId?: string | null }[];
	requests: Map<
		string,
		{ id: string; collectionId: string; name: string; method: string; order: number }[]
	>;
}

let fixture: Fixture;

function freshFixture(): Fixture {
	return {
		collections: [
			{ id: "c1", name: "Alpha", order: 0 },
			{ id: "c2", name: "Beta", order: 1 },
		],
		requests: new Map([
			[
				"c1",
				[
					{ id: "r1", collectionId: "c1", name: "One", method: "GET", order: 0 },
					{ id: "r2", collectionId: "c1", name: "Two", method: "GET", order: 1 },
					{ id: "r3", collectionId: "c1", name: "Three", method: "GET", order: 2 },
				],
			],
			["c2", []],
		]),
	};
}

/**
 * Applies the plan to the fixture rather than swallowing it, for the reason
 * `CollectionTree.dnd.test.tsx` gives: a second move has to plan from where the
 * row actually is, and an inert mock tests the opposite of the real thing.
 */
const reorderMutate = vi.fn((plan: ReorderRequest) => {
	for (const move of plan.moves) {
		if (move.type === "collection") {
			const row = fixture.collections.find((c) => c.id === move.id);
			if (row) row.order = move.order;
			continue;
		}
		for (const [, rows] of fixture.requests) {
			const row = rows.find((r) => r.id === move.id);
			if (row) {
				row.order = move.order;
				break;
			}
		}
	}
	for (const [, rows] of fixture.requests) rows.sort((a, b) => a.order - b.order);
	fixture.collections.sort((a, b) => a.order - b.order);
});

vi.mock("@/queries", () => ({
	useCollectionsQuery: () => ({
		data: fixture.collections,
		isLoading: false,
		isError: false,
		error: null,
		refetch: vi.fn(),
	}),
	useMultipleCollectionRequests: () => ({ requestsByCollection: fixture.requests }),
	useReorderMutation: () => ({ mutate: reorderMutate, isPending: false }),
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

/** Opens a row's `⋯` menu. `pointerDown` is the event Radix's trigger listens on. */
async function openRowMenu(label: string) {
	fireEvent.pointerDown(screen.getByRole("button", { name: label }), {
		button: 0,
		ctrlKey: false,
		pointerType: "mouse",
	});
	return screen.findByRole("menu");
}

const requestMenu = (name: string) => openRowMenu(`More actions for request ${name}`);

beforeEach(() => {
	Element.prototype.scrollIntoView = vi.fn();
	fixture = freshFixture();
	reorderMutate.mockClear();
	useCollectionsStore.setState({ expandedCollectionIds: new Set(["c1"]) });
	useTabsStore.setState({ openTabs: [], activeTabId: null });
	useToastStore.setState({ toasts: [] });
});

describe("the row menu's move entries", () => {
	it("offers them on a request row and on a folder row", async () => {
		renderTree();

		const requests = await requestMenu("One");
		expect(within(requests).getByRole("menuitem", { name: /Move up/ })).toBeTruthy();
		expect(within(requests).getByRole("menuitem", { name: /Move down/ })).toBeTruthy();
		fireEvent.keyDown(requests, { key: "Escape" });

		const folder = await openRowMenu("More actions for Alpha");
		expect(within(folder).getByRole("menuitem", { name: /Move up/ })).toBeTruthy();
		expect(within(folder).getByRole("menuitem", { name: /Move down/ })).toBeTruthy();
	});

	/**
	 * The same batch a drag of One onto Two's lower half sends - the point of
	 * routing the menu through `moveByKeyboard` rather than a second reorder
	 * path. Mutation check: point `Move down` at `"up"` and the orders invert.
	 */
	it("moves the first request down through the mutation drag uses", async () => {
		renderTree();

		const menu = await requestMenu("One");
		fireEvent.click(within(menu).getByRole("menuitem", { name: /Move down/ }));

		expect(reorderMutate).toHaveBeenCalledTimes(1);
		expect(reorderMutate.mock.calls[0][0]).toEqual({
			moves: [
				{ type: "request", id: "r2", order: 0 },
				{ type: "request", id: "r1", order: 1 },
			],
			normalize: [],
		});
		// And the fixture the mock applied it to agrees, so the move persisted
		// rather than only being asked for.
		expect(fixture.requests.get("c1")?.map((r) => r.id)).toEqual(["r2", "r1", "r3"]);
	});

	it("moves a folder down among its siblings", async () => {
		renderTree();

		const menu = await openRowMenu("More actions for Alpha");
		fireEvent.click(within(menu).getByRole("menuitem", { name: /Move down/ }));

		expect(reorderMutate.mock.calls[0][0]).toEqual({
			moves: [
				{ type: "collection", id: "c2", order: 0 },
				{ type: "collection", id: "c1", order: 1 },
			],
			normalize: [],
		});
	});

	/**
	 * Off at the ends, with the reason on the item: a disabled menu item cannot
	 * hold a tooltip, so `RowAction`'s `disabledReason` is where it goes. Gated
	 * off the same block the announcement is computed from, so "already first"
	 * and a disabled Move up cannot disagree.
	 */
	it("disables Move up on the first row and Move down on the last, and says why", async () => {
		renderTree();

		const first = await requestMenu("One");
		const up = within(first).getByRole("menuitem", { name: /Move up/ });
		expect(up).toHaveAttribute("aria-disabled", "true");
		expect(up.textContent).toMatch(/Already first/);
		expect(within(first).getByRole("menuitem", { name: /Move down/ })).not.toHaveAttribute(
			"aria-disabled",
			"true"
		);
		fireEvent.keyDown(first, { key: "Escape" });

		const last = await requestMenu("Three");
		const down = within(last).getByRole("menuitem", { name: /Move down/ });
		expect(down).toHaveAttribute("aria-disabled", "true");
		expect(down.textContent).toMatch(/Already last/);
	});

	it("writes nothing when a disabled entry is clicked anyway", async () => {
		renderTree();

		const menu = await requestMenu("One");
		fireEvent.click(within(menu).getByRole("menuitem", { name: /Move up/ }));

		expect(reorderMutate).not.toHaveBeenCalled();
	});

	/**
	 * The entries sit above the destructive tail rather than after it: the
	 * separator `rowActionRows` draws belongs to Delete, and an item below it
	 * reads as part of the destructive group.
	 */
	it("keeps them above the row's destructive actions", async () => {
		renderTree();

		const menu = await openRowMenu("More actions for Alpha");
		const labels = within(menu)
			.getAllByRole("menuitem")
			.map((item) => item.textContent ?? "");
		const moveDown = labels.findIndex((l) => l.startsWith("Move down"));
		const del = labels.findIndex((l) => l.startsWith("Delete"));
		expect(moveDown).toBeGreaterThan(-1);
		expect(del).toBeGreaterThan(moveDown);
	});
});
