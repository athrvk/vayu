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
 * Drag, keyboard move, and undo in the collection tree (#367, phase 3 of #364).
 *
 * The tree is driven through real pointer events on real rows, with only the
 * two things jsdom cannot provide stubbed: layout (`getBoundingClientRect`) and
 * hit testing (`elementFromPoint`). Everything between the press and the batch -
 * the threshold, the zone, the block rule, the index math - is the code under
 * test rather than an assertion about it.
 *
 * The reorder mutation is mocked, but not inertly: it applies the plan to the
 * fixture, because an Undo has to plan from where the row is *after* the move
 * and a mock that changed nothing would test the opposite of the real thing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useCollectionsStore } from "./collections-store";
import { useTabsStore, useToastStore } from "@/stores";
import type { ReorderRequest } from "@/types";
import CollectionTree from "./CollectionTree";

const ROW_HEIGHT = 32;

/**
 * Alpha [c1]                      row 0
 *   Gamma [c3]                    row 1   (nested folder, expanded and empty)
 *   One [r1], Two [r2]            rows 2, 3
 * Beta [c2]                       row 4   (collapsed, so it can spring open)
 *   Three [r3]
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
			{ id: "c3", name: "Gamma", order: 0, parentId: "c1" },
		],
		requests: new Map([
			[
				"c1",
				[
					{ id: "r1", collectionId: "c1", name: "One", method: "GET", order: 0 },
					{ id: "r2", collectionId: "c1", name: "Two", method: "GET", order: 1 },
				],
			],
			["c2", [{ id: "r3", collectionId: "c2", name: "Three", method: "GET", order: 0 }]],
			["c3", []],
		]),
	};
}

/** What a real `onMutate` does to the caches, in the small: apply the batch. */
const reorderMutate = vi.fn((plan: ReorderRequest) => {
	for (const move of plan.moves) {
		if (move.type === "collection") {
			const row = fixture.collections.find((c) => c.id === move.id);
			if (!row) continue;
			row.order = move.order;
			if ("parentId" in move) row.parentId = move.parentId;
			continue;
		}
		for (const [collectionId, rows] of fixture.requests) {
			const row = rows.find((r) => r.id === move.id);
			if (!row) continue;
			row.order = move.order;
			const owner = move.collectionId ?? collectionId;
			if (owner !== collectionId) {
				fixture.requests.set(
					collectionId,
					rows.filter((r) => r.id !== move.id)
				);
				row.collectionId = owner;
				fixture.requests.set(owner, [...(fixture.requests.get(owner) ?? []), row]);
			}
			break;
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
}));

function renderTree() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const result = render(
		<QueryClientProvider client={qc}>
			<TooltipProvider>
				<CollectionTree />
			</TooltipProvider>
		</QueryClientProvider>
	);
	layout();
	return result;
}

/**
 * The layout jsdom does not do: rows stacked 32px apart in document order, and
 * a hit test that answers with whichever row a y coordinate lands in.
 */
function layout() {
	const rows = Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"]'));
	rows.forEach((row, index) => {
		row.getBoundingClientRect = () =>
			({
				top: index * ROW_HEIGHT,
				bottom: (index + 1) * ROW_HEIGHT,
				height: ROW_HEIGHT,
				left: 0,
				right: 240,
				width: 240,
				x: 0,
				y: index * ROW_HEIGHT,
				toJSON: () => ({}),
			}) as DOMRect;
	});
	document.elementFromPoint = (_x: number, y: number) => rows[Math.floor(y / ROW_HEIGHT)] ?? null;
}

const row = (selector: string) => document.querySelector<HTMLElement>(selector)!;
const requestRow = (id: string) => row(`[data-request-id="${id}"]`);
const collectionRow = (id: string) => row(`[data-collection-id="${id}"]`);

/** Index of a row in document order - the y coordinates are derived from it. */
function rowIndex(el: HTMLElement): number {
	return Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"]')).indexOf(el);
}

/** A y coordinate `fraction` of the way down the row at `index`. */
const yIn = (index: number, fraction: number) => index * ROW_HEIGHT + ROW_HEIGHT * fraction;

interface DragOptions {
	/** Leave the pointer down, for asserting on mid-drag state. */
	hold?: boolean;
}

