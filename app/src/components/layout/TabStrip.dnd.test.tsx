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
 * Dragging a tab to a new place in the strip (#2039).
 *
 * Driven through real pointer events on the real strip, with only what jsdom
 * cannot provide stubbed: layout. Every tab measures 100px wide in DOM order
 * (tab `i` spans `i*100` to `i*100+100`, so midpoints fall at 50, 150, 250...)
 * and the strip root is a 32px band. The gesture, the slot maths and the store
 * write between the press and the new order are the code under test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useRef } from "react";
import { createPortal } from "react-dom";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TabStrip } from "./TabStrip";
import { useTabsStore } from "@/stores";
import { useTabStripDnd } from "./useTabStripDnd";

vi.mock("@/queries", () => ({
	requestDetailOptions: () => ({
		queryKey: ["request"],
		queryFn: async () => undefined,
		enabled: false,
	}),
	runDetailOptions: () => ({ queryKey: ["run"], queryFn: async () => undefined, enabled: false }),
	useCollectionsQuery: () => ({ data: [] }),
	useInboxesQuery: () => ({ data: [] }),
	useMockServersQuery: () => ({ data: [] }),
}));
vi.mock("@/hooks/useVariableResolver", () => ({
	useVariableResolver: () => ({ resolveString: (s: string) => s }),
}));

const TABS = [
	{ id: "t1", type: "welcome" as const, entityId: null },
	{ id: "t2", type: "settings" as const, entityId: null },
	{ id: "t3", type: "variables" as const, entityId: null },
];

const STRIP_HEIGHT = 32;
/** Inside the strip vertically. */
const ROW_Y = STRIP_HEIGHT / 2;

const tab = (id: string) => document.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)!;
const orderedIds = () => useTabsStore.getState().openTabs.map((t) => t.id);
const renderedIds = () => screen.getAllByRole("tab").map((el) => el.getAttribute("data-tab-id")!);
const indicators = () => document.querySelectorAll<HTMLElement>("[data-drop-indicator]");

function rect(left: number, top: number, width: number, height: number): DOMRect {
	return {
		x: left,
		y: top,
		left,
		top,
		width,
		height,
		right: left + width,
		bottom: top + height,
		toJSON: () => ({}),
	};
}

/**
 * Layout for a document that has none: the rendered tabs, in DOM order, 100px
 * each; the strip root a band 32px tall. Anything else measures as it did.
 */
function stubLayout() {
	const measured = HTMLElement.prototype.getBoundingClientRect;
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
		this: HTMLElement
	) {
		if (this.getAttribute("role") === "tab") {
			const tabs = Array.from(document.querySelectorAll('[role="tablist"] [role="tab"]'));
			return rect(tabs.indexOf(this) * 100, 0, 100, STRIP_HEIGHT);
		}
		if (this.querySelector(':scope > [role="tablist"]')) return rect(0, 0, 1000, STRIP_HEIGHT);
		return measured.call(this);
	});
}

/** jsdom lays nothing out, so the strip's width has to be supplied to make it overflow. */
function stubStripWidth(px: number) {
	Object.defineProperty(HTMLElement.prototype, "clientWidth", {
		configurable: true,
		get(this: HTMLElement) {
			return this.querySelector(':scope > [role="tablist"]') ? px : 0;
		},
	});
}

function renderStrip() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<TabStrip />
		</QueryClientProvider>
	);
}

const POINTER = { pointerId: 1 };

function press(id: string, x: number) {
	fireEvent.pointerDown(tab(id), { ...POINTER, button: 0, clientX: x, clientY: ROW_Y });
}
function moveTo(id: string, x: number, y = ROW_Y) {
	fireEvent.pointerMove(tab(id), { ...POINTER, clientX: x, clientY: y });
}
function release(id: string, x: number, y = ROW_Y) {
	fireEvent.pointerUp(tab(id), { ...POINTER, clientX: x, clientY: y });
}

/** A whole drag: press at the middle of `id`, travel to `toX`, drop. */
function drag(id: string, fromX: number, toX: number) {
	press(id, fromX);
	moveTo(id, toX);
	release(id, toX);
}

