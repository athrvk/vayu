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
 * The collection tree mounts the rows in view and stands in for the rest
 * (#2543), and nothing that acts on a row may notice: the keys walk every
 * visible row, a reveal scrolls the drawer before it looks for its row, and the
 * rows something still holds - focus, a rename, the new-folder form, a drag -
 * stay mounted when the drawer scrolls away from them.
 *
 * jsdom has no layout, and with none the tree mounts everything (every other
 * suite relies on that). Here the drawer body is given a height and a scroll
 * position, the list a rectangle that moves with it, and `ResizeObserver` and
 * `requestAnimationFrame` stand-ins, so the window is the one the app computes.
 * `--spacing` does not resolve in jsdom, so a unit is the hook's 4px fallback:
 * a request row is 32px with 2px above it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useTabsStore } from "@/stores";
import { useCollectionsStore } from "./collections-store";
import CollectionTree from "./CollectionTree";

const REQUEST_COUNT = 1000;
/** The drawer body's height. */
const VIEWPORT_PX = 600;
/** Where the list starts inside the drawer body's scrolled content. */
const LIST_TOP_PX = 40;
/** The one request named off the pattern, for the typeahead. */
const FAR_NAMED = 777;

const collections = [
	{ id: "alpha", name: "Alpha", order: 0 },
	{ id: "big", name: "Big", order: 1 },
];
function requestFixture(count: number) {
	return Array.from({ length: count }, (_, order) => ({
		id: `r${order}`,
		collectionId: "big",
		name: order === FAR_NAMED ? "Zebra" : `Request ${order}`,
		method: "GET",
		order,
	}));
}
let requests = new Map([["big", requestFixture(REQUEST_COUNT)]]);

/*
 * The list in spacing units: Alpha [0, 8), Big 0.5 + 8, then r0 a whole unit
 * into the folder and every request after it half a unit below the last. So
 * request k's box starts at 70 + 34k px from the list's top edge.
 */
const UNIT_PX = 4;
const requestTopPx = (k: number) => 70 + 34 * k;
const ROW_PX = 32;
const TOTAL_UNITS = 8 + 8.5 + 9 + (REQUEST_COUNT - 1) * 8.5;

const mutateAsync = vi.fn();
const deleteRequest = vi.fn();
const reorderMutate = vi.fn();

vi.mock("@/queries", () => ({
	useCollectionsQuery: () => ({
		data: collections,
		isLoading: false,
		isError: false,
		error: null,
		refetch: vi.fn(),
	}),
	useMultipleCollectionRequests: () => ({ requestsByCollection: requests }),
	useReorderMutation: () => ({ mutate: reorderMutate, isPending: false }),
	useCreateCollectionMutation: () => ({ mutateAsync, isPending: false }),
	useUpdateCollectionMutation: () => ({ mutateAsync, isPending: false }),
	useDeleteCollectionMutation: () => ({ mutateAsync, isPending: false }),
	useCreateRequestMutation: () => ({ mutateAsync, isPending: false }),
	useDeleteRequestMutation: () => ({ mutateAsync: deleteRequest, isPending: false }),
	useUpdateRequestMutation: () => ({ mutateAsync, isPending: false }),
	useRestoreTrashMutation: () => ({ mutateAsync, isPending: false }),
	useMockServersQuery: () => ({ data: [] }),
	useStopMockServerMutation: () => ({ mutateAsync, isPending: false }),
}));

let rerenderTree = () => {};

function renderTree() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const ui = () => (
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<CollectionTree />
			</TooltipProvider>
		</QueryClientProvider>
	);
	const view = render(ui());
	rerenderTree = () => act(() => view.rerender(ui()));
	return view;
}

/* ── Layout stand-ins ─────────────────────────────────────────────────── */

const scrollTops = new WeakMap<Element, number>();
let frames: FrameRequestCallback[] = [];

