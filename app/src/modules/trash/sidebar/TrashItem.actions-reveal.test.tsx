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
 * A trash row gives its name the drawer's width until it is hovered or focused
 * (#3495), and its meta line is one line with the full text a hover away.
 *
 * Three always-visible buttons left the name about 105px of the 260px drawer and
 * let the meta wrap to four lines. The buttons stay in the DOM and are found by
 * their names (`ROW_ACTIONS_REVEAL` keeps them focusable); jsdom has no layout,
 * so the rule is held as the rendered classes.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import { ROW_ACTIONS_REVEAL } from "@/components/shared";
import TrashItem from "./TrashItem";
import type { TrashEntry } from "@/types";

const ENTRY: TrashEntry = {
	id: "c1",
	kind: "collection",
	name: "Billing",
	parentName: "Payments API",
	deletedAt: Date.now() - 60_000,
	purgeCollections: 1,
	purgeRequests: 3,
};

function renderRow() {
	const { container } = render(
		<TrashItem
			entry={ENTRY}
			onRestore={vi.fn()}
			onPurge={vi.fn()}
			isRestoring={false}
			isPurging={false}
		/>
	);
	const buttons = [
		screen.getByRole("button", { name: "Copy Billing for agent" }),
		screen.getByRole("button", { name: "Restore Billing" }),
		screen.getByRole("button", { name: "Delete Billing forever" }),
	];
	return { row: container.querySelector<HTMLElement>("[data-trash-id]")!, buttons };
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("TrashItem row actions", () => {
	it("collapse as one cluster against the row, which is the group they reveal on", () => {
		const { row, buttons } = renderRow();
		const cluster = buttons[0].parentElement!;
		expect(buttons.every((b) => b.parentElement === cluster)).toBe(true);
		for (const token of ROW_ACTIONS_REVEAL.split(" ")) {
			expect(cluster.classList.contains(token), token).toBe(true);
		}
		// The collapsed cluster is absolute, so the row has to be its containing block.
		expect(row.classList.contains("group")).toBe(true);
		expect(row.classList.contains("relative")).toBe(true);
		// `hidden` would take Restore and Delete out of the tab order.
		for (const removed of ["hidden", "invisible", "sr-only"]) {
			expect(cluster.classList.contains(removed), removed).toBe(false);
		}
	});

	it("keeps Restore and Delete forever focusable by keyboard", () => {
		const { buttons } = renderRow();
		for (const button of buttons) {
			button.focus();
			expect(document.activeElement).toBe(button);
		}
	});

	it("truncates the meta to one line", () => {
		renderRow();
		expect(screen.getByText(/Deleted/).className).toContain("truncate");
	});

	it("gives the whole meta sentence as a title while it is cut", () => {
		vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(400);
		vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(120);
		renderRow();
		const title = screen.getByText(/Deleted/).getAttribute("title")!;
		expect(title).toMatch(
			/^Collection · from Payments API · Deleted .+, with 1 collection, 3 requests$/
		);
	});

	it("gives no title when the meta fits", () => {
		vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(100);
		vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(120);
		renderRow();
		expect(screen.getByText(/Deleted/)).not.toHaveAttribute("title");
	});
});
