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
 * Opening a request from the tree must be instant.
 *
 * The row used to defer `onSelect` behind an 80ms `setTimeout` so it could tell
 * a single click (open) from a double click (rename). That delay was felt on
 * every open. Opening is idempotent, so the row now opens on the first click and
 * lets the double click rename on top of it - no timer. These lock that in: the
 * open fires synchronously (reintroducing the debounce makes the first test
 * fail, since no timers are advanced), the second click of a double click is
 * ignored, and a double click still renames.
 */

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import RequestItem from "./RequestItem";
import { withCollectionTreeContext } from "@/test/collection-tree-context";
import type { Request } from "@/types";

const REQUEST: Request = {
	id: "req_1",
	collectionId: "col_1",
	name: "Get user",
	description: "",
	method: "GET",
	url: "https://api.test/user",
	params: [],
	headers: [],
	body: { mode: "none" },
	bodyType: "none",
	auth: { mode: "none" },
	preRequestScript: "",
	postRequestScript: "",
	followRedirects: true,
	maxRedirects: 10,
	verifySSL: true,
	httpVersion: "auto",
	stream: false,
	order: 0,
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
};

function renderItem() {
	const onSelect = vi.fn();
	const onStartRename = vi.fn();
	const { container } = render(
		withCollectionTreeContext(
			<RequestItem request={REQUEST} collectionId="col_1" posInSet={1} setSize={1} />,
			{ onRequestClick: onSelect, onStartRequestRename: onStartRename }
		)
	);
	const target = container.querySelector("[data-tree-activate]") as HTMLElement;
	return { onSelect, onStartRename, target, container };
}

describe("RequestItem opens without a click delay", () => {
	it("opens on a single click, synchronously", () => {
		const { onSelect, target } = renderItem();
		fireEvent.click(target, { detail: 1 });
		// No fake timers, nothing advanced: the open must already have fired.
		// Reintroducing the setTimeout debounce trips this.
		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(onSelect).toHaveBeenCalledWith("col_1", "req_1");
	});

	it("ignores the second click of a double click", () => {
		const { onSelect, target } = renderItem();
		fireEvent.click(target, { detail: 2 });
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("starts a rename on double click", () => {
		const { onStartRename, target } = renderItem();
		fireEvent.doubleClick(target);
		expect(onStartRename).toHaveBeenCalledWith(REQUEST);
	});

	// The keyboard path: useRovingTreeFocus clicks this hidden control on F2.
	it("exposes a data-tree-rename control wired to onStartRename", () => {
		const { onStartRename, container } = renderItem();
		const control = container.querySelector("[data-tree-rename]") as HTMLElement;
		expect(control).toBeTruthy();
		fireEvent.click(control);
		expect(onStartRename).toHaveBeenCalledWith(REQUEST);
	});
});

/**
 * The method chip in the tree row sits inside the row's own hover fill and
 * selection ring, so a bordered chip on every row was a second shape competing
 * with both. The row uses `MethodBadge`'s text variant inside a caller-set
 * `w-[5ch]` column (the pattern the import preview also uses), giving the
 * name after it the same starting x every method. These guards render the row
 * and read the chip's class list, because the class arrives through `cn()`
 * inside the primitive and a source scan of `RequestItem` cannot see it.
 */
describe("RequestItem method chip is a colour-only fixed column, not a bordered chip", () => {
	it("carries the fixed 5ch column and no chip chrome", () => {
		const { container } = renderItem();
		// The chip is the only `font-mono` span the row renders, and the only
		// caller in the row that reaches `MethodBadge`. Reach it by its font
		// stack so this test does not care about markup order changes.
		const chip = container.querySelector("span.font-mono") as HTMLElement;
		expect(chip).toBeTruthy();
		// Fixed column matching the abbreviated methods (`DEL`, `OPT`, `CONN`)
		// and the widest whole label (`PATCH`), so every request name after it
		// starts at the same x.
		expect(chip.className).toContain("w-[5ch]");
		// No border and no chip fill: colour alone carries the method signal
		// against the row's hover fill and selection ring.
		expect(chip.className).not.toContain("border ");
		expect(chip.className).not.toMatch(/\brounded-md\b/);
		expect(chip.className).not.toContain("px-1.5");
		// Mutation check: reverting the row back to `variant="badge"` puts the
		// column class from `WIDTH_CLASS` on the chip and this assertion fails.
		expect(chip.className).not.toContain("w-[calc(");
	});
});
