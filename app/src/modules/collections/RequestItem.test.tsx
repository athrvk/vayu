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
	order: 0,
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
};

function renderItem() {
	const onSelect = vi.fn();
	const onStartRename = vi.fn();
	const { container } = render(
		<RequestItem
			request={REQUEST}
			collectionId="col_1"
			onSelect={onSelect}
			onDelete={vi.fn()}
			onStartRename={onStartRename}
		/>
	);
	const target = container.querySelector("[data-tree-activate]") as HTMLElement;
	return { onSelect, onStartRename, target };
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
});
