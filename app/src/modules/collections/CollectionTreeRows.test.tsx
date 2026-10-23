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
 * The flat list's per-row wrapper (#2543): the gap above each row, and the
 * dimming of everything inside a folder being deleted. With every row a
 * sibling the list has to say them per row, and nothing else would notice if
 * it stopped.
 *
 * jsdom has no layout, so the pitch is read as the classes each row's wrapper
 * carries rather than as a measured offset.
 */

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import CollectionTreeRows from "./CollectionTreeRows";
import { flattenVisibleRows } from "./tree-rows";
import { withCollectionTreeContext } from "@/test/collection-tree-context";
import type { Collection, RequestSummary } from "@/types";

vi.mock("@/queries", () => ({
	useReorderMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

function folder(id: string, order: number, parentId?: string): Collection {
	return { id, name: id, order, parentId } as Collection;
}

const COLLECTIONS = [folder("acme", 0), folder("billing", 0, "acme"), folder("beta", 1)];
const REQUESTS: Record<string, RequestSummary[]> = {
	acme: [
		{ id: "r1", name: "Ping", collectionId: "acme", method: "GET", order: 0 } as RequestSummary,
	],
};
const getRequestsByCollection = (id: string) => REQUESTS[id] ?? [];

function renderRows(
	deletingCollectionId: string | null = null,
	selectedRequestId: string | null = null
) {
	const expandedCollectionIds = new Set(["acme", "billing"]);
	const rows = flattenVisibleRows({
		collections: COLLECTIONS,
		getRequestsByCollection,
		expandedCollectionIds,
		creatingSubfolder: null,
		selectedRequestId,
	});
	const { container } = render(
		withCollectionTreeContext(<CollectionTreeRows rows={rows} />, {
			allCollections: COLLECTIONS,
			expandedCollectionIds,
			getRequestsByCollection,
			deletingCollectionId,
		})
	);
	const wrappers = Array.from(container.children) as HTMLElement[];
	expect(wrappers).toHaveLength(rows.length);
	return wrappers;
}

/** Which row a wrapper holds, by the attribute or text that names it. */
function rowName(wrapper: HTMLElement): string {
	const row = wrapper.firstElementChild as HTMLElement;
	return (
		row.getAttribute("data-collection-id") ??
		row.getAttribute("data-request-id") ??
		row.textContent ??
		""
	);
}

describe("the flat tree's rows", () => {
	it("keep the nested tree's pitch: a whole unit into a folder, half a unit between rows", () => {
		const wrappers = renderRows();

		// The gap is the wrapper's top padding and part of its height, so the row
		// stride is the height class alone: 8 for the row, plus the gap.
		expect(
			wrappers.map((wrapper) => [
				rowName(wrapper),
				wrapper.classList.contains("pt-1")
					? "pt-1"
					: wrapper.classList.contains("pt-0.5")
						? "pt-0.5"
						: "none",
				Array.from(wrapper.classList).find((name) => name.startsWith("h-")),
			])
		).toEqual([
			["acme", "none", "h-8"],
			["billing", "pt-1", "h-9"],
			["Empty collection", "pt-1", "h-9"],
			["r1", "pt-0.5", "h-8.5"],
			["beta", "pt-0.5", "h-8.5"],
		]);
	});

	it("dim everything inside a folder being deleted, and nothing beside it", () => {
		const wrappers = renderRows("acme");

		const dimmed = wrappers
			.filter((wrapper) => wrapper.classList.contains("opacity-50"))
			.map(rowName);
		expect(dimmed).toEqual(["billing", "Empty collection", "r1"]);
		// The folder dims itself, on its own row, as a request row does.
		const acme = wrappers[0].firstElementChild as HTMLElement;
		expect(acme.getAttribute("data-collection-id")).toBe("acme");
		expect(acme.className).toContain("opacity-50");
	});

	it("dim nothing when no folder is being deleted", () => {
		const wrappers = renderRows();

		expect(wrappers.some((wrapper) => wrapper.classList.contains("opacity-50"))).toBe(false);
		expect(wrappers[0].firstElementChild?.className).not.toContain("opacity-50");
	});
});

describe("the flat tree's indent guides (#2773)", () => {
	/** How many guide layers a wrapper's row paints, accent layer included. */
	function guideLayers(wrapper: HTMLElement): number {
		const image = (wrapper.firstElementChild as HTMLElement).style.backgroundImage;
		return image ? image.split("linear-gradient").length - 1 : 0;
	}
	const accentLayers = (wrapper: HTMLElement) =>
		(
			(wrapper.firstElementChild as HTMLElement).style.backgroundImage.match(
				/linear-gradient\(hsl\(var\(--primary\)/g
			) ?? []
		).length;

	it("draw one layer per ancestor on folder, request, placeholder and form rows", () => {
		const wrappers = renderRows();

		expect(wrappers.map((wrapper) => [rowName(wrapper), guideLayers(wrapper)])).toEqual([
			["acme", 0],
			["billing", 1],
			["Empty collection", 2],
			["r1", 1],
			["beta", 0],
		]);
	});

	it("draw the accent layer on the selected request's folder subtree only", () => {
		const wrappers = renderRows(null, "r1");

		expect(wrappers.map((wrapper) => [rowName(wrapper), accentLayers(wrapper)])).toEqual([
			["acme", 0],
			["billing", 1],
			["Empty collection", 1],
			["r1", 1],
			["beta", 0],
		]);
	});
});

describe("the guides across the gap above a row (#2773)", () => {
	const wrapperImage = (wrapper: HTMLElement) => wrapper.style.backgroundImage;

	it("paint the ancestors' lines on a wrapper with a gap, over the gap alone", () => {
		const wrappers = renderRows();
		const billing = wrappers[1];

		// One ancestor level, drawn only as tall as the 1-unit gap above the row.
		expect(wrapperImage(billing).split("linear-gradient")).toHaveLength(2);
		expect(billing.style.backgroundSize).toBe("1px calc(var(--spacing) * 1)");
		expect(wrappers[3].style.backgroundSize).toBe("1px calc(var(--spacing) * 0.5)");
	});

	it("leave a wrapper with no gap, or no ancestors, unpainted", () => {
		const wrappers = renderRows();

		// acme is the first row (no gap); beta is a root (no ancestors).
		expect(wrapperImage(wrappers[0])).toBe("");
		expect(wrapperImage(wrappers[4])).toBe("");
	});

	it("add the accent to the strip only inside the selected request's folder", () => {
		const wrappers = renderRows(null, "r1");

		expect(wrapperImage(wrappers[1])).toContain("linear-gradient(hsl(var(--primary)");
		expect(wrapperImage(wrappers[4])).toBe("");
	});
});
