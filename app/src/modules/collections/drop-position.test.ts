/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Zone math and where a drop lands (#367), over one sibling list per parent
 * (#2535).
 *
 * Node environment: jsdom has no layout, so every row there measures 0px tall
 * and the boundaries this file pins would be untestable through a gesture.
 */

import { describe, it, expect } from "vitest";
import { FOLDER_EDGE_RATIO, resolveDrop, zoneAt, type TreeEntity } from "./drop-position";

const folder = (id: string, parentId: string | null = null): TreeEntity => ({
	kind: "collection",
	id,
	name: id,
	parentId,
});
const request = (id: string, collectionId: string): TreeEntity => ({
	kind: "request",
	id,
	name: id,
	collectionId,
});

const ROW = 32;

describe("zoneAt", () => {
	it("splits a folder row into quarters around an into-band", () => {
		expect(zoneAt(0, ROW, true)).toBe("before");
		expect(zoneAt(ROW * FOLDER_EDGE_RATIO - 0.1, ROW, true)).toBe("before");
		expect(zoneAt(ROW * FOLDER_EDGE_RATIO, ROW, true)).toBe("inside");
		expect(zoneAt(ROW / 2, ROW, true)).toBe("inside");
		expect(zoneAt(ROW * (1 - FOLDER_EDGE_RATIO), ROW, true)).toBe("inside");
		expect(zoneAt(ROW * (1 - FOLDER_EDGE_RATIO) + 0.1, ROW, true)).toBe("after");
		expect(zoneAt(ROW, ROW, true)).toBe("after");
	});

	it("splits a request row in half - a request has no inside", () => {
		expect(zoneAt(ROW / 2 - 0.1, ROW, false)).toBe("before");
		expect(zoneAt(ROW / 2, ROW, false)).toBe("after");
		expect(zoneAt(ROW / 2, ROW, false)).not.toBe("inside");
	});

	it("clamps a pointer that has left the row, and survives a zero height", () => {
		expect(zoneAt(-40, ROW, true)).toBe("before");
		expect(zoneAt(400, ROW, true)).toBe("after");
		expect(zoneAt(10, 0, true)).toBe("before");
	});
});

describe("resolving a folder drop", () => {
	it("lands beside the target folder, under the target's parent", () => {
		expect(
			resolveDrop({ dragged: folder("a"), target: folder("b", "p"), zone: "after" })
		).toEqual({ ownerId: "p", anchorId: "b", placement: "after" });
	});

	it("lands inside the folder when the pointer is in the middle band", () => {
		expect(
			resolveDrop({ dragged: folder("a"), target: folder("b", "p"), zone: "inside" })
		).toEqual({ ownerId: "b", anchorId: null, placement: "after" });
	});

	it("lands beside a request row - folders and requests share one list", () => {
		expect(
			resolveDrop({ dragged: folder("a"), target: request("r1", "c1"), zone: "before" })
		).toEqual({ ownerId: "c1", anchorId: "r1", placement: "before" });
		expect(
			resolveDrop({ dragged: folder("a"), target: request("r1", "c1"), zone: "after" })
		).toEqual({ ownerId: "c1", anchorId: "r1", placement: "after" });
	});

	it("lands beside a root folder, at the top level", () => {
		expect(
			resolveDrop({ dragged: folder("a", "p"), target: folder("b", null), zone: "before" })
		).toEqual({ ownerId: null, anchorId: "b", placement: "before" });
	});

	it("refuses itself", () => {
		expect(resolveDrop({ dragged: folder("a"), target: folder("a"), zone: "inside" })).toBe(
			null
		);
	});
});

describe("resolving a request drop", () => {
	it("lands beside a request, in that request's collection", () => {
		expect(
			resolveDrop({
				dragged: request("r1", "c1"),
				target: request("r2", "c2"),
				zone: "before",
			})
		).toEqual({ ownerId: "c2", anchorId: "r2", placement: "before" });
	});

	it("lands at the end of a folder when dropped on its middle", () => {
		expect(
			resolveDrop({ dragged: request("r1", "c1"), target: folder("c2"), zone: "inside" })
		).toEqual({ ownerId: "c2", anchorId: null, placement: "after" });
	});

	it("lands between two folders, beside the one the pointer is on", () => {
		expect(
			resolveDrop({ dragged: request("r1", "c1"), target: folder("c2", "p"), zone: "after" })
		).toEqual({ ownerId: "p", anchorId: "c2", placement: "after" });
		expect(
			resolveDrop({ dragged: request("r1", "c1"), target: folder("c2", "p"), zone: "before" })
		).toEqual({ ownerId: "p", anchorId: "c2", placement: "before" });
	});

	it("refuses the edges of a root folder - the top level holds no requests", () => {
		expect(
			resolveDrop({ dragged: request("r1", "c1"), target: folder("c2", null), zone: "after" })
		).toBe(null);
		expect(
			resolveDrop({
				dragged: request("r1", "c1"),
				target: folder("c2", null),
				zone: "before",
			})
		).toBe(null);
		// Its middle is still a folder to drop into.
		expect(
			resolveDrop({
				dragged: request("r1", "c1"),
				target: folder("c2", null),
				zone: "inside",
			})
		).not.toBe(null);
	});
});
