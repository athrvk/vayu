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
 * "Copy for agent" on an element row (#2047).
 *
 * A `⋯` menu item, so a copy that landed toasts (the Copy feedback rule). The
 * list has no owner of its own: a host that names one gets the item, a host
 * that does not gets a menu without it.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { useToastStore } from "@/stores";
import type { ElementDef, ElementKindSchema } from "@/types";
import type { ElementOwner } from "@/lib/agent-reference";
import { ElementList } from "./index";

const SENTINEL = "s3cr3t-sentinel";

const KINDS: ElementKindSchema[] = [
	{
		kind: "extract.json",
		version: 1,
		label: "Extract JSON",
		description: "Extract JSON description",
		category: "extract",
		hotPathClass: "declarative",
		collectionOnly: false,
		configSchema: { type: "object", properties: { path: { type: "string" } } },
		phases: [],
	},
];

/** Its `config` carries the sentinel: the place a script or an expected value sits. */
const ELEMENT: ElementDef = {
	id: "el_1",
	kind: "extract.json",
	name: "Token",
	enabled: true,
	config: { path: SENTINEL },
};

const REQUEST_OWNER: ElementOwner = {
	type: "request",
	request: { id: "req_1", name: "List pets" },
};

const writeText = vi.fn();

beforeEach(() => {
	writeText.mockReset().mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
	useToastStore.setState({ toasts: [] });
});

async function openMenu(owner?: ElementOwner, elements: ElementDef[] = [ELEMENT]) {
	render(
		<ElementList elements={elements} onChange={vi.fn()} kinds={KINDS} referenceOwner={owner} />
	);
	const trigger = screen.getByRole("button", { name: "More actions for Extract JSON" });
	fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
	fireEvent.click(trigger, { detail: 1 });
	return screen.findByRole("menu");
}

describe("Copy for agent on an element row", () => {
	it("copies the reference line and says so", async () => {
		await openMenu(REQUEST_OWNER);

		fireEvent.click(await screen.findByRole("menuitem", { name: /Copy for agent/ }));

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText).toHaveBeenCalledWith(
			'Vayu element "Token" (el_1) of request "List pets" (req_1)'
		);
		await waitFor(() =>
			expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
				"Reference copied",
			])
		);
	});

	it("names a collection owner", async () => {
		await openMenu({ type: "collection", collection: { id: "col_1", name: "Billing" } });

		fireEvent.click(await screen.findByRole("menuitem", { name: /Copy for agent/ }));

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText).toHaveBeenCalledWith(
			'Vayu element "Token" (el_1) of collection "Billing" (col_1)'
		);
	});

	it("names an unnamed element by its kind", async () => {
		await openMenu(REQUEST_OWNER, [{ ...ELEMENT, name: undefined }]);

		fireEvent.click(await screen.findByRole("menuitem", { name: /Copy for agent/ }));

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText.mock.calls[0][0]).toBe(
			'Vayu element "extract.json" (el_1) of request "List pets" (req_1)'
		);
	});

	it("never carries the element's config", async () => {
		await openMenu(REQUEST_OWNER);

		fireEvent.click(await screen.findByRole("menuitem", { name: /Copy for agent/ }));

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText.mock.calls[0][0]).not.toContain(SENTINEL);
	});

	it("sits after Duplicate and before the destructive Delete", async () => {
		const menu = await openMenu(REQUEST_OWNER);

		const labels = within(menu)
			.getAllByRole("menuitem")
			.map((item) => item.textContent ?? "");
		const at = (label: string) => labels.findIndex((text) => text.startsWith(label));

		expect(at("Duplicate")).toBeGreaterThan(-1);
		expect(at("Copy for agent")).toBe(at("Duplicate") + 1);
		expect(at("Delete")).toBe(at("Copy for agent") + 1);
	});

	it("is absent when the host names no owner", async () => {
		const menu = await openMenu(undefined);

		expect(within(menu).getByRole("menuitem", { name: "Duplicate" })).toBeInTheDocument();
		expect(within(menu).queryByRole("menuitem", { name: /Copy for agent/ })).toBeNull();
	});
});
