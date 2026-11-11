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
 * Right-click on a row offers the row's own actions (#1360).
 *
 * The contract every surface takes this component for: the same list the `⋯`
 * menu shows, focus on the row it opened over, and the marker that keeps the
 * main process's edit menu from drawing a second menu over this one.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { Copy, CopyPlus, Pencil, Trash2 } from "lucide-react";
import { RowContextMenu } from "./RowContextMenu";
import { CONTEXT_ATTRIBUTE } from "@/lib/context-menu";
import type { RowAction } from "./row-actions";
import { menuClosedAndFocusSettled } from "@/test/menu-focus";

const actions: RowAction[] = [
	{ label: "Duplicate", icon: CopyPlus, onSelect: () => {} },
	{ label: "Delete", icon: Trash2, onSelect: () => {}, destructive: true },
];

function renderRow(overrides: Partial<Parameters<typeof RowContextMenu>[0]> = {}) {
	return render(
		<RowContextMenu label="Actions for Orders" actions={actions} {...overrides}>
			<div role="treeitem" aria-selected={false} data-testid="row" tabIndex={-1}>
				Orders
			</div>
		</RowContextMenu>
	);
}

const row = () => screen.getByTestId("row");

describe("RowContextMenu", () => {
	it("opens the row's actions on right-click", async () => {
		renderRow();

		fireEvent.contextMenu(row());

		const menu = await screen.findByRole("menu");
		expect(within(menu).getByRole("menuitem", { name: "Duplicate" })).toBeInTheDocument();
		expect(within(menu).getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
	});

	it("runs the action that was chosen", async () => {
		const onSelect = vi.fn();
		renderRow({ actions: [{ label: "Rename", icon: Copy, onSelect }] });

		fireEvent.contextMenu(row());
		fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));

		await waitFor(() => expect(onSelect).toHaveBeenCalledOnce());
	});

	it("marks the row so the main process draws no second menu over it", () => {
		renderRow();

		// The renderer cannot suppress the native menu with `preventDefault` -
		// Chromium raises it on the web contents regardless - so the marker is
		// what refuses it (`electron/context-menu.ts`).
		expect(row()).toHaveAttribute(CONTEXT_ATTRIBUTE, "own-menu");
	});

	it("leaves a row with no actions untouched, marker included", () => {
		renderRow({ actions: [] });

		fireEvent.contextMenu(row());

		expect(screen.queryByRole("menu")).not.toBeInTheDocument();
		expect(row()).not.toHaveAttribute(CONTEXT_ATTRIBUTE);
	});

	/*
	 * A right-click moves no focus of its own, so the row is focused on the way
	 * past and the menu's focus scope has somewhere of ours to return to. Drop
	 * that `focus()` and this lands on `<body>` - outside the tree that was
	 * holding its one tab stop.
	 *
	 * Focus, not selection: selecting a request in this tree means opening its
	 * tab, and no file manager opens a document because you right-clicked it.
	 * The actions are the pointed-at row's either way - each row builds its own
	 * list over its own entity.
	 */
	it("hands focus back to the row on Escape", async () => {
		renderRow();

		fireEvent.contextMenu(row());
		const menu = await screen.findByRole("menu");
		fireEvent.keyDown(menu, { key: "Escape" });

		await waitFor(() => expect(document.activeElement).toBe(row()));
	});

	/*
	 * A Rename that opens its field from `onSelect` loses it to the menu's focus
	 * trap and then to the row (#3443): the field is blurred, which commits the
	 * name unchanged. An `opensField` action runs from the close instead.
	 */
	it("leaves focus in the field an opensField action opened", async () => {
		function Row() {
			const [renaming, setRenaming] = useState(false);
			const rowActions: RowAction[] = [
				{
					label: "Rename",
					icon: Pencil,
					opensField: true,
					onSelect: () => setRenaming(true),
				},
			];
			return (
				<RowContextMenu label="Actions for Orders" actions={rowActions}>
					<div role="treeitem" aria-selected={false} data-testid="row" tabIndex={-1}>
						{renaming ? <input aria-label="Name" autoFocus /> : "Orders"}
					</div>
				</RowContextMenu>
			);
		}
		render(<Row />);
		fireEvent.contextMenu(row());
		fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
		const field = await screen.findByLabelText("Name");

		await menuClosedAndFocusSettled();

		expect(document.activeElement).toBe(field);
	});
});