beforeEach(() => {
	useTabsStore.setState({
		openTabs: [...TABS],
		activeTabId: "t1",
		navHistory: [],
		navIndex: -1,
	});
	stubLayout();
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	// @ts-expect-error - restore jsdom's own getter
	delete HTMLElement.prototype.clientWidth;
});

describe("dragging a tab", () => {
	it("a press that moves 3px is still a click", () => {
		useTabsStore.setState({ activeTabId: "t3" });
		renderStrip();

		press("t1", 50);
		moveTo("t1", 53);
		release("t1", 53);
		fireEvent.click(tab("t1"));

		expect(useTabsStore.getState().activeTabId).toBe("t1");
		expect(indicators()).toHaveLength(0);
		expect(orderedIds()).toEqual(["t1", "t2", "t3"]);
	});

	it("a drag past the threshold draws the slot and drops there", () => {
		useTabsStore.setState({ activeTabId: "t3" });
		renderStrip();

		press("t1", 50);
		moveTo("t1", 160);

		// x=160 is past t2's midpoint: the slot between t2 and t3.
		expect(indicators()).toHaveLength(1);
		expect(tab("t3").querySelector("[data-drop-indicator]")).toHaveAttribute(
			"data-drop-indicator",
			"before"
		);

		release("t1", 160);

		expect(orderedIds()).toEqual(["t2", "t1", "t3"]);
		expect(useTabsStore.getState().activeTabId).toBe("t3");
		expect(indicators()).toHaveLength(0);
		// Focus and the strip's one Tab stop follow the moved tab, not the active one.
		expect(document.activeElement).toBe(tab("t1"));
		const stops = screen.getAllByRole("tab").filter((t) => t.getAttribute("tabindex") === "0");
		expect(stops).toHaveLength(1);
		expect(stops[0]).toBe(tab("t1"));
	});

	it("the slot in place draws nothing", () => {
		renderStrip();
		const before = useTabsStore.getState().openTabs;

		press("t2", 150);
		moveTo("t2", 160);
		expect(indicators()).toHaveLength(0);
		release("t2", 160);

		expect(orderedIds()).toEqual(["t1", "t2", "t3"]);
		expect(useTabsStore.getState().openTabs).toBe(before);
	});

	it("past the last tab means the end", () => {
		renderStrip();

		press("t1", 50);
		moveTo("t1", 310);
		expect(tab("t3").querySelector("[data-drop-indicator]")).toHaveAttribute(
			"data-drop-indicator",
			"after"
		);
		release("t1", 310);

		expect(orderedIds()).toEqual(["t2", "t3", "t1"]);
	});

	it("before the first tab is a slot too", () => {
		renderStrip();

		press("t3", 250);
		moveTo("t3", 10);
		expect(tab("t1").querySelector("[data-drop-indicator]")).toHaveAttribute(
			"data-drop-indicator",
			"before"
		);
		release("t3", 10);

		expect(orderedIds()).toEqual(["t3", "t1", "t2"]);
	});

	it("Escape cancels", () => {
		renderStrip();

		press("t1", 50);
		moveTo("t1", 160);
		expect(indicators()).toHaveLength(1);

		fireEvent.keyDown(window, { key: "Escape" });
		expect(indicators()).toHaveLength(0);
		release("t1", 160);

		expect(orderedIds()).toEqual(["t1", "t2", "t3"]);
	});

	it("a release outside the strip cancels", () => {
		renderStrip();

		press("t1", 50);
		moveTo("t1", 160);
		expect(indicators()).toHaveLength(1);

		// Below the strip: the slot is gone, so the line is too.
		moveTo("t1", 160, STRIP_HEIGHT + 40);
		expect(indicators()).toHaveLength(0);
		release("t1", 160, STRIP_HEIGHT + 40);

		expect(orderedIds()).toEqual(["t1", "t2", "t3"]);
	});

	it("a release above the strip cancels", () => {
		renderStrip();

		press("t1", 50);
		moveTo("t1", 160);
		moveTo("t1", 160, -40);
		release("t1", 160, -40);

		expect(orderedIds()).toEqual(["t1", "t2", "t3"]);
	});

	it("the trailing click is swallowed", () => {
		renderStrip();

		drag("t3", 250, 10);
		expect(orderedIds()).toEqual(["t3", "t1", "t2"]);

		// The click the browser fires after the pointer comes up.
		fireEvent.click(tab("t3"));
		expect(useTabsStore.getState().activeTabId).toBe("t1");

		// One click, not every click after it.
		fireEvent.click(tab("t3"));
		expect(useTabsStore.getState().activeTabId).toBe("t3");
	});

	it("the dragged tab dims, with no motion class added", () => {
		renderStrip();

		press("t1", 50);
		moveTo("t1", 160);
		const during = tab("t1").className;
		expect(during).toContain("opacity-50");
		expect(tab("t2").className).not.toContain("opacity-50");
		// The no-slide decision: React reflows the moved tab on drop, so nothing
		// here may animate a transform.
		expect(during).not.toMatch(/\banimate-/);
		expect(during).not.toContain("transition-transform");

		release("t1", 160);
		expect(tab("t1").className).not.toContain("opacity-50");
	});

	it("a press on the close control does not arm a drag", () => {
		renderStrip();
		const close = tab("t1").querySelector<HTMLElement>("[data-tab-close]")!;

		fireEvent.pointerDown(close, { ...POINTER, button: 0, clientX: 90, clientY: ROW_Y });
		fireEvent.pointerMove(close, { ...POINTER, clientX: 110, clientY: ROW_Y });
		expect(indicators()).toHaveLength(0);
		fireEvent.pointerUp(close, { ...POINTER, clientX: 110, clientY: ROW_Y });
		expect(orderedIds()).toEqual(["t1", "t2", "t3"]);

		fireEvent.click(close);
		expect(orderedIds()).toEqual(["t2", "t3"]);
	});

	it("ignores a press that is not the primary button", () => {
		renderStrip();

		fireEvent.pointerDown(tab("t1"), { ...POINTER, button: 2, clientX: 50, clientY: ROW_Y });
		moveTo("t1", 160);

		expect(indicators()).toHaveLength(0);
	});
});