const scroller = () => document.querySelector<HTMLElement>("[data-drawer-body]")!;
const treeList = () => document.querySelector<HTMLElement>('[role="tree"]')!;
const treeItems = () => Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"]'));
const requestRow = (k: number) => document.querySelector<HTMLElement>(`[data-request-id="r${k}"]`);
const collectionRow = (id: string) =>
	document.querySelector<HTMLElement>(`[data-collection-id="${id}"]`);

function rect(top: number, height: number): DOMRect {
	return {
		top,
		bottom: top + height,
		height,
		left: 0,
		right: 240,
		width: 240,
		x: 0,
		y: top,
		toJSON: () => ({}),
	} as DOMRect;
}

/** Where the list's top edge is on screen, given how far the drawer is scrolled. */
const listScreenTop = () => LIST_TOP_PX - scroller().scrollTop;

/** A row's box on screen, from the arithmetic above rather than from the app. */
function rowRect(el: Element): DOMRect {
	const id = el.getAttribute("data-request-id");
	if (id) return rect(listScreenTop() + requestTopPx(Number(id.slice(1))), ROW_PX);
	const top = el.getAttribute("data-collection-id") === "alpha" ? 0 : 34;
	return rect(listScreenTop() + top, ROW_PX);
}

/** The mounted row under a screen point, the way the browser's hit test answers. */
function rowAtPoint(_x: number, y: number): Element | null {
	const k = Math.floor((y - listScreenTop() - 70) / 34);
	return k >= 0 && k < REQUEST_COUNT ? requestRow(k) : null;
}

/** One animation frame: whatever was scheduled before it, and nothing scheduled during it. */
function flushFrame() {
	const due = frames;
	frames = [];
	act(() => due.forEach((callback) => callback(performance.now())));
}

function scrollDrawerTo(top: number) {
	act(() => {
		scroller().scrollTop = top;
	});
	flushFrame();
}

/** Every row mounted in view of the drawer, as the user would see it. */
function inView(el: Element): boolean {
	const box = el.getBoundingClientRect();
	return box.top >= 0 && box.bottom <= VIEWPORT_PX;
}

/**
 * A wrapper's own units: its explicit height class, the gap above the row
 * included (the gap is top padding inside the wrapper).
 */
function wrapperUnits(wrapper: HTMLElement): number {
	const height = Array.from(wrapper.classList)
		.map((name) => /^h-(\d+(?:\.\d+)?)$/.exec(name))
		.find((match) => match !== null);
	expect(height, "a wrapper states its height as an h-N class").toBeTruthy();
	return Number(height![1]);
}

/** The list's height as rendered: mounted rows plus the spacers standing in for the rest. */
function renderedUnits(): number {
	let units = 0;
	for (const child of Array.from(treeList().children) as HTMLElement[]) {
		if (child.hasAttribute("data-tree-spacer")) {
			const match = /calc\(var\(--spacing\) \* ([\d.]+)\)/.exec(child.style.height);
			expect(match, "a spacer states its height in spacing units").not.toBeNull();
			units += Number(match![1]);
		} else {
			units += wrapperUnits(child);
		}
	}
	return units;
}

const originalScrollTo = Element.prototype.scrollTo;
const originalElementFromPoint = document.elementFromPoint;

