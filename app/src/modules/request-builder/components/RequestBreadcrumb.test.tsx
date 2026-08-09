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
 * The crumb above the URL bar says where the open request lives.
 *
 * Nothing in the builder said before. The tab strip shows a bare name, so a
 * request opened from a nested folder gave no clue which collection chain - and
 * therefore which inherited auth, scripts and variables - it belonged to.
 *
 * Two things here are easy to get wrong and invisible in review:
 *
 *   1. **The empty band.** A header row that renders whether or not it has
 *      anything to show is what the description band charged every request
 *      ~30px for until it became the Info tab. A request with no collection and
 *      no name must produce no element, not an element with no text - and only
 *      absence, not emptiness, can be asserted for.
 *   2. **Which segment gives way.** The name is the part you are looking for,
 *      so the ancestors truncate and it does not. jsdom has no layout, so the
 *      classes are the assertion: `min-w-0` + `truncate` on the ancestors is
 *      what makes `truncate` engage at all inside a flex row, and `shrink-0` on
 *      the name is what keeps it out of the negotiation.
 *
 * The chain is read live from the collections cache rather than captured, so a
 * rename or a drag-move shows up here without a refetch - asserted below by
 * changing what the hook returns.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Collection } from "@/types";
import type { RequestBuilderContextValue, RequestState } from "../types";

const openTab = vi.fn();
let ancestors: Collection[] = [];

vi.mock("@/queries/collections", () => ({
	useCollectionAncestors: () => ancestors,
}));

vi.mock("@/stores", () => ({
	useTabsStore: (selector: (s: { openTab: typeof openTab }) => unknown) => selector({ openTab }),
}));

const { RequestBuilderContext } = await import("../context");
const { default: RequestBreadcrumb } = await import("./RequestBreadcrumb");

function collection(id: string, name: string): Collection {
	return { id, name } as unknown as Collection;
}

function renderCrumb(request: Partial<RequestState>) {
	const value = {
		request: { name: "Untitled Request", collectionId: "col_leaf", ...request },
	} as unknown as RequestBuilderContextValue;

	return render(
		<RequestBuilderContext.Provider value={value}>
			<RequestBreadcrumb />
		</RequestBuilderContext.Provider>
	);
}

const crumb = () => screen.queryByRole("navigation", { name: "Request location" });

beforeEach(() => {
	openTab.mockClear();
	ancestors = [];
});

describe("RequestBreadcrumb", () => {
	it("renders the chain root-first, then the request name", () => {
		ancestors = [collection("col_root", "Acme API"), collection("col_leaf", "Payouts")];
		renderCrumb({ name: "List settlements" });

		// Reading order is the claim, so the text is read off the whole row
		// rather than segment by segment - separate `getByText`s would pass on a
		// leaf-first chain.
		expect(crumb()?.textContent).toBe("Acme APIPayoutsList settlements");
	});

	it("opens a collection's tab when its segment is clicked", () => {
		ancestors = [collection("col_root", "Acme API"), collection("col_leaf", "Payouts")];
		renderCrumb({ name: "List settlements" });

		screen.getByRole("button", { name: "Payouts" }).click();

		expect(openTab).toHaveBeenCalledWith({ type: "collection", entityId: "col_leaf" });
	});

	it("makes the request name inert - you are already there", () => {
		ancestors = [collection("col_root", "Acme API")];
		renderCrumb({ name: "List settlements" });

		// One button per ancestor, and none for the name. Renaming is the Info
		// tab's job; a second rename surface here would be two controls for one act.
		expect(screen.getAllByRole("button")).toHaveLength(1);
	});

	it("shows the name alone for a request in no collection", () => {
		renderCrumb({ name: "Scratch request", collectionId: null });

		expect(crumb()?.textContent).toBe("Scratch request");
	});

	it("renders no band at all when there is nothing to show", () => {
		renderCrumb({ name: "   ", collectionId: null });

		// Not "renders empty" - an empty flex row still costs its padding, which
		// is the permanent band this deliberately does not draw.
		expect(crumb()).toBeNull();
	});

	it("truncates ancestors and never the name", () => {
		ancestors = [collection("col_root", "A collection with a very long name indeed")];
		renderCrumb({ name: "List settlements" });

		const ancestorLabel = screen.getByText("A collection with a very long name indeed");
		expect(ancestorLabel.className).toContain("truncate");
		expect(screen.getByRole("button").className).toContain("min-w-0");

		const name = screen.getByText("List settlements");
		expect(name.className).toContain("shrink-0");
		expect(name.className).not.toContain("truncate");
	});

	it("follows a rename in the cache", () => {
		ancestors = [collection("col_leaf", "Payouts")];
		const { rerender } = renderCrumb({ name: "List settlements" });

		ancestors = [collection("col_leaf", "Settlements")];
		const value = {
			request: { name: "List settlements", collectionId: "col_leaf" },
		} as unknown as RequestBuilderContextValue;
		rerender(
			<RequestBuilderContext.Provider value={value}>
				<RequestBreadcrumb />
			</RequestBuilderContext.Provider>
		);

		expect(crumb()?.textContent).toBe("SettlementsList settlements");
	});
});
