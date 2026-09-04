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
 * "Copy Path" copies the path, not the tab's label (#1360).
 *
 * The value is assembled from two queries the strip already holds - the
 * request and the collections list (`tab-descriptors.ts`) - so the failure
 * this pins is the silent one: an item that copies the tab's name, or the
 * request's own name with the folders it lives in dropped, looks right in a
 * menu and is wrong on the clipboard.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TabStrip } from "./TabStrip";
import { useTabsStore } from "@/stores";

const REQUEST = {
	id: "req_1",
	collectionId: "col_billing",
	name: "Get customer",
	method: "GET",
	url: "https://api.example.test/v1/customers/42",
};

// Billing is a folder inside Acme, so the path has to walk the chain rather
// than name the request's own collection and stop.
const COLLECTIONS = [
	{ id: "acme", name: "Acme API", parentId: null, order: 0 },
	{ id: "col_billing", name: "Billing", parentId: "acme", order: 0 },
];

vi.mock("@/queries", () => ({
	requestDetailOptions: (id: string | null) => ({
		queryKey: ["request", id],
		queryFn: async () => (id ? REQUEST : undefined),
		initialData: id ? REQUEST : undefined,
		enabled: false,
	}),
	runDetailOptions: (id: string | null) => ({
		queryKey: ["run", id],
		queryFn: async () => undefined,
		initialData: undefined,
		enabled: false,
	}),
	useCollectionsQuery: () => ({ data: COLLECTIONS }),
}));

vi.mock("@/hooks/useVariableResolver", () => ({
	useVariableResolver: () => ({ resolveString: (s: string) => s }),
}));

const writeText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
	writeText.mockClear();
	// jsdom ships no clipboard, and `useCopy` reports a rejection rather than
	// claiming a copy that did not happen - so the stub has to resolve.
	Object.defineProperty(navigator, "clipboard", {
		value: { writeText },
		configurable: true,
	});
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "request", entityId: "req_1" }],
		activeTabId: "t1",
		navHistory: [],
		navIndex: -1,
	});
});

describe("Copy Path", () => {
	it("copies the collection chain and the request's name", async () => {
		render(
			<QueryClientProvider client={new QueryClient()}>
				<TabStrip />
			</QueryClientProvider>
		);

		fireEvent.contextMenu(document.querySelector<HTMLElement>('[data-tab-id="t1"]')!);
		fireEvent.click(await screen.findByRole("menuitem", { name: "Copy Path" }));

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText).toHaveBeenCalledWith("Acme API / Billing / Get customer");
	});
});