beforeEach(() => {
	frames = [];
	requests = new Map([["big", requestFixture(REQUEST_COUNT)]]);
	reorderMutate.mockReset();
	deleteRequest.mockReset().mockResolvedValue(undefined);
	useCollectionsStore.setState({ expandedCollectionIds: new Set(["big"]) });
	useTabsStore.setState({ openTabs: [], activeTabId: null });

	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		}
	);
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.push(callback);
		return frames.length;
	});
	vi.stubGlobal("cancelAnimationFrame", () => {});

	const isDrawerBody = (el: Element) => el.hasAttribute("data-drawer-body");
	vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
		return isDrawerBody(this) ? VIEWPORT_PX : 0;
	});
	vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
		return isDrawerBody(this) ? LIST_TOP_PX + TOTAL_UNITS * UNIT_PX : 0;
	});
	vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(function (this: Element) {
		return scrollTops.get(this) ?? 0;
	});
	// A browser fires `scroll` for a script's scroll as much as a user's.
	vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(function (
		this: Element,
		top: number
	) {
		scrollTops.set(this, Math.max(0, top));
		this.dispatchEvent(new Event("scroll"));
	});
	Element.prototype.scrollTo = function (this: Element, options?: ScrollToOptions | number) {
		if (typeof options === "object") this.scrollTop = options.top ?? this.scrollTop;
	} as Element["scrollTo"];
	vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
		this: Element
	) {
		if (isDrawerBody(this)) return rect(0, VIEWPORT_PX);
		if (this.getAttribute("role") === "tree") return rect(listScreenTop(), 0);
		if (this.matches('[role="treeitem"]')) return rowRect(this);
		return rect(0, 0);
	});
	document.elementFromPoint = rowAtPoint;
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	Element.prototype.scrollTo = originalScrollTo;
	document.elementFromPoint = originalElementFromPoint;
});

describe("a windowed tree", () => {
	it("mounts a bounded window of a folder of 1,000 requests", () => {
		renderTree();

		// The fixture is what the case claims: every request is a row of the list.
		expect(requests.get("big")).toHaveLength(REQUEST_COUNT);
		expect(treeItems().length).toBeLessThan(120);
		expect(requestRow(0)).not.toBeNull();
		expect(requestRow(REQUEST_COUNT - 1)).toBeNull();
		// Unmounted rows still count: the set is the folder's, not the window's.
		expect(requestRow(0)).toHaveAttribute("aria-setsize", String(REQUEST_COUNT));
		expect(renderedUnits()).toBe(TOTAL_UNITS);
	});

	it("mounts later rows and drops earlier ones as the drawer scrolls", () => {
		renderTree();
		expect(requestRow(5)).not.toBeNull();

		scrollDrawerTo(LIST_TOP_PX + requestTopPx(500));

		expect(requestRow(500)).not.toBeNull();
		expect(inView(requestRow(500)!)).toBe(true);
		expect(requestRow(5)).toBeNull();
		expect(treeItems().length).toBeLessThan(120);
		// Whatever is mounted, the spacers make up the rest of the list exactly.
		expect(renderedUnits()).toBe(TOTAL_UNITS);
	});

	it("mounts every row of a list too short to window", () => {
		requests = new Map([["big", requestFixture(20)]]);
		renderTree();

		expect(document.querySelectorAll("[data-request-id]")).toHaveLength(20);
		expect(document.querySelector("[data-tree-spacer]")).toBeNull();
	});
});

describe("rows that stay mounted wherever the drawer is scrolled", () => {
	it("keeps the focused row, which holds the tree's tab stop", () => {
		renderTree();
		act(() => requestRow(3)!.focus());

		scrollDrawerTo(LIST_TOP_PX + requestTopPx(600));

		expect(requestRow(3)).not.toBeNull();
		expect(document.activeElement).toBe(requestRow(3));
		expect(requestRow(3)!.tabIndex).toBe(0);
	});

	it("keeps the row being renamed, field and all", () => {
		renderTree();
		const row = requestRow(3)!;
		act(() => row.focus());
		fireEvent.keyDown(row, { key: "F2" });
		expect(row.querySelector("input")).not.toBeNull();

		scrollDrawerTo(LIST_TOP_PX + requestTopPx(600));

		expect(requestRow(3)?.querySelector("input")).not.toBeNull();
	});

	it("keeps the new-folder form and the folder it opens under", async () => {
		renderTree();
		const big = collectionRow("big")!;
		act(() => big.focus());
		fireEvent.keyDown(big, { key: "F10", shiftKey: true });
		fireEvent.click(await screen.findByRole("menuitem", { name: /Add collection/ }));
		expect(await screen.findByPlaceholderText("Collection name")).toBeInTheDocument();

		scrollDrawerTo(LIST_TOP_PX + requestTopPx(600));

		expect(screen.getByPlaceholderText("Collection name")).toBeInTheDocument();
		expect(collectionRow("big")).not.toBeNull();
		// The form is a row of its own (a unit above, ten tall), and the first request
		// below it is now its sibling, half a unit down rather than a whole one.
		expect(renderedUnits()).toBe(TOTAL_UNITS + 11 - 0.5);
	});
});

