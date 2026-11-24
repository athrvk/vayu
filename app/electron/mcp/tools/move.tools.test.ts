/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test, vi } from "vitest";
import { dispatchTool } from "../tools.js";
import { fakeClient, ctxWith, firstText, callArgs } from "../tools.testkit.js";

describe("document CRUD parity", () => {
	describe("move_item", () => {
		/**
		 * Two collections at the root and three under `col_1`. A parent's
		 * sub-collections and requests share one `order` space (#2535), so the
		 * request lists below interleave with these folders' slots.
		 */
		const TREE = [
			{ id: "col_1", name: "API", parentId: "", order: 0, createdAt: 1_700_000_000_000 },
			{ id: "col_2", name: "Internal", parentId: "", order: 1, createdAt: 1_700_000_001_000 },
			{ id: "col_1a", name: "v1", parentId: "col_1", order: 0, createdAt: 1_700_000_002_000 },
			{ id: "col_1b", name: "v2", parentId: "col_1", order: 2, createdAt: 1_700_000_003_000 },
			{
				id: "col_2a",
				name: "Admin",
				parentId: "col_2",
				order: 0,
				createdAt: 1_700_000_004_000,
			},
			{
				id: "col_2b",
				name: "Ops",
				parentId: "col_2",
				order: 1,
				createdAt: 1_700_000_005_000,
			},
		];

		function moveClient(requests: Record<string, unknown[]> = {}) {
			return fakeClient({
				listCollections: vi.fn().mockResolvedValue(TREE),
				listRequests: vi
					.fn()
					.mockImplementation((id: string) => Promise.resolve(requests[id] ?? [])),
			});
		}

		const at = (id: string, order: number, createdAt = 1_700_000_100_000) => ({
			id,
			order,
			createdAt,
		});

		test("a request moved into a folder-only collection lands past its folders, not between them", async () => {
			// `col_2` holds folders at 0 and 1 and no requests. Counting requests
			// alone would answer slot 0, which sorts between the two folders.
			const client = moveClient();
			const res = await dispatchTool(
				"move_item",
				{ type: "request", itemId: "req_1", collectionId: "col_2" },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			expect(callArgs(client.reorder)[0]).toEqual({
				moves: [{ type: "request", id: "req_1", order: 2, collectionId: "col_2" }],
			});
		});

		test.each([
			["absent", { type: "request", collectionId: "col_2" }],
			["sent as the bare `id`", { type: "request", id: "req_1", collectionId: "col_2" }],
		])("move_item names `itemId` when the id is %s", async (_label, args) => {
			const client = moveClient();
			const res = await dispatchTool(
				"move_item",
				args,
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toBe('"itemId" is required.');
			expect(client.reorder).not.toHaveBeenCalled();
		});

		test("a request lands after the folders and requests of an interleaved parent", async () => {
			// `col_1`: v1 at 0, r_mid at 1, v2 at 2 - already dense, so only the
			// moved row is written.
			const client = moveClient({ col_1: [at("r_mid", 1)] });
			await dispatchTool(
				"move_item",
				{ type: "request", itemId: "req_1", collectionId: "col_1" },
				ctxWith(client, { allowWrites: true })
			);
			expect(callArgs(client.reorder)[0]).toEqual({
				moves: [{ type: "request", id: "req_1", order: 3, collectionId: "col_1" }],
			});
		});

		test("a folder moved into a parent lands after its last request", async () => {
			// `col_2` gains a request at 2, past both its folders; a folder moved in
			// last belongs at 3. Counting folders alone would answer 2, which ties
			// the request and sorts ahead of it on the kind rank.
			const client = moveClient({ col_2: [at("r_tail", 2)] });
			await dispatchTool(
				"move_item",
				{ type: "collection", itemId: "col_1a", parentId: "col_2" },
				ctxWith(client, { allowWrites: true })
			);
			expect(callArgs(client.reorder)[0]).toEqual({
				moves: [{ type: "collection", id: "col_1a", order: 3, parentId: "col_2" }],
			});
			expect(client.listRequests).toHaveBeenCalledWith("col_2", undefined);
		});

		test("position 'first' shifts the siblings of both kinds, each under its own type", async () => {
			const client = moveClient({ col_1: [at("r_mid", 1)] });
			await dispatchTool(
				"move_item",
				{ type: "request", itemId: "req_1", collectionId: "col_1", position: "first" },
				ctxWith(client, { allowWrites: true })
			);
			expect(callArgs(client.reorder)[0]).toEqual({
				moves: [
					{ type: "request", id: "req_1", order: 0, collectionId: "col_1" },
					{ type: "collection", id: "col_1a", order: 1 },
					{ type: "request", id: "r_mid", order: 2 },
					{ type: "collection", id: "col_1b", order: 3 },
				],
			});
		});

		test("position 'first' leaves a sibling alone when its slot is already right", async () => {
			const client = moveClient({ col_1: [at("r_mid", 2)] });
			await dispatchTool(
				"move_item",
				{ type: "collection", itemId: "col_2a", parentId: "col_1", position: "first" },
				ctxWith(client, { allowWrites: true })
			);
			// v1 0 -> 1. v2 already sits at 2, its slot after the insert, so it is
			// not written; r_mid ties it at 2, sorts after it on the kind rank, and
			// goes to 3.
			expect(callArgs(client.reorder)[0]).toEqual({
				moves: [
					{ type: "collection", id: "col_2a", order: 0, parentId: "col_1" },
					{ type: "collection", id: "col_1a", order: 1 },
					{ type: "request", id: "r_mid", order: 3 },
				],
			});
		});

		test("repositioning inside the same collection does not leave the row tied", async () => {
			// The bug this shape exists to prevent: state the whole arrangement,
			// and the moved row cannot land level with the sibling it displaced.
			const client = moveClient({ col_1: [at("req_1", 1), at("r2", 3)] });
			await dispatchTool(
				"move_item",
				{ type: "request", itemId: "req_1", collectionId: "col_1" },
				ctxWith(client, { allowWrites: true })
			);
			const batch = callArgs(client.reorder)[0] as { moves: Array<Record<string, unknown>> };
			// Left without it: v1 0, v2 2, r2 3 -> v2 to 1 and r2 to 2, req_1 last.
			expect(batch.moves).toEqual([
				{ type: "request", id: "req_1", order: 3, collectionId: "col_1" },
				{ type: "collection", id: "col_1b", order: 1 },
				{ type: "request", id: "r2", order: 2 },
			]);
			const orders = batch.moves.map((m) => m.order);
			expect(new Set(orders).size).toBe(orders.length);
		});

		test("rows tied across kinds get distinct positions, the folder first", async () => {
			// Admin and both requests at 0, as rows that predate explicit orders read.
			const client = moveClient({
				col_2: [at("r1", 0, 1_700_000_200_000), at("r2", 0, 1_700_000_100_000)],
			});
			await dispatchTool(
				"move_item",
				{ type: "request", itemId: "req_1", collectionId: "col_2" },
				ctxWith(client, { allowWrites: true })
			);
			// The tie at 0 ranks Admin first and the requests by createdAt (r2, r1),
			// which pushes Ops from 1 to 3.
			expect(callArgs(client.reorder)[0]).toEqual({
				moves: [
					{ type: "request", id: "req_1", order: 4, collectionId: "col_2" },
					{ type: "request", id: "r2", order: 1 },
					{ type: "request", id: "r1", order: 2 },
					{ type: "collection", id: "col_2b", order: 3 },
				],
			});
		});

		test("a collection moves to the top level, and among its new siblings", async () => {
			const client = moveClient();
			await dispatchTool(
				"move_item",
				{ type: "collection", itemId: "col_1a", parentId: null },
				ctxWith(client, { allowWrites: true })
			);
			expect(callArgs(client.reorder)[0]).toEqual({
				moves: [{ type: "collection", id: "col_1a", order: 2, parentId: null }],
			});
			// The top level holds collections only; there is no request list to read.
			expect(client.listRequests).not.toHaveBeenCalled();
		});

		test("a collection cannot move into itself or its own subtree", async () => {
			const client = moveClient();
			const ctx = ctxWith(client, { allowWrites: true });
			const intoSelf = await dispatchTool(
				"move_item",
				{ type: "collection", itemId: "col_1", parentId: "col_1" },
				ctx
			);
			expect(intoSelf.isError).toBe(true);
			expect(firstText(intoSelf)).toMatch(/itself/i);

			const intoChild = await dispatchTool(
				"move_item",
				{ type: "collection", itemId: "col_1", parentId: "col_1a" },
				ctx
			);
			expect(intoChild.isError).toBe(true);
			expect(firstText(intoChild)).toContain("col_1a");
			// The engine would refuse the same batch under its lock; refusing here
			// is about naming the problem, so nothing may reach it.
			expect(client.reorder).not.toHaveBeenCalled();
		});

		test("a collection move states its destination or is refused", async () => {
			const client = moveClient();
			const res = await dispatchTool(
				"move_item",
				{ type: "collection", itemId: "col_1a" },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toContain("parentId");
			expect(client.reorder).not.toHaveBeenCalled();
		});

		test("an unknown collection is named rather than sent", async () => {
			const client = moveClient();
			const res = await dispatchTool(
				"move_item",
				{ type: "collection", itemId: "col_gone", parentId: null },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toContain("col_gone");
			expect(client.reorder).not.toHaveBeenCalled();
		});
	});
});
