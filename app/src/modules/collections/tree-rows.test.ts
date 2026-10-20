/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import type { Collection, Request } from "@/types";
import {
	flattenVisibleRows,
	rowKeysUnder,
	rowSpacingAbove,
	type TreeRow,
	type VisibleRowsInput,
} from "./tree-rows";

/** Only the fields the flattening reads; the rest never matter to it. */
function folder(id: string, order: number, parentId?: string): Collection {
	return { id, name: id, order, parentId } as Collection;
}

function request(id: string, collectionId: string, order: number): Request {
	return { id, name: id, collectionId, order } as Request;
}

function flatten(
	collections: Collection[],
	options: {
		requests?: Record<string, Request[]>;
		expanded?: string[];
		creatingSubfolder?: string | null;
	} = {}
): TreeRow[] {
	const input: VisibleRowsInput = {
		collections,
		getRequestsByCollection: (id) => options.requests?.[id] ?? [],
		expandedCollectionIds: new Set(options.expanded ?? []),
		creatingSubfolder: options.creatingSubfolder ?? null,
	};
	return flattenVisibleRows(input);
}

/** A row as one comparable string: kind, entity id or owner, and depth. */
function describeRow(row: TreeRow): string {
	switch (row.kind) {
		case "folder":
			return `folder ${row.collection.id} @${row.depth}`;
		case "request":
			return `request ${row.request.id} @${row.depth}`;
		case "new-folder-form":
			return `form in ${row.parentId} @${row.depth}`;
		case "empty-placeholder":
			return `empty in ${row.parentId} @${row.depth}`;
	}
}

const shape = (rows: TreeRow[]) => rows.map(describeRow);

describe("flattenVisibleRows", () => {
	it("lists roots by tree order, then each expanded folder's sub-folders before its requests", () => {
		// Stored out of order on purpose, and the request's `order` is lower than
		// either folder's: the two blocks are ordered separately and folders win.
		const collections = [
			folder("beta", 1),
			folder("acme", 0),
			folder("billing", 2, "acme"),
			folder("auth", 1, "acme"),
		];
		const rows = flatten(collections, {
			expanded: ["acme"],
			requests: { acme: [request("r-ping", "acme", 0), request("r-pong", "acme", 1)] },
		});

		expect(shape(rows)).toEqual([
			"folder acme @0",
			"folder auth @1",
			"folder billing @1",
			"request r-ping @1",
			"request r-pong @1",
			"folder beta @0",
		]);
	});

	it("keeps the requests in the order the query layer gave them", () => {
		// `getRequestsByCollection` is already sorted by `compareTreeOrder`; a
		// second sort here would be a second opinion about the same order.
		const rows = flatten([folder("acme", 0)], {
			expanded: ["acme"],
			requests: { acme: [request("second", "acme", 5), request("first", "acme", 1)] },
		});

		expect(shape(rows).slice(1)).toEqual(["request second @1", "request first @1"]);
	});

	it("lists a collection whose parent is not loaded at the root, with its requests", () => {
		const collections = [
			folder("root", 0),
			folder("child", 0, "root"),
			folder("stray", 1, "deleted-parent"),
		];
		const rows = flatten(collections, {
			expanded: ["root", "stray"],
			requests: { stray: [request("r-stray", "stray", 0)] },
		});

		expect(shape(rows)).toEqual([
			"folder root @0",
			"folder child @1",
			"folder stray @0",
			"request r-stray @1",
		]);
		// Listed at the root, so its row's parent is the root's, not the
		// collection its own `parentId` names.
		expect(rows.find((row) => row.key === "folder:stray")?.parentId).toBeNull();
	});

	it("lists nothing under a collapsed folder, at any depth", () => {
		const collections = [
			folder("acme", 0),
			folder("billing", 0, "acme"),
			folder("deep", 0, "billing"),
		];
		const requests = {
			acme: [request("r1", "acme", 0)],
			billing: [request("r2", "billing", 0)],
		};

		expect(shape(flatten(collections, { requests }))).toEqual(["folder acme @0"]);
		// An expanded folder inside a collapsed one is still hidden.
		expect(shape(flatten(collections, { requests, expanded: ["billing"] }))).toEqual([
			"folder acme @0",
		]);
		expect(shape(flatten(collections, { requests, expanded: ["acme", "billing"] }))).toEqual([
			"folder acme @0",
			"folder billing @1",
			"folder deep @2",
			"request r2 @2",
			"request r1 @1",
		]);
	});

	it("puts the new-folder form first under the folder it creates in", () => {
		const collections = [folder("acme", 0), folder("billing", 0, "acme")];
		const requests = { acme: [request("r1", "acme", 0)] };

		expect(
			shape(flatten(collections, { requests, expanded: ["acme"], creatingSubfolder: "acme" }))
		).toEqual(["folder acme @0", "form in acme @1", "folder billing @1", "request r1 @1"]);
		// No form under a collapsed folder: the folder's children are not on screen.
		expect(shape(flatten(collections, { requests, creatingSubfolder: "acme" }))).toEqual([
			"folder acme @0",
		]);
	});

	it("follows an expanded, empty folder with its placeholder, and names it on the row", () => {
		const rows = flatten([folder("acme", 0), folder("empty", 1)], { expanded: ["empty"] });

		expect(shape(rows)).toEqual(["folder acme @0", "folder empty @0", "empty in empty @1"]);
		const [acme, empty, placeholder] = rows;
		expect(placeholder).toMatchObject({ kind: "empty-placeholder", id: "tree-empty-empty" });
		expect(empty).toMatchObject({ kind: "folder", emptyPlaceholderId: "tree-empty-empty" });
		// Collapsed and empty is not described: nothing follows it to point at.
		expect(acme).toMatchObject({ kind: "folder", emptyPlaceholderId: null });
	});

	it("shows the form instead of the placeholder while a folder is being created in an empty one", () => {
		const rows = flatten([folder("empty", 0)], {
			expanded: ["empty"],
			creatingSubfolder: "empty",
		});

		expect(shape(rows)).toEqual(["folder empty @0", "form in empty @1"]);
		expect(rows[0]).toMatchObject({ emptyPlaceholderId: null });
	});

	it("numbers folders and requests under one parent as one set", () => {
		const collections = [folder("acme", 0), folder("beta", 1), folder("billing", 0, "acme")];
		const rows = flatten(collections, {
			expanded: ["acme"],
			requests: { acme: [request("r1", "acme", 0), request("r2", "acme", 1)] },
		});

		const positions = rows.map((row) =>
			row.kind === "folder" || row.kind === "request" ? [row.posInSet, row.setSize] : null
		);
		expect(positions).toEqual([
			[1, 2], // acme
			[1, 3], // billing
			[2, 3], // r1 continues billing's numbering
			[3, 3], // r2
			[2, 2], // beta
		]);
	});

	it("gives every row a key that is unique and stable across a re-flatten", () => {
		const collections = [folder("same", 0), folder("other", 1, "same")];
		const requests = { same: [request("same", "same", 0)] };
		const options = { requests, expanded: ["same", "other"], creatingSubfolder: "same" };

		const keys = flatten(collections, options).map((row) => row.key);
		// A folder and a request sharing an id still get different keys.
		expect(new Set(keys).size).toBe(keys.length);
		expect(flatten(collections, options).map((row) => row.key)).toEqual(keys);
	});

	it("lists all 1,000 requests of a large folder, in one set", () => {
		const big = Array.from({ length: 1000 }, (_, order) => request(`r${order}`, "big", order));
		const rows = flatten([folder("big", 0)], { expanded: ["big"], requests: { big } });

		const requestRows = rows.filter((row) => row.kind === "request");
		expect(requestRows).toHaveLength(1000);
		expect(requestRows[0]).toMatchObject({
			posInSet: 1,
			setSize: 1000,
			depth: 1,
			parentId: "big",
		});
		expect(requestRows[999]).toMatchObject({ posInSet: 1000, setSize: 1000 });
	});

	it("enters a folder once when its id is listed twice", () => {
		// A duplicated id lists the folder under itself; the walk must still end.
		const collections = [folder("loop", 0), folder("loop", 0, "loop")];
		const rows = flatten(collections, { expanded: ["loop"] });

		expect(shape(rows)).toEqual(["folder loop @0", "folder loop @1"]);
	});
});