describe("the keys walk every row, mounted or not", () => {
	it("End focuses the folder's last request, scrolled into view", () => {
		renderTree();
		const alpha = collectionRow("alpha")!;
		act(() => alpha.focus());

		fireEvent.keyDown(alpha, { key: "End" });

		const last = requestRow(REQUEST_COUNT - 1);
		expect(last).not.toBeNull();
		expect(document.activeElement).toBe(last);
		expect(inView(last!)).toBe(true);
		expect(last!.tabIndex).toBe(0);
	});

	it("Home comes back to the first row from the far end", () => {
		renderTree();
		const alpha = collectionRow("alpha")!;
		act(() => alpha.focus());
		fireEvent.keyDown(alpha, { key: "End" });

		fireEvent.keyDown(document.activeElement!, { key: "Home" });

		expect(document.activeElement).toBe(collectionRow("alpha"));
		expect(inView(collectionRow("alpha")!)).toBe(true);
	});

	it("ArrowDown steps past the window's edge, mounting each row it reaches", () => {
		renderTree();
		act(() => requestRow(0)!.focus());

		for (let step = 0; step < 60; step++) {
			fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
		}

		expect(document.activeElement).toBe(requestRow(60));
		expect(inView(requestRow(60)!)).toBe(true);
		expect(treeItems().length).toBeLessThan(120);
	});

	it("a typeahead reaches a row that is scrolled away", () => {
		renderTree();
		const alpha = collectionRow("alpha")!;
		act(() => alpha.focus());
		expect(requestRow(FAR_NAMED)).toBeNull();

		fireEvent.keyDown(alpha, { key: "z" });

		expect(document.activeElement).toBe(requestRow(FAR_NAMED));
		expect(inView(requestRow(FAR_NAMED)!)).toBe(true);
	});

	it("a delete far from the folder hands focus up to the folder", async () => {
		renderTree();
		const alpha = collectionRow("alpha")!;
		act(() => alpha.focus());
		fireEvent.keyDown(alpha, { key: "End" });
		const last = requestRow(REQUEST_COUNT - 1)!;
		// Big is 999 rows above: nothing but the tab stop's neighbours keeps it.
		expect(inView(collectionRow("big")!)).toBe(false);

		fireEvent.keyDown(last, { key: "Delete" });
		await act(async () => {});
		expect(deleteRequest).toHaveBeenCalledWith(`r${REQUEST_COUNT - 1}`);
		requests = new Map([["big", requestFixture(REQUEST_COUNT - 1)]]);
		rerenderTree();

		expect(document.activeElement).toBe(collectionRow("big"));
	});
});

describe("revealing the active tab", () => {
	it("scrolls a far request into view and mounts it", () => {
		useTabsStore.setState({
			openTabs: [{ id: "t1", type: "request", entityId: "r900" }],
			activeTabId: "t1",
		});
		renderTree();

		expect(requestRow(900)).not.toBeNull();
		expect(inView(requestRow(900)!)).toBe(true);
	});
});