describe("a tab's right-click menu", () => {
	it("is not a press on the tab", async () => {
		renderStrip();
		fireEvent.contextMenu(tab("t1"));
		const item = await screen.findByRole("menuitem", { name: "Close others" });

		fireEvent.pointerDown(item, { pointerId: 9, button: 0, clientX: 200, clientY: ROW_Y });
		expect(tab("t1").hasPointerCapture(9)).toBe(false);

		fireEvent.pointerMove(item, { pointerId: 9, clientX: 300, clientY: ROW_Y });
		expect(indicators()).toHaveLength(0);
		fireEvent.pointerUp(item, { pointerId: 9, clientX: 300, clientY: ROW_Y });
		expect(orderedIds()).toEqual(["t1", "t2", "t3"]);
	});
});

/**
 * The portal guard, on a tab that really has a portalled React child.
 *
 * Today's right-click menu is a React *sibling* of the tab (`RowContextMenu`
 * renders `ContextMenuContent` beside its trigger), so its items never bubble
 * through the tab's handlers and the case above cannot go red without the
 * guard. A portal inside the tab - a hover card, a future inline menu - would
 * bubble through them: the press captures the pointer on the tab and retargets
 * the `pointerup` the portalled control was waiting for. This harness is that
 * tab.
 */
function PortalTab({ onPortalClick }: { onPortalClick: () => void }) {
	const stripRef = useRef<HTMLDivElement>(null);
	const dnd = useTabStripDnd({ stripRef, visibleIds: ["a", "b"], onMoved: () => {} });
	return (
		<div ref={stripRef}>
			<div role="tablist">
				<div role="tab" data-tab-id="a" {...dnd.handlers}>
					{createPortal(
						<button onClick={onPortalClick}>portalled</button>,
						document.body
					)}
				</div>
				<div role="tab" data-tab-id="b" />
			</div>
		</div>
	);
}