describe("rowSpacingAbove", () => {
	it("is nothing above the first row, a whole unit into a folder, half a unit otherwise", () => {
		const collections = [folder("acme", 0), folder("billing", 0, "acme"), folder("beta", 1)];
		const rows = flatten(collections, {
			expanded: ["acme", "billing"],
			requests: { billing: [request("r1", "billing", 0), request("r2", "billing", 1)] },
		});

		expect(
			rows.map((row, index) => `${describeRow(row)} ${rowSpacingAbove(rows, index)}`)
		).toEqual([
			"folder acme @0 0",
			"folder billing @1 1",
			"request r1 @2 1",
			"request r2 @2 0.5",
			// Stepping back out of two groups at once is still one row's gap: the
			// nested margins collapsed into one when the tree was nested.
			"folder beta @0 0.5",
		]);
	});

	it("opens a group above a form or a placeholder row too", () => {
		const rows = flatten([folder("empty", 0)], { expanded: ["empty"] });
		expect(rowSpacingAbove(rows, 1)).toBe(1);
	});
});

describe("rowKeysUnder", () => {
	it("is the rows in a folder's visible subtree, and not the folder's own", () => {
		const collections = [folder("acme", 0), folder("billing", 0, "acme"), folder("beta", 1)];
		const rows = flatten(collections, {
			expanded: ["acme", "billing", "beta"],
			requests: { acme: [request("r1", "acme", 0)] },
		});

		expect([...rowKeysUnder(rows, "acme")]).toEqual([
			"folder:billing",
			"empty:billing",
			"request:r1",
		]);
		expect([...rowKeysUnder(rows, "billing")]).toEqual(["empty:billing"]);
	});

	it("is empty for a folder that is collapsed or not on screen", () => {
		const rows = flatten([folder("acme", 0), folder("hidden", 0, "acme")]);
		expect(rowKeysUnder(rows, "acme").size).toBe(0);
		expect(rowKeysUnder(rows, "hidden").size).toBe(0);
	});
});