describe("a drag in a windowed tree", () => {
	it("auto-scrolls far from the row it started on and still drops", () => {
		renderTree();
		const source = requestRow(2)!;
		const startY = source.getBoundingClientRect().top + ROW_PX / 2;

		fireEvent.pointerDown(source, {
			button: 0,
			pointerId: 1,
			clientX: 10,
			clientY: startY,
		});
		// A press is not a drag yet, and takes no capture: a captured press
		// clicks the capturing element rather than the row's own controls.
		expect(treeList().hasPointerCapture(1)).toBe(false);
		fireEvent.pointerMove(source, { pointerId: 1, clientX: 10, clientY: startY + 6 });
		// Past the threshold the tree takes it, not the row, which the drawer
		// is about to scroll away from.
		expect(treeList().hasPointerCapture(1)).toBe(true);
		expect(source.hasPointerCapture(1)).toBe(false);
		// From here every event goes where the capture sends it: the tree.
		// Into the bottom band: the drawer scrolls a step a frame.
		fireEvent.pointerMove(treeList(), {
			pointerId: 1,
			clientX: 10,
			clientY: VIEWPORT_PX - 4,
		});
		for (let frame = 0; frame < 200; frame++) flushFrame();
		expect(scroller().scrollTop).toBeGreaterThan(1500);

		// The source is far above the window now, and stays mounted.
		expect(requestRow(2)).toBe(source);
		const target = rowAtPoint(10, 300)!;
		expect(target).not.toBeNull();
		const targetIndex = Number(target.getAttribute("data-request-id")!.slice(1));
		expect(targetIndex).toBeGreaterThan(40);
		fireEvent.pointerMove(treeList(), { pointerId: 1, clientX: 10, clientY: 300 });
		fireEvent.pointerUp(treeList(), { pointerId: 1, clientX: 10, clientY: 300 });
		expect(treeList().hasPointerCapture(1)).toBe(false);

		expect(reorderMutate).toHaveBeenCalledTimes(1);
		const [plan] = reorderMutate.mock.calls[0];
		expect(plan.moves.some((move: { id: string }) => move.id === "r2")).toBe(true);
		expect(document.querySelector("[data-tree-live]")?.textContent).toMatch(
			/^Moved Request 2 to position \d+ of 1000 in Big$/
		);
	});
});

describe("one menu and one set of drag handlers for the whole tree", () => {
	/** The menu open now, by the name it gives itself. */
	const openMenu = () => screen.getByRole("menu");

	it("mounts one right-click trigger, the tree itself, however many rows are mounted", () => {
		renderTree();

		// Enough rows that a trigger per row could not hide in the count.
		expect(treeItems().length).toBeGreaterThan(20);
		const triggers = document.querySelectorAll('[data-slot="context-menu-trigger"]');
		expect(triggers).toHaveLength(1);
		expect(triggers[0]).toBe(treeList());
	});

	it("opens the actions of the row under the pointer, and switches with the pointer", async () => {
		renderTree();

		fireEvent.contextMenu(requestRow(5)!);
		await waitFor(() =>
			expect(openMenu()).toHaveAccessibleName("More actions for request Request 5")
		);
		expect(screen.getByRole("menuitem", { name: /Duplicate/ })).toBeInTheDocument();

		fireEvent.contextMenu(collectionRow("big")!);
		await waitFor(() => expect(openMenu()).toHaveAccessibleName("More actions for Big"));
		expect(screen.queryByRole("menuitem", { name: /Duplicate/ })).toBeNull();
		expect(screen.getByRole("menuitem", { name: /Add collection/ })).toBeInTheDocument();

		// And on a row the first window did not hold, the action is that row's.
		scrollDrawerTo(LIST_TOP_PX + requestTopPx(600));
		fireEvent.contextMenu(requestRow(603)!);
		await waitFor(() =>
			expect(openMenu()).toHaveAccessibleName("More actions for request Request 603")
		);
		fireEvent.click(screen.getByRole("menuitem", { name: /Rename/ }));
		await waitFor(() => expect(requestRow(603)!.querySelector("input")).not.toBeNull());
		expect(requestRow(603)!.querySelector("input")).toHaveValue("Request 603");
	});

	it("leaves a right-click beside the rows to the platform", () => {
		renderTree();
		const spacer = document.querySelector<HTMLElement>("[data-tree-spacer]")!;
		expect(spacer).not.toBeNull();

		// `fireEvent` answers whether the default survived: nothing called
		// `preventDefault`, so the platform's own menu is what the user gets.
		expect(fireEvent.contextMenu(spacer)).toBe(true);
		expect(screen.queryByRole("menu")).toBeNull();
	});
});
