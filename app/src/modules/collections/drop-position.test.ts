/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Zone math and the folders-first block rule (#367).
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
	it("lands in the target's own folder block, beside it", () => {
		expect(
			resolveDrop({ dragged: folder("a"), target: folder("b", "p"), zone: "after" })
		).toEqual({
			block: "collections",
			ownerId: "p",
			anchorId: "b",
			placement: "after",
		});
	});

	it("lands inside the folder when the pointer is in the middle band", () => {
		expect(
			resolveDrop({ dragged: folder("a"), target: folder("b", "p"), zone: "inside" })
		).toEqual({ block: "collections", ownerId: "b", anchorId: null, placement: "after" });
	});

	it("refuses a request row - requests are the other block", () => {
		for (const zone of ["before", "inside", "after"] as const) {
			expect(resolveDrop({ dragged: folder("a"), target: request("r1", "c1"), zone })).toBe(
				null
			);
		}
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
		).toEqual({ block: "requests", ownerId: "c2", anchorId: "r2", placement: "before" });
	});

	it("lands in a folder's requests when dropped on its middle", () => {
		expect(
			resolveDrop({ dragged: request("r1", "c1"), target: folder("c2"), zone: "inside" })
		).toEqual({ block: "requests", ownerId: "c2", anchorId: null, placement: "after" });
	});

	it("resolves 'between two folders' to the head of that parent's requests", () => {
		// The two-block rule: the order column cannot put a request between two
		// folders, so the nearest place it can actually sit is just below them.
		expect(
			resolveDrop({ dragged: request("r1", "c1"), target: folder("c2", "p"), zone: "after" })
		).toEqual({ block: "requests", ownerId: "p", anchorId: null, placement: "before" });
		expect(
			resolveDrop({ dragged: request("r1", "c1"), target: folder("c2", "p"), zone: "before" })
		).toEqual({ block: "requests", ownerId: "p", anchorId: null, placement: "before" });
	});

	it("refuses the edges of a root folder - the root holds no requests", () => {
		expect(
			resolveDrop({ dragged: request("r1", "c1"), target: folder("c2", null), zone: "after" })
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
