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
 * "Copy for agent" on a request row (#2047).
 *
 * The row hands `requestReference` the chain of the request's own collection,
 * so the folders it sits in ride along; and the request it is handed carries a
 * secret in every place a careless copy could reach (url query, header, auth),
 * none of which may land on the clipboard.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import RequestItem from "./RequestItem";
import { withCollectionTreeContext } from "@/test/collection-tree-context";
import { useToastStore } from "@/stores";
import type { Collection, Request } from "@/types";

const SENTINEL = "s3cr3t-sentinel";

const REQUEST = {
	id: "req_1",
	collectionId: "col_billing",
	name: "Get customer",
	method: "GET",
	url: `https://api.example.test/v1/customers/42?token=${SENTINEL}`,
	headers: [{ key: "X-Api-Key", value: SENTINEL, enabled: true }],
	auth: { mode: "bearer", token: SENTINEL },
} as unknown as Request;

// Billing is a folder inside Acme: the line has to walk the chain.
const COLLECTIONS = [
	{ id: "acme", name: "Acme API", order: 0 },
	{ id: "col_billing", name: "Billing", parentId: "acme", order: 0 },
] as Collection[];

const writeText = vi.fn();

beforeEach(() => {
	writeText.mockReset().mockResolvedValue(undefined);
	// jsdom ships no clipboard, and `useCopy` reports a rejection rather than
	// claiming a copy that did not happen - so the stub has to resolve.
	Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
	useToastStore.setState({ toasts: [] });
});

/**
 * The row's own `⋯` menu. Right-click reaches the same list through the tree's
 * one menu (`CollectionTree.copy-for-agent.test.tsx` drives that route), which a
 * row rendered on its own does not have.
 */
function openMenu() {
	const { container } = render(
		withCollectionTreeContext(
			<RequestItem request={REQUEST} collectionId="col_billing" posInSet={1} setSize={1} />,
			{ allCollections: COLLECTIONS }
		)
	);
	// Radix opens its dropdown on pointerdown, not click.
	fireEvent.pointerDown(
		container.querySelector("[data-tree-menu]")!,
		new PointerEvent("pointerdown", { bubbles: true, button: 0 })
	);
}

describe("Copy for agent on a request row", () => {
	it("copies the reference line with its collection chain and says so", async () => {
		openMenu();

		fireEvent.click(await screen.findByRole("menuitem", { name: /Copy for agent/ }));

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText).toHaveBeenCalledWith(
			'Vayu request "Get customer" (req_1) in Acme API / Billing'
		);
		await waitFor(() =>
			expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
				"Reference copied",
			])
		);
	});

	it("never carries a url query, header or auth value", async () => {
		openMenu();

		fireEvent.click(await screen.findByRole("menuitem", { name: /Copy for agent/ }));

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText.mock.calls[0][0]).not.toContain(SENTINEL);
		expect(writeText.mock.calls[0][0]).not.toContain("api.example.test");
	});

	it("shows the line as the item's hint, so the user sees what will be copied", async () => {
		openMenu();

		const item = await screen.findByRole("menuitem", { name: /Copy for agent/ });
		expect(item).toHaveTextContent('Vayu request "Get customer" (req_1) in Acme API / Billing');
	});
});