function startDrag(source: HTMLElement) {
	const from = yIn(rowIndex(source), 0.5);
	fireEvent.pointerDown(source, { button: 0, pointerId: 1, clientX: 10, clientY: from });
	// One move past the 4px threshold, still over the source row.
	fireEvent.pointerMove(source, { pointerId: 1, clientX: 10, clientY: from + 6 });
}

function dragTo(source: HTMLElement, y: number, options: DragOptions = {}) {
	startDrag(source);
	fireEvent.pointerMove(source, { pointerId: 1, clientX: 10, clientY: y });
	if (options.hold) return;
	fireEvent.pointerUp(source, { pointerId: 1, clientX: 10, clientY: y });
}

beforeEach(() => {
	// jsdom has no layout and therefore no scrollIntoView; the reveal after a
	// move calls it (see CollectionTree.reveal.test.tsx, same stub).
	Element.prototype.scrollIntoView = vi.fn();
	fixture = freshFixture();
	reorderMutate.mockClear();
	useCollectionsStore.setState({ expandedCollectionIds: new Set(["c1", "c3"]) });
	useTabsStore.setState({ openTabs: [], activeTabId: null });
	useToastStore.setState({ toasts: [] });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("a drag that crosses the threshold", () => {
	it("never opens the row it started on", () => {
		renderTree();
		dragTo(requestRow("r1"), yIn(3, 0.8));
		// The browser fires this after every completed drag; the row's own click
		// handler would open a tab on it.
		fireEvent.click(requestRow("r1"));
		expect(useTabsStore.getState().openTabs).toHaveLength(0);
	});

	it("still lets a press that never moved open the row", () => {
		renderTree();
		const target = requestRow("r1");
		fireEvent.pointerDown(target, { button: 0, pointerId: 1, clientX: 10, clientY: 80 });
		// Two pixels: inside the threshold, so this is a click with a tremor.
		fireEvent.pointerMove(target, { pointerId: 1, clientX: 12, clientY: 80 });
		fireEvent.pointerUp(target, { pointerId: 1, clientX: 12, clientY: 80 });
		fireEvent.click(target);
		expect(useTabsStore.getState().openTabs).toHaveLength(1);
	});
});

describe("a drop", () => {
	it("sends one batch holding only the rows whose position changed", () => {
		renderTree();
		// Two onto One's upper half: a reorder inside Alpha's requests.
		dragTo(requestRow("r2"), yIn(rowIndex(requestRow("r1")), 0.2));

		expect(reorderMutate).toHaveBeenCalledTimes(1);
		expect(reorderMutate.mock.calls[0][0]).toEqual({
			moves: [
				{ type: "request", id: "r2", order: 0 },
				{ type: "request", id: "r1", order: 1 },
			],
			normalize: [],
		});
		// No undo offer: the row is still in the folder the user is looking at,
		// and dragging it back is one gesture.
		expect(useToastStore.getState().toasts).toHaveLength(0);
	});

	it("counts the drop index in the list the moved row has left", () => {
		// Three rows, because with two the clamp hides the difference: dropping
		// One below Two means index 1 among [Two, Four], not index 2 among all
		// three - the moved row is not in the list it is being spliced into.
		fixture.requests
			.get("c1")!
			.push({ id: "r4", collectionId: "c1", name: "Four", method: "GET", order: 2 });
		renderTree();
		dragTo(requestRow("r1"), yIn(rowIndex(requestRow("r2")), 0.8));

		expect(reorderMutate.mock.calls[0][0]).toEqual({
			moves: [
				{ type: "request", id: "r2", order: 0 },
				{ type: "request", id: "r1", order: 1 },
			],
			normalize: [],
		});
	});

	it("carries the new owner when the row lands in another collection", () => {
		renderTree();
		// Onto Beta's middle band: into that folder's requests, at the end.
		dragTo(requestRow("r1"), yIn(rowIndex(collectionRow("c2")), 0.5));

		expect(reorderMutate.mock.calls[0][0]).toEqual({
			moves: [
				{ type: "request", id: "r2", order: 0 },
				{ type: "request", id: "r1", order: 1, collectionId: "c2" },
			],
			normalize: [],
		});
	});

	it("draws the indicator where the row will land, not where the pointer is", () => {
		renderTree();
		// The lower edge of the nested folder Gamma. A request cannot sit between
		// two folders, so the drop resolves to the head of Alpha's requests - and
		// the line has to be drawn there.
		dragTo(requestRow("r2"), yIn(rowIndex(collectionRow("c3")), 0.9), { hold: true });

		expect(requestRow("r1").querySelector('[data-drop-indicator="before"]')).not.toBeNull();
		expect(collectionRow("c3").querySelector("[data-drop-indicator]")).toBeNull();
		fireEvent.pointerUp(requestRow("r2"), { pointerId: 1, clientX: 10, clientY: 0 });
	});

	it("is cancelled by Escape, leaving nothing written", () => {
		renderTree();
		const source = requestRow("r2");
		dragTo(source, yIn(rowIndex(requestRow("r1")), 0.2), { hold: true });
		fireEvent.keyDown(window, { key: "Escape" });
		fireEvent.pointerUp(source, { pointerId: 1, clientX: 10, clientY: 8 });

		expect(reorderMutate).not.toHaveBeenCalled();
		expect(document.querySelector("[data-drop-indicator]")).toBeNull();
	});

	it("greys the rows the dragged folder cannot land on", () => {
		renderTree();
		dragTo(collectionRow("c1"), yIn(rowIndex(collectionRow("c3")), 0.5), { hold: true });

		// Its own subtree, and the request rows - a folder is not in that block.
		expect(collectionRow("c1").getAttribute("data-drop-blocked")).toBe("true");
		expect(collectionRow("c3").getAttribute("data-drop-blocked")).toBe("true");
		expect(requestRow("r1").getAttribute("data-drop-blocked")).toBe("true");
		// A legal target keeps its state.
		expect(collectionRow("c2").getAttribute("data-drop-blocked")).toBeNull();

		fireEvent.pointerUp(collectionRow("c1"), { pointerId: 1, clientX: 10, clientY: 8 });
		expect(reorderMutate).not.toHaveBeenCalled();
	});

	it("springs a collapsed folder open after a hover", () => {
		vi.useFakeTimers();
		renderTree();
		dragTo(requestRow("r1"), yIn(rowIndex(collectionRow("c2")), 0.5), { hold: true });

		expect(useCollectionsStore.getState().expandedCollectionIds.has("c2")).toBe(false);
		act(() => void vi.advanceTimersByTime(700));
		expect(useCollectionsStore.getState().expandedCollectionIds.has("c2")).toBe(true);

		fireEvent.pointerUp(requestRow("r1"), { pointerId: 1, clientX: 10, clientY: 8 });
	});

	/**
	 * Spring-loading answers "I want to drop *into* this folder", so only the
	 * inside band arms it (issue #886).
	 *
	 * It used to arm on any drop a folder row resolved, and the edge quarters
	 * resolve to a drop *beside* the folder - they are the reorder bands, the
	 * whole reason `FOLDER_EDGE_RATIO` exists. So lining a reorder up next to a
	 * collapsed folder opened it after 700ms: its children appeared under the
	 * pointer, every row below shifted mid-gesture, and the seam the user was
	 * aiming at moved. The drop that followed was not the one they lined up.
	 *
	 * Dragging a *folder* is the reachable case, which is why the source here is
	 * one: a request over a **root** folder's edge is refused outright
	 * (`resolveDrop` - the root level has no requests block), so no destination
	 * resolves and no spring was armed. A folder over a folder's edge is a legal
	 * reorder among siblings, and that is what sprang the target open.
	 */
	it("does not spring a folder open while the drop lands beside it", () => {
		vi.useFakeTimers();
		renderTree();
		const beta = rowIndex(collectionRow("c2"));

		// Alpha to Beta's top quarter: "before Beta", a reorder of the root folders.
		dragTo(collectionRow("c1"), yIn(beta, 0.1), { hold: true });
		act(() => void vi.advanceTimersByTime(700));
		expect(useCollectionsStore.getState().expandedCollectionIds.has("c2")).toBe(false);

		// The bottom quarter: "after Beta". Same rule, other edge.
		fireEvent.pointerMove(collectionRow("c1"), {
			pointerId: 1,
			clientX: 10,
			clientY: yIn(beta, 0.9),
		});
		act(() => void vi.advanceTimersByTime(700));
		expect(useCollectionsStore.getState().expandedCollectionIds.has("c2")).toBe(false);

		// Crossing into the middle still springs it, so the fix narrows the
		// trigger rather than removing the feature.
		fireEvent.pointerMove(collectionRow("c1"), {
			pointerId: 1,
			clientX: 10,
			clientY: yIn(beta, 0.5),
		});
		act(() => void vi.advanceTimersByTime(700));
		expect(useCollectionsStore.getState().expandedCollectionIds.has("c2")).toBe(true);

		fireEvent.pointerUp(collectionRow("c1"), { pointerId: 1, clientX: 10, clientY: 8 });
	});

	/**
	 * The same rule for a request, over a folder that *does* accept an edge drop.
	 *
	 * Gamma is nested, so its parent has a requests block and "before Gamma"
	 * resolves - which is what made this reachable while the root-folder case was
	 * not. Collapsed here on purpose: an already-open folder never arms a spring,
	 * so the fixture's expanded Gamma would have hidden this.
	 */
	it("does not spring a nested folder open for a request dropped beside it", () => {
		vi.useFakeTimers();
		useCollectionsStore.setState({ expandedCollectionIds: new Set(["c1"]) });
		renderTree();
		const gamma = rowIndex(collectionRow("c3"));

		dragTo(requestRow("r1"), yIn(gamma, 0.1), { hold: true });
		act(() => void vi.advanceTimersByTime(700));
		expect(useCollectionsStore.getState().expandedCollectionIds.has("c3")).toBe(false);

		fireEvent.pointerUp(requestRow("r1"), { pointerId: 1, clientX: 10, clientY: 8 });
	});

	/**
	 * Sliding off the inside band disarms a spring that has not fired yet.
	 *
	 * The timer was cleared when the pointer reached a *different* folder or left
	 * every row, but not when it stayed on the same row and changed band - so
	 * moving from a folder's middle out to its own edge left the countdown
	 * running against a target the drop no longer named, and the folder opened
	 * with the indicator sitting on the seam above it.
	 */
	it("disarms the spring when the pointer slides off the inside band", () => {
		vi.useFakeTimers();
		renderTree();
		const beta = rowIndex(collectionRow("c2"));

		dragTo(collectionRow("c1"), yIn(beta, 0.5), { hold: true });
		act(() => void vi.advanceTimersByTime(400));
		fireEvent.pointerMove(collectionRow("c1"), {
			pointerId: 1,
			clientX: 10,
			clientY: yIn(beta, 0.1),
		});
		act(() => void vi.advanceTimersByTime(700));

		expect(useCollectionsStore.getState().expandedCollectionIds.has("c2")).toBe(false);

		fireEvent.pointerUp(collectionRow("c1"), { pointerId: 1, clientX: 10, clientY: 8 });
	});
});

describe("the keyboard move", () => {
	it("reorders among siblings, announces it, and keeps the row focused", () => {
		renderTree();
		const moved = requestRow("r1");
		moved.focus();
		fireEvent.keyDown(moved, { key: "ArrowDown", altKey: true });

		expect(reorderMutate.mock.calls[0][0]).toEqual({
			moves: [
				{ type: "request", id: "r2", order: 0 },
				{ type: "request", id: "r1", order: 1 },
			],
			normalize: [],
		});
		expect(row("[data-tree-live]").textContent).toBe("Moved One to position 2 of 2 in Alpha");
		expect(document.activeElement).toBe(requestRow("r1"));
	});

	it("says so rather than writing when there is nowhere to go", () => {
		renderTree();
		const moved = requestRow("r1");
		moved.focus();
		fireEvent.keyDown(moved, { key: "ArrowUp", altKey: true });

		expect(reorderMutate).not.toHaveBeenCalled();
		expect(row("[data-tree-live]").textContent).toBe("One is already first in Alpha");
	});

	it("moves into the folder above, opening it and carrying focus along", () => {
		// Gamma collapsed, so the row lands somewhere that is not rendered yet -
		// the case a reveal exists for. Without it the row moves and the user is
		// left on `<body>`, watching a folder that did not open.
		useCollectionsStore.setState({ expandedCollectionIds: new Set(["c1"]) });
		renderTree();
		const moved = requestRow("r1");
		moved.focus();
		fireEvent.keyDown(moved, { key: "ArrowRight", altKey: true });

		expect(reorderMutate.mock.calls[0][0]).toEqual({
			moves: [
				{ type: "request", id: "r2", order: 0 },
				{ type: "request", id: "r1", order: 0, collectionId: "c3" },
			],
			normalize: [],
		});
		expect(useCollectionsStore.getState().expandedCollectionIds.has("c3")).toBe(true);
		expect(fixture.requests.get("c3")?.map((r) => r.id)).toEqual(["r1"]);
		expect(document.activeElement).toBe(requestRow("r1"));
		expect(requestRow("r1").tabIndex).toBe(0);
	});

	it("leaves the plain arrows navigating", () => {
		renderTree();
		const start = requestRow("r1");
		start.focus();
		fireEvent.keyDown(start, { key: "ArrowDown" });

		expect(reorderMutate).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(requestRow("r2"));
	});
});

describe("the row's own ⋯ menu", () => {
	it("is not a press on the row, even though its items bubble through it", async () => {
		// Radix renders the menu through a *portal*: a React child of the row
		// whose DOM lives on `body`. React bubbles synthetic events through the
		// component tree rather than the DOM tree, so a press on a menu item
		// arrives at the row's own pointer handlers. Taking it captures the
		// pointer, and the capture retargets the `pointerup` the item needed -
		// every action in the menu stops working, which is not something a test
		// that clicks the item directly can see.
		renderTree();
		const source = requestRow("r1");
		const trigger = Array.from(source.querySelectorAll("button")).find((b) =>
			/more actions/i.test(b.getAttribute("aria-label") ?? "")
		)!;
		fireEvent.pointerDown(
			trigger,
			new PointerEvent("pointerdown", { bubbles: true, button: 0 })
		);

		const item = await screen.findByText("Move to...");
		fireEvent.pointerDown(item, { button: 0, pointerId: 9, clientX: 200, clientY: 200 });

		expect(source.hasPointerCapture(9)).toBe(false);

		// And no amount of movement over the open menu starts a drag.
		fireEvent.pointerMove(item, { pointerId: 9, clientX: 200, clientY: 260 });
		expect(document.querySelector("[data-drop-indicator]")).toBeNull();
		fireEvent.pointerUp(item, { pointerId: 9, clientX: 200, clientY: 260 });
		expect(reorderMutate).not.toHaveBeenCalled();
	});
});

describe("Move to...", () => {
	it("moves the row and offers an undo that puts it back", async () => {
		renderTree();
		const source = requestRow("r1");
		const menu = Array.from(source.querySelectorAll("button")).find((b) =>
			/more actions/i.test(b.getAttribute("aria-label") ?? "")
		)!;
		// Radix opens its dropdown on pointerdown, not click.
		fireEvent.pointerDown(menu, new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
		fireEvent.click(await screen.findByText("Move to..."));
		const dialog = await screen.findByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "Beta" }));

		expect(reorderMutate.mock.calls[0][0]).toEqual({
			moves: [
				{ type: "request", id: "r2", order: 0 },
				{ type: "request", id: "r1", order: 1, collectionId: "c2" },
			],
			normalize: [],
		});
		// The fixture moved with it, so the undo plans from where the row now is.
		expect(fixture.requests.get("c2")?.map((r) => r.id)).toEqual(["r3", "r1"]);

		const queued = useToastStore.getState().toasts;
		const undo = queued[queued.length - 1]?.action;
		expect(undo?.label).toBe("Undo");
		act(() => undo!.onClick());

		expect(reorderMutate).toHaveBeenCalledTimes(2);
		// Alpha closed the gap while the row was away, so putting it back at the
		// head displaces Two again - the inverse of a move is not the same batch
		// mirrored, it is a fresh plan against the tree as it now stands.
		expect(reorderMutate.mock.calls[1][0]).toEqual({
			moves: [
				{ type: "request", id: "r2", order: 1 },
				{ type: "request", id: "r1", order: 0, collectionId: "c1" },
			],
			normalize: [],
		});
		expect(fixture.requests.get("c1")?.map((r) => r.id)).toEqual(["r1", "r2"]);
	});

	it("does not offer to move a row into where it already is", async () => {
		renderTree();
		const source = requestRow("r1");
		const menu = Array.from(source.querySelectorAll("button")).find((b) =>
			/more actions/i.test(b.getAttribute("aria-label") ?? "")
		)!;
		fireEvent.pointerDown(menu, new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
		fireEvent.click(await screen.findByText("Move to..."));
		const dialog = await screen.findByRole("dialog");

		expect(within(dialog).getByRole("button", { name: "Beta" })).toBeInTheDocument();
		// Alpha holds it already; Gamma is a folder inside Alpha and is offered.
		expect(within(dialog).queryByRole("button", { name: "Alpha" })).toBeNull();
		expect(within(dialog).getByRole("button", { name: "Gamma" })).toBeInTheDocument();
	});
});