describe("a portalled child of a tab", () => {
	it("is not a press, a move, or a swallowed click", () => {
		const onPortalClick = vi.fn();
		render(<PortalTab onPortalClick={onPortalClick} />);
		const owner = document.querySelector<HTMLElement>('[data-tab-id="a"]')!;
		const child = screen.getByRole("button", { name: "portalled" });

		fireEvent.pointerDown(child, { pointerId: 9, button: 0, clientX: 50, clientY: ROW_Y });
		expect(owner.hasPointerCapture(9)).toBe(false);

		// Non-vacuous: a press on the tab itself does capture.
		fireEvent.pointerDown(owner, { pointerId: 9, button: 0, clientX: 50, clientY: ROW_Y });
		expect(owner.hasPointerCapture(9)).toBe(true);
		fireEvent.pointerMove(owner, { pointerId: 9, clientX: 150, clientY: ROW_Y });
		fireEvent.pointerUp(owner, { pointerId: 9, clientX: 150, clientY: ROW_Y });

		// The drag armed a suppression; the portalled control's own click is not its click.
		fireEvent.click(child);
		expect(onPortalClick).toHaveBeenCalledTimes(1);
	});
});

describe("with an overflowing strip", () => {
	const MANY = Array.from({ length: 8 }, (_, i) => ({
		id: `t${i}`,
		type: "settings" as const,
		entityId: null,
	}));

	beforeEach(() => {
		useTabsStore.setState({ openTabs: [...MANY], activeTabId: "t0" });
		stubStripWidth(320);
	});

	it("past the last visible tab lands before the overflowed ones", () => {
		renderStrip();
		const shown = renderedIds();
		// A fixture that does not overflow would pass the assertions below vacuously.
		expect(shown.length).toBeGreaterThan(1);
		expect(shown.length).toBeLessThan(MANY.length);

		drag("t0", 50, shown.length * 100 + 40);

		// t0 sits right after the last visible tab, ahead of every overflowed id.
		const rest = orderedIds().filter((id) => id !== "t0");
		const lastShown = shown[shown.length - 1];
		const expected = [...rest];
		expected.splice(rest.indexOf(lastShown) + 1, 0, "t0");
		expect(orderedIds()).toEqual(expected);
		expect(orderedIds().indexOf("t0")).toBe(shown.length - 1);
	});

	it("a slot indexes the visible tabs, not the store's list", () => {
		// The active tab is always shown, so with t7 active the strip renders
		// t0..tK and t7, with the tabs between hidden. The slot after t7 is the
		// third slot of nine, but the end of the store's list.
		useTabsStore.setState({ activeTabId: "t7" });
		renderStrip();
		const shown = renderedIds();
		expect(shown[shown.length - 1]).toBe("t7");
		expect(shown.length).toBeLessThan(MANY.length - 1);

		drag("t0", 50, shown.length * 100 + 40);

		expect(orderedIds()).toEqual(["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t0"]);
	});

	it("a tab chosen from the overflow menu is draggable at once", async () => {
		renderStrip();
		const trigger = screen.getByLabelText(/more tabs/i);
		// Radix opens its dropdown on pointerdown, not click.
		fireEvent.pointerDown(
			trigger,
			new PointerEvent("pointerdown", { bubbles: true, button: 0 })
		);
		const items = await screen.findAllByRole("menuitem");
		fireEvent.click(items[0]);

		const surfaced = useTabsStore.getState().activeTabId!;
		expect(surfaced).not.toBe("t0");
		const ids = renderedIds();
		const at = ids.indexOf(surfaced);
		expect(at).toBeGreaterThan(0);

		// One slot left: short of the previous tab's midpoint.
		drag(surfaced, at * 100 + 50, (at - 1) * 100 + 10);

		const expected = MANY.map((t) => t.id).filter((id) => id !== surfaced);
		expected.splice(expected.indexOf(ids[at - 1]), 0, surfaced);
		expect(orderedIds()).toEqual(expected);
		expect(useTabsStore.getState().activeTabId).toBe(surfaced);
	});
});
