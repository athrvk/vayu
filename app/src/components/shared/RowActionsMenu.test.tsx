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
 * The row menu's keyboard path (#1212).
 *
 * Radix's dropdown trigger opens on `pointerdown` and on its own `keydown`, and
 * `HTMLElement.click()` is neither - which is exactly what the collection
 * tree's Shift+F10 / Menu / Shift+Enter keys dispatch at `[data-tree-menu]`.
 * Every menu-only row action was therefore mouse-only, and nothing caught it:
 * the component had no test at all, and the tree's tests all open the menu with
 * `pointerDown` because they already knew click did nothing.
 *
 * These cases pin both halves - the click path on, the mouse path unchanged -
 * plus the `tabIndex` prop the roving-tabindex tree needs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Copy, Trash2 } from "lucide-react";
import { RowActionsMenu } from "./RowActionsMenu";

const duplicate = vi.fn();
const remove = vi.fn();

const actions = [
	{ label: "Duplicate", icon: Copy, onSelect: duplicate },
	{ label: "Delete", icon: Trash2, onSelect: remove, destructive: true },
];

const LABEL = "More actions for Get users";
const trigger = () => screen.getByRole("button", { name: LABEL });

function renderMenu(tabIndex?: number) {
	return render(<RowActionsMenu label={LABEL} actions={actions} tabIndex={tabIndex} />);
}

/**
 * What a mouse does: Radix opens on the pointerdown, and the click the browser
 * fires after it - `detail` 1, because a pointer is behind it - arrives at an
 * already-open menu.
 */
function mousePress(el: HTMLElement) {
	fireEvent.pointerDown(el, { button: 0, ctrlKey: false, pointerType: "mouse" });
	fireEvent.click(el, { detail: 1 });
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("opening the menu", () => {
	it("opens on a click with no pointer behind it, which is what a key dispatches", async () => {
		renderMenu();

		// Exactly what `useRovingTreeFocus` does for Shift+F10 / Menu /
		// Shift+Enter: a native click, so `detail` is 0.
		trigger().click();

		expect(await screen.findByRole("menu")).toBeInTheDocument();
		expect(screen.getByRole("menuitem", { name: "Duplicate" })).toBeInTheDocument();
		expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
	});

	it("runs the action the keyboard-opened menu selects", async () => {
		renderMenu();
		trigger().click();

		fireEvent.click(await screen.findByRole("menuitem", { name: "Duplicate" }));

		await waitFor(() => expect(duplicate).toHaveBeenCalledTimes(1));
		expect(remove).not.toHaveBeenCalled();
	});

	it("opens once for a mouse press, whose click must not undo its own pointerdown", async () => {
		renderMenu();

		mousePress(trigger());

		expect(await screen.findByRole("menu")).toBeInTheDocument();
		// One menu, still open: a handler that toggled on every click - rather
		// than opening only on the pointer-less one - would close it here.
		expect(screen.getAllByRole("menu")).toHaveLength(1);
	});

	it("renders nothing when the row has no actions", () => {
		const { container } = render(<RowActionsMenu label={LABEL} actions={[]} />);
		expect(container).toBeEmptyDOMElement();
	});
});

describe("the trigger's tab stop", () => {
	it("is a tab stop by default, so an ordinary row's menu is reachable", () => {
		renderMenu();
		expect(trigger()).toHaveAttribute("tabindex", "0");
	});

	it("takes -1 from a roving-tabindex tree, where the row holds the stop", () => {
		renderMenu(-1);
		expect(trigger()).toHaveAttribute("tabindex", "-1");
	});
});

describe("where focus lands when the menu closes", () => {
	it("returns to the row when the trigger is inside a treeitem", async () => {
		render(
			<div role="tree">
				<div role="treeitem" tabIndex={0} data-testid="row">
					<RowActionsMenu label={LABEL} actions={actions} tabIndex={-1} />
				</div>
			</div>
		);
		const row = screen.getByTestId("row");
		trigger().click();
		const menu = await screen.findByRole("menu");

		fireEvent.keyDown(menu, { key: "Escape" });

		// Radix hands focus back to the trigger, which is not a tab stop here -
		// so Escape would strand the tree's one stop on an unreachable control.
		await waitFor(() => expect(document.activeElement).toBe(row));
	});

	it("leaves Radix's own focus return alone outside a tree", async () => {
		renderMenu();
		const button = trigger();
		button.click();
		const menu = await screen.findByRole("menu");

		fireEvent.keyDown(menu, { key: "Escape" });

		await waitFor(() => expect(document.activeElement).toBe(button));
	});
});
