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
 * What a side panel does while it overlays the content (#3507): one overlay at
 * a time, close on a selection (drawer only), Escape, and a press outside.
 *
 * Both real panels are rendered, each handed the modes `Shell` would hand it.
 * The drawer's views are stubbed to the few controls each case needs; the
 * context bar's registry is stubbed to one section. Every behaviour is asserted
 * in both modes, because "push is untouched" is half of each rule.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { Drawer } from "./Drawer";
import { ContextBar } from "./ContextBar";
import { RailButton } from "./RailButton";
import { useDrawerItemOpened } from "./drawer-item-opened";
import { tabElementId } from "./tab-aria";
import { TooltipProvider } from "@/components/ui";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui";
import { useLayoutStore, useTabsStore } from "@/stores";
import type { SidePanelMode } from "@/constants/layout";

vi.mock("@/modules/collections/CollectionTree", async () => {
	const { useState } = await import("react");
	const { useTabsStore: tabs } = await import("@/stores");
	return {
		default: function TreeStub() {
			const onItemOpened = useDrawerItemOpened();
			const [expanded, setExpanded] = useState(false);
			return (
				<div>
					<button
						onClick={() => {
							tabs.getState().openTab({ type: "request", entityId: "r2" });
							onItemOpened();
						}}
					>
						open item
					</button>
					<button
						onClick={() => tabs.getState().openTab({ type: "request", entityId: "r3" })}
					>
						duplicate
					</button>
					<button onClick={() => setExpanded((e) => !e)}>expand</button>
					{expanded && <p>children</p>}
					<input aria-label="filter" />
				</div>
			);
		},
	};
});
vi.mock("@/modules/history/sidebar/HistoryList", () => ({ default: () => null }));
vi.mock("@/modules/variables/sidebar/VariablesCategoryTree", () => ({ default: () => null }));
vi.mock("@/modules/settings/sidebar/SettingsCategoryTree", () => ({ default: () => null }));
vi.mock("@/modules/services", () => ({ ServicesPanel: () => null }));
vi.mock("@/modules/trash", () => ({ TrashList: () => null }));
vi.mock("./context-bar/registry", () => ({
	sectionsForTab: (tab: { type: string } | undefined) =>
		tab?.type === "request"
			? [
					{
						id: "alpha",
						title: "Alpha",
						appliesTo: () => true,
						Component: () => <button>alpha body</button>,
					},
				]
			: [],
}));

const layout = () => useLayoutStore.getState();

/** The rails and the tab strip, as the three DOM targets the panels hand focus to. */
function Chrome() {
	const drawerOpen = useLayoutStore((s) => s.drawerOpen);
	const contextBarOpen = useLayoutStore((s) => s.contextBarOpen);
	return (
		<>
			<RailButton
				active={drawerOpen}
				onClick={() => layout().toggleDrawer()}
				label="Collections"
				side="left"
				variant="indicator"
			>
				c
			</RailButton>
			<RailButton
				active={contextBarOpen}
				onClick={() => layout().toggleContextBar()}
				label="Alpha rail"
				side="right"
				variant="tile"
			>
				a
			</RailButton>
			<button role="tab" id={tabElementId("t2")} tabIndex={0}>
				tab two
			</button>
			<button>outside</button>
		</>
	);
}

function renderPanels(drawerMode: SidePanelMode, contextBarMode: SidePanelMode) {
	return render(
		<TooltipProvider>
			<Chrome />
			<div className="relative">
				<Drawer mode={drawerMode} siblingMode={contextBarMode} />
				<ContextBar mode={contextBarMode} siblingMode={drawerMode} />
			</div>
		</TooltipProvider>
	);
}

const drawerEl = () => screen.queryByRole("complementary", { name: "Collections sidebar" });
const contextBarEl = () => screen.queryByRole("complementary", { name: "Context sidebar" });

beforeEach(() => {
	useTabsStore.setState({
		openTabs: [
			{ id: "t1", type: "request", entityId: "r1" },
			{ id: "t2", type: "request", entityId: "r2" },
		],
		activeTabId: "t1",
	});
	useLayoutStore.setState({
		drawerOpen: false,
		drawerView: "collections",
		drawerWidth: 300,
		contextBarOpen: false,
		contextBarWidth: 280,
		contextBarCollapsedSections: [],
	});
});

describe("one overlay at a time", () => {
	it("closes the context bar when the drawer opens, and the drawer when the bar opens", () => {
		layout().setContextBarOpen(true);
		renderPanels("overlay", "overlay");
		expect(contextBarEl()).toBeInTheDocument();

		act(() => layout().revealDrawerView("collections"));
		expect(layout().drawerOpen).toBe(true);
		expect(layout().contextBarOpen).toBe(false);

		act(() => layout().setContextBarOpen(true));
		expect(layout().contextBarOpen).toBe(true);
		expect(layout().drawerOpen).toBe(false);
	});

	it("covers the store's toggle actions, which the chords and the rail buttons use", () => {
		renderPanels("overlay", "overlay");
		act(() => layout().toggleContextBar());
		act(() => layout().toggleDrawer());
		expect(layout().drawerOpen).toBe(true);
		expect(layout().contextBarOpen).toBe(false);
	});

	// Neither opened, so there is no most recent: the drawer stays and the bar's
	// persisted flag is written false.
	it("keeps the drawer when both are open as the panels mount as overlays", () => {
		layout().setDrawerOpen(true);
		layout().setContextBarOpen(true);
		renderPanels("overlay", "overlay");
		expect(layout().drawerOpen).toBe(true);
		expect(layout().contextBarOpen).toBe(false);
	});

	it("keeps the drawer when a resize turns both open panels into overlays", () => {
		layout().setDrawerOpen(true);
		layout().setContextBarOpen(true);
		const { rerender } = renderPanels("push", "push");
		expect(layout().contextBarOpen).toBe(true);
		rerender(
			<TooltipProvider>
				<Chrome />
				<div className="relative">
					<Drawer mode="overlay" siblingMode="overlay" />
					<ContextBar mode="overlay" siblingMode="overlay" />
				</div>
			</TooltipProvider>
		);
		expect(layout().drawerOpen).toBe(true);
		expect(layout().contextBarOpen).toBe(false);
	});

	it("lets the bar win when a tab switch brings it on screen over an open drawer", () => {
		useTabsStore.setState({
			openTabs: [
				{ id: "w", type: "welcome", entityId: null },
				{ id: "t1", type: "request", entityId: "r1" },
			],
			activeTabId: "w",
		});
		layout().setDrawerOpen(true);
		layout().setContextBarOpen(true);
		renderPanels("overlay", "overlay");
		// The bar has nothing to show on a welcome tab, so both flags stand.
		expect(layout().drawerOpen).toBe(true);
		expect(layout().contextBarOpen).toBe(true);

		act(() => useTabsStore.setState({ activeTabId: "t1" }));
		expect(layout().contextBarOpen).toBe(true);
		expect(layout().drawerOpen).toBe(false);
	});

	it("lets the drawer win when a reveal reopens it in the flush that closed it", () => {
		// What `Shell`'s reveal-on-tab-change does: it reopens the drawer in an
		// effect of the same commit that brought the bar on screen.
		useTabsStore.setState({
			openTabs: [
				{ id: "w", type: "welcome", entityId: null },
				{ id: "t1", type: "request", entityId: "r1" },
			],
			activeTabId: "w",
		});
		layout().setDrawerOpen(true);
		layout().setContextBarOpen(true);
		renderPanels("overlay", "overlay");

		act(() => {
			useTabsStore.setState({ activeTabId: "t1" });
			layout().revealDrawerView("collections");
		});
		expect(layout().drawerOpen).toBe(true);
		expect(layout().contextBarOpen).toBe(false);
	});

	it("never closes a panel that pushes", () => {
		layout().setDrawerOpen(true);
		layout().setContextBarOpen(true);
		renderPanels("push", "push");
		expect(layout().drawerOpen).toBe(true);
		expect(layout().contextBarOpen).toBe(true);
		expect(drawerEl()).toBeInTheDocument();
		expect(contextBarEl()).toBeInTheDocument();
	});

	it("does not close a pushing drawer when the overlaying bar opens", () => {
		layout().setDrawerOpen(true);
		renderPanels("push", "overlay");
		act(() => layout().setContextBarOpen(true));
		expect(layout().drawerOpen).toBe(true);
		expect(layout().contextBarOpen).toBe(true);
	});

	it("does not close a pushing bar when the overlaying drawer opens", () => {
		layout().setContextBarOpen(true);
		renderPanels("overlay", "push");
		act(() => layout().setDrawerOpen(true));
		expect(layout().drawerOpen).toBe(true);
		expect(layout().contextBarOpen).toBe(true);
	});

	it("leaves the bar's flag alone when it has nothing to show on this tab", () => {
		useTabsStore.setState({
			openTabs: [{ id: "w", type: "welcome", entityId: null }],
			activeTabId: "w",
		});
		layout().setContextBarOpen(true);
		renderPanels("overlay", "overlay");
		act(() => layout().setDrawerOpen(true));
		expect(layout().contextBarOpen).toBe(true);
	});
});

describe("the drawer closes on a selection", () => {
	function renderOpenDrawer(mode: SidePanelMode) {
		layout().setDrawerOpen(true);
		renderPanels(mode, "overlay");
	}

	it("closes the overlay and moves focus to the tab it opened", () => {
		renderOpenDrawer("overlay");
		screen.getByRole("button", { name: "open item" }).focus();
		fireEvent.click(screen.getByRole("button", { name: "open item" }));
		expect(useTabsStore.getState().activeTabId).toBe("t2");
		expect(layout().drawerOpen).toBe(false);
		expect(document.getElementById(tabElementId("t2"))).toHaveFocus();
	});

	it("stays open in push mode", () => {
		renderOpenDrawer("push");
		fireEvent.click(screen.getByRole("button", { name: "open item" }));
		expect(layout().drawerOpen).toBe(true);
	});

	it("stays open for an open that is not a selection, and for expanding", () => {
		renderOpenDrawer("overlay");
		fireEvent.click(screen.getByRole("button", { name: "duplicate" }));
		fireEvent.click(screen.getByRole("button", { name: "expand" }));
		expect(layout().drawerOpen).toBe(true);
		expect(screen.getByText("children")).toBeInTheDocument();
	});

	it("does not close the context bar, which has no selection to close on", () => {
		layout().setDrawerOpen(true);
		layout().setContextBarOpen(true);
		renderPanels("overlay", "push");
		fireEvent.click(screen.getByRole("button", { name: "open item" }));
		expect(layout().drawerOpen).toBe(false);
		expect(layout().contextBarOpen).toBe(true);

		fireEvent.click(screen.getByRole("button", { name: "alpha body" }));
		expect(layout().contextBarOpen).toBe(true);
	});
});

describe.each([
	["drawer", "Collections", "expand"],
	["context bar", "Alpha rail", "alpha body"],
] as const)("Escape on the %s overlay", (panel, railLabel, insideLabel) => {
	function renderOpen(mode: SidePanelMode) {
		if (panel === "drawer") layout().setDrawerOpen(true);
		else layout().setContextBarOpen(true);
		renderPanels(mode, mode);
	}
	const inside = () => screen.getByRole("button", { name: insideLabel });
	const isOpen = () => (panel === "drawer" ? layout().drawerOpen : layout().contextBarOpen);

	it("closes it and returns focus to its rail button when focus is inside", () => {
		renderOpen("overlay");
		inside().focus();
		fireEvent.keyDown(inside(), { key: "Escape" });
		expect(isOpen()).toBe(false);
		expect(screen.getByRole("button", { name: railLabel })).toHaveFocus();
	});

	// Closing unmounts the element holding focus, so focus has to move before
	// the close lands - asserted at the moment the flag flips.
	it("moves focus before the panel closes", () => {
		renderOpen("overlay");
		inside().focus();
		let focusWhenClosed: Element | null = null;
		const stop = useLayoutStore.subscribe((state, prev) => {
			const closed =
				panel === "drawer"
					? prev.drawerOpen && !state.drawerOpen
					: prev.contextBarOpen && !state.contextBarOpen;
			if (closed) focusWhenClosed = document.activeElement;
		});
		fireEvent.keyDown(inside(), { key: "Escape" });
		stop();
		expect(focusWhenClosed).toBe(screen.getByRole("button", { name: railLabel }));
	});

	it("leaves a pushing panel open", () => {
		renderOpen("push");
		inside().focus();
		fireEvent.keyDown(inside(), { key: "Escape" });
		expect(isOpen()).toBe(true);
	});

	it("leaves it open when focus is outside it", () => {
		renderOpen("overlay");
		screen.getByRole("button", { name: "outside" }).focus();
		fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
		expect(isOpen()).toBe(true);
	});

	it("leaves it open while a menu of its own is open", () => {
		renderOpen("overlay");
		inside().focus();
		const menu = document.createElement("div");
		menu.setAttribute("role", "menu");
		menu.setAttribute("data-state", "open");
		document.body.append(menu);
		fireEvent.keyDown(inside(), { key: "Escape" });
		expect(isOpen()).toBe(true);

		// A menu still playing its exit animation is closed.
		menu.setAttribute("data-state", "closed");
		fireEvent.keyDown(inside(), { key: "Escape" });
		expect(isOpen()).toBe(false);
		menu.remove();
	});

	it("leaves it open while a dialog is open", () => {
		renderOpen("overlay");
		inside().focus();
		const dialog = document.createElement("div");
		dialog.setAttribute("data-slot", "dialog-content");
		dialog.setAttribute("data-state", "open");
		document.body.append(dialog);
		fireEvent.keyDown(inside(), { key: "Escape" });
		expect(isOpen()).toBe(true);
		dialog.remove();
	});

	it("leaves it open when another handler already answered the press", () => {
		renderOpen("overlay");
		inside().focus();
		const handled = (e: KeyboardEvent) => e.preventDefault();
		document.addEventListener("keydown", handled, true);
		fireEvent.keyDown(inside(), { key: "Escape" });
		document.removeEventListener("keydown", handled, true);
		expect(isOpen()).toBe(true);
	});

	it("ignores every other key", () => {
		renderOpen("overlay");
		inside().focus();
		fireEvent.keyDown(inside(), { key: "Enter" });
		expect(isOpen()).toBe(true);
	});
});

describe("where Escape returns focus when no rail button is lit", () => {
	function renderDrawerWith(chrome: React.ReactNode) {
		layout().setDrawerOpen(true);
		render(
			<TooltipProvider>
				{chrome}
				<Drawer mode="overlay" siblingMode="overlay" />
			</TooltipProvider>
		);
		const expand = screen.getByRole("button", { name: "expand" });
		expand.focus();
		fireEvent.keyDown(expand, { key: "Escape" });
		expect(layout().drawerOpen).toBe(false);
	}

	it("uses the rail's roving stop", () => {
		renderDrawerWith(
			<>
				<RailButton
					active={false}
					label="Other"
					side="left"
					variant="indicator"
					tabIndex={-1}
				>
					o
				</RailButton>
				<RailButton
					active={false}
					label="Stop"
					side="left"
					variant="indicator"
					tabIndex={0}
				>
					s
				</RailButton>
				{/* The other rail's stop is not this panel's. */}
				<RailButton
					active={false}
					label="Right stop"
					side="right"
					variant="tile"
					tabIndex={0}
				>
					r
				</RailButton>
			</>
		);
		expect(screen.getByRole("button", { name: "Stop" })).toHaveFocus();
	});

	it("falls back to the active tab when the rail is not drawn", () => {
		renderDrawerWith(
			<button role="tab" id={tabElementId("t1")} tabIndex={-1}>
				tab one
			</button>
		);
		expect(screen.getByRole("tab", { name: "tab one" })).toHaveFocus();
	});
});

describe("Escape in a field", () => {
	it("is the field's own, and does not take the drawer", () => {
		layout().setDrawerOpen(true);
		renderPanels("overlay", "overlay");
		const filter = screen.getByRole("textbox", { name: "filter" });
		filter.focus();
		fireEvent.keyDown(filter, { key: "Escape" });
		expect(layout().drawerOpen).toBe(true);
	});
});

describe("Escape with a real menu open inside the drawer", () => {
	it("closes the menu and leaves the drawer", () => {
		layout().setDrawerOpen(true);
		render(
			<TooltipProvider>
				<Drawer mode="overlay" />
				<DropdownMenu open modal={false}>
					<DropdownMenuContent>
						<DropdownMenuItem>Rename</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</TooltipProvider>
		);
		const expand = screen.getByRole("button", { name: "expand" });
		expand.focus();
		fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
		expect(layout().drawerOpen).toBe(true);
	});
});

describe("a pointer press that dismisses a real modal menu", () => {
	it("closes the menu and leaves the drawer", () => {
		layout().setDrawerOpen(true);
		render(
			<TooltipProvider>
				<Drawer mode="overlay" />
				<DropdownMenu open>
					<DropdownMenuContent>
						<DropdownMenuItem>Rename</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</TooltipProvider>
		);
		expect(screen.getByRole("menu")).toBeInTheDocument();
		// A modal menu leaves the body unclickable, so the press lands on <html>.
		fireEvent.pointerDown(document.documentElement);
		expect(layout().drawerOpen).toBe(true);
	});
});

describe.each([
	["drawer", "Collections"],
	["context bar", "Alpha rail"],
] as const)("a pointer press outside the %s overlay", (panel, railLabel) => {
	function renderOpen(mode: SidePanelMode) {
		if (panel === "drawer") layout().setDrawerOpen(true);
		else layout().setContextBarOpen(true);
		renderPanels(mode, mode);
	}
	const isOpen = () => (panel === "drawer" ? layout().drawerOpen : layout().contextBarOpen);
	const inside = () =>
		screen.getByRole("button", { name: panel === "drawer" ? "expand" : "alpha body" });

	it("closes it without cancelling the press, so the click still lands", () => {
		renderOpen("overlay");
		// `fireEvent` answers false when a listener called `preventDefault`.
		const notCancelled = fireEvent.pointerDown(screen.getByRole("button", { name: "outside" }));
		expect(notCancelled).toBe(true);
		expect(isOpen()).toBe(false);
	});

	it("leaves a pushing panel open", () => {
		renderOpen("push");
		fireEvent.pointerDown(screen.getByRole("button", { name: "outside" }));
		expect(isOpen()).toBe(true);
	});

	// Heard in the capture phase: a target that stops propagation is still outside.
	it("closes it for a press on a target that stops the event", () => {
		renderOpen("overlay");
		const outside = screen.getByRole("button", { name: "outside" });
		const stop = (e: Event) => e.stopPropagation();
		outside.addEventListener("pointerdown", stop);
		fireEvent.pointerDown(outside);
		outside.removeEventListener("pointerdown", stop);
		expect(isOpen()).toBe(false);
	});

	it("leaves it open for a press inside it", () => {
		renderOpen("overlay");
		fireEvent.pointerDown(inside());
		expect(isOpen()).toBe(true);
	});

	it("leaves it open for a press on its menu, which is portalled out of it", () => {
		renderOpen("overlay");
		const menu = document.createElement("div");
		menu.setAttribute("role", "menu");
		const item = document.createElement("div");
		item.setAttribute("role", "menuitem");
		menu.append(item);
		document.body.append(menu);
		fireEvent.pointerDown(item);
		expect(isOpen()).toBe(true);
		menu.remove();
	});

	it("leaves it open while a menu is open, whatever the press lands on", () => {
		renderOpen("overlay");
		const menu = document.createElement("div");
		menu.setAttribute("role", "menu");
		menu.setAttribute("data-state", "open");
		document.body.append(menu);
		fireEvent.pointerDown(document.documentElement);
		expect(isOpen()).toBe(true);

		// A menu still playing its exit animation is closed.
		menu.setAttribute("data-state", "closed");
		fireEvent.pointerDown(document.documentElement);
		expect(isOpen()).toBe(false);
		menu.remove();
	});

	it("leaves it open while a dialog is up", () => {
		renderOpen("overlay");
		const dialog = document.createElement("div");
		dialog.setAttribute("data-slot", "dialog-content");
		dialog.setAttribute("data-state", "open");
		document.body.append(dialog);
		fireEvent.pointerDown(screen.getByRole("button", { name: "outside" }));
		expect(isOpen()).toBe(true);
		dialog.remove();
	});

	it("does not close and reopen when its own rail button toggles it", () => {
		renderOpen("overlay");
		const rail = screen.getByRole("button", { name: railLabel });
		fireEvent.pointerDown(rail);
		fireEvent.click(rail);
		expect(isOpen()).toBe(false);
	});

	it("opens from the rail button and closes on its next click", () => {
		renderOpen("overlay");
		const rail = screen.getByRole("button", { name: railLabel });
		fireEvent.click(rail);
		expect(isOpen()).toBe(false);
		fireEvent.pointerDown(rail);
		fireEvent.click(rail);
		expect(isOpen()).toBe(true);
	});
});
