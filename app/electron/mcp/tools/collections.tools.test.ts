/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test, vi } from "vitest";
import { dispatchTool, type ToolContext } from "../tools.js";
import { INPUT_REQUIRED } from "./kit.js";
import { EngineRequestError, type EngineClient } from "../engine-client.js";
import {
	fakeClient,
	ctxWith,
	firstText,
	ctxAsking,
	askedQuestion,
	callArgs,
} from "../tools.testkit.js";

/**
 * The delete gate (#378). `delete_collection` is the most destructive call in
 * the app - it cascades through every descendant collection and every request
 * inside them - so the write toggle alone is not its gate: it also asks, with
 * the real counts read from the engine, the way `start_load_run` asks before
 * generating traffic.
 */
describe("destructive deletes ask first", () => {
	/** A three-deep subtree under col_1, plus an unrelated collection beside it. */
	const TREE = [
		{ id: "col_1", name: "API", parentId: "" },
		{ id: "col_2", name: "v1", parentId: "col_1" },
		{ id: "col_3", name: "users", parentId: "col_2" },
		{ id: "col_other", name: "Elsewhere", parentId: "" },
	];

	/** 2 + 1 + 0 inside the subtree; the 5 outside it must never be counted. */
	const REQUESTS: Record<string, unknown[]> = {
		col_1: [{ id: "r1" }, { id: "r2" }],
		col_2: [{ id: "r3" }],
		col_3: [],
		col_other: [{ id: "r4" }, { id: "r5" }, { id: "r6" }, { id: "r7" }, { id: "r8" }],
	};

	function treeClient(overrides: Partial<Record<keyof EngineClient, unknown>> = {}) {
		return fakeClient({
			listCollections: vi.fn().mockResolvedValue(TREE),
			listRequests: vi
				.fn()
				.mockImplementation((id: string) => Promise.resolve(REQUESTS[id] ?? [])),
			...overrides,
		});
	}

	/** A context whose client answered the confirmation question with `outcome`. */
	function ctxAnswered(
		client: EngineClient,
		outcome: { action: string; content?: Record<string, unknown> }
	): ToolContext {
		return ctxAsking(client, { allowWrites: true }, { confirm: outcome });
	}

	test("delete_collection previews the real subtree counts and deletes nothing", async () => {
		const client = treeClient();
		const res = await dispatchTool(
			"delete_collection",
			{ collectionId: "col_1" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		expect(firstText(res)).toMatch(/awaiting confirmation/i);
		// Counted, not guessed: 2 descendants and the 3 requests inside the
		// subtree - never the 5 that live in the collection beside it.
		expect(firstText(res)).toContain("2 sub-collection(s)");
		expect(firstText(res)).toContain("3 saved request(s)");
		expect(firstText(res)).toContain("API");
		expect(client.deleteCollection).not.toHaveBeenCalled();
	});

	test("delete_collection deletes on the confirmed flag and reports what went", async () => {
		const client = treeClient();
		const res = await dispatchTool(
			"delete_collection",
			{ collectionId: "col_1", confirmed: true },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		expect(client.deleteCollection).toHaveBeenCalledWith("col_1", undefined);
		expect(res.content.map((c) => c.text).join("\n")).toContain("2 sub-collection(s)");
	});

	test("delete_collection asks the person, and deletes nothing while it asks", async () => {
		const client = treeClient();
		const res = await dispatchTool(
			"delete_collection",
			{ collectionId: "col_1" },
			ctxAsking(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		expect(client.deleteCollection).not.toHaveBeenCalled();
		// The person answering sees the counts, not just an id.
		const question = askedQuestion(res);
		expect(question).toContain("2 sub-collection(s)");
		expect(question).toContain("3 saved request(s)");
	});

	test("delete_collection takes the person's answer as the confirmation", async () => {
		const client = treeClient();
		const ctx = ctxAnswered(client, { action: "accept", content: { proceed: true } });
		// No `confirmed` flag - the human answered the question instead.
		const res = await dispatchTool("delete_collection", { collectionId: "col_1" }, ctx);
		expect(res.isError).toBeFalsy();
		expect(INPUT_REQUIRED.has(res)).toBe(false);
		expect(firstText(res)).not.toMatch(/awaiting confirmation/i);
		expect(client.deleteCollection).toHaveBeenCalledTimes(1);
	});

	test("a cancelled question deletes nothing", async () => {
		const client = treeClient();
		const res = await dispatchTool(
			"delete_collection",
			{ collectionId: "col_1" },
			ctxAnswered(client, { action: "cancel" })
		);
		expect(firstText(res)).toMatch(/declined/i);
		expect(INPUT_REQUIRED.has(res)).toBe(false);
		expect(client.deleteCollection).not.toHaveBeenCalled();
	});

	test("a declined prompt deletes nothing, even with the flag set", async () => {
		const client = treeClient();
		const ctx = ctxAnswered(client, { action: "accept", content: { proceed: false } });
		const res = await dispatchTool(
			"delete_collection",
			{ collectionId: "col_1", confirmed: true },
			ctx
		);
		expect(res.isError).toBeFalsy();
		expect(firstText(res)).toMatch(/declined/i);
		expect(client.deleteCollection).not.toHaveBeenCalled();
	});

	test("delete_collection refuses an id the engine does not have", async () => {
		const client = treeClient();
		const res = await dispatchTool(
			"delete_collection",
			{ collectionId: "col_missing", confirmed: true },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain("col_missing");
		expect(client.deleteCollection).not.toHaveBeenCalled();
	});

	test("delete_collection refuses when the subtree cannot be read", async () => {
		// A count nobody could verify must not become a prompt the user answers.
		const client = treeClient({
			listRequests: vi.fn().mockRejectedValue(new Error("fetch failed")),
		});
		const res = await dispatchTool(
			"delete_collection",
			{ collectionId: "col_1", confirmed: true },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(client.deleteCollection).not.toHaveBeenCalled();
	});

	test("delete_request names the request in its preview and deletes nothing", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"delete_request",
			{ requestId: "req_1" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		expect(firstText(res)).toMatch(/awaiting confirmation/i);
		expect(firstText(res)).toContain("Get users");
		expect(firstText(res)).toContain("https://api.example.com/users");
		expect(client.deleteRequest).not.toHaveBeenCalled();
	});

	test("delete_request deletes once confirmed", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"delete_request",
			{ requestId: "req_1", confirmed: true },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		expect(client.deleteRequest).toHaveBeenCalledWith("req_1", undefined);
	});

	test("delete_request answers a missing id as such, not as a transport failure", async () => {
		const client = fakeClient({
			getRequest: vi
				.fn()
				.mockRejectedValue(
					new EngineRequestError("Engine responded 404", 404, "Request not found")
				),
		});
		const res = await dispatchTool(
			"delete_request",
			{ requestId: "req_gone", confirmed: true },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain('No request with id "req_gone"');
		expect(client.deleteRequest).not.toHaveBeenCalled();
	});
});

describe("document CRUD parity", () => {
	describe("collection-level state", () => {
		test("create_collection stores variables, auth and both scripts as elements", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"create_collection",
				{
					name: "API",
					variables: {
						baseUrl: "https://api.example.com",
						token: { value: "t", secret: true },
					},
					auth: { mode: "apikey", key: "X-Key", value: "{{token}}" },
					preRequestScript: "pm.request.headers.add('x-run', '1')",
					postRequestScript: "pm.test('ok', () => {})",
				},
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			// Both scripts leave as `elements` (issue #1514); the engine refuses
			// the per-phase keys outright, and assigns each entry its own `el_` id.
			expect(callArgs(client.createCollection)[0]).toEqual({
				name: "API",
				auth: { mode: "apikey", key: "X-Key", value: "{{token}}" },
				elements: [
					{
						kind: "script.pre",
						enabled: true,
						config: { script: "pm.request.headers.add('x-run', '1')" },
					},
					{
						kind: "script.post",
						enabled: true,
						config: { script: "pm.test('ok', () => {})" },
					},
				],
				variables: {
					baseUrl: { enabled: true, value: "https://api.example.com" },
					token: { enabled: true, value: "t", secret: true },
				},
			});
		});

		test("create_collection refuses both `elements` and script sugar on the same call", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"create_collection",
				{
					name: "API",
					elements: [{ kind: "assert.status", config: { in: [200] } }],
					preRequestScript: "pm.request.headers.add('x-run', '1')",
				},
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/not both/);
			expect(client.createCollection).not.toHaveBeenCalled();
		});

		test("update_collection upserts a script into the stored elements list", async () => {
			const client = fakeClient({
				getCollection: vi.fn().mockResolvedValue({
					id: "col_1",
					name: "API",
					elements: [
						{
							id: "el_a",
							kind: "script.pre",
							enabled: true,
							config: { script: "chain();" },
						},
						{
							id: "el_b",
							kind: "script.post",
							enabled: true,
							config: { script: "old();" },
						},
					],
				}),
			});
			const res = await dispatchTool(
				"update_collection",
				{ collectionId: "col_1", postRequestScript: "fresh();" },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			// A collection's scripts run for every request below it, so dropping a
			// sibling element on a one-script edit would change what a whole tree
			// does. The stored list is read and merged, never overwritten.
			expect(client.getCollection).toHaveBeenCalledWith("col_1", undefined);
			expect(callArgs(client.updateCollection)[1]).toEqual({
				elements: [
					{
						id: "el_a",
						kind: "script.pre",
						enabled: true,
						config: { script: "chain();" },
					},
					{
						id: "el_b",
						kind: "script.post",
						enabled: true,
						config: { script: "fresh();" },
					},
				],
			});
		});

		test("update_collection merges variables against the stored blob", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"update_collection",
				{ collectionId: "col_1", variables: { token: "t" } },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			// The read is what makes it a merge: `PUT /collections/:id` replaces
			// the whole blob, so without it setting `token` would drop `baseUrl`.
			expect(client.getCollection).toHaveBeenCalledWith("col_1", undefined);
			expect(callArgs(client.updateCollection)[1]).toEqual({
				variables: {
					baseUrl: { value: "https://api.example.com", enabled: true },
					token: { enabled: true, value: "t" },
				},
			});
		});

		test("removeVariables deletes a name, and an absent one is reported", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"update_collection",
				{ collectionId: "col_1", removeVariables: ["baseUrl", "nope"] },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			expect(callArgs(client.updateCollection)[1]).toEqual({ variables: {} });
			// A name that was not there is a caveat beside the result, not an
			// error - the same disclosure update_environment makes.
			expect(res.content.map((c) => c.text).join("\n")).toContain("nope");
		});

		test("a plain rename needs no read, and an empty patch is refused", async () => {
			const client = fakeClient();
			const renamed = await dispatchTool(
				"update_collection",
				{ collectionId: "col_1", name: "Renamed" },
				ctxWith(client, { allowWrites: true })
			);
			expect(renamed.isError).toBeFalsy();
			// Only variables and scripts are read-merge-writes; a rename is not.
			expect(client.getCollection).not.toHaveBeenCalled();
			expect(callArgs(client.updateCollection)[1]).toEqual({ name: "Renamed" });

			const nothing = await dispatchTool(
				"update_collection",
				{ collectionId: "col_1" },
				ctxWith(client, { allowWrites: true })
			);
			expect(nothing.isError).toBe(true);
			expect(client.updateCollection).toHaveBeenCalledTimes(1);
		});

		test("an empty collection script clears its element, and still satisfies the patch check", async () => {
			const client = fakeClient({
				getCollection: vi.fn().mockResolvedValue({
					id: "col_1",
					name: "API",
					elements: [
						{
							id: "el_a",
							kind: "script.pre",
							enabled: true,
							config: { script: "chain();" },
						},
						{
							id: "el_b",
							kind: "script.post",
							enabled: true,
							config: { script: "keep();" },
						},
					],
				}),
			});
			const res = await dispatchTool(
				"update_collection",
				{ collectionId: "col_1", preRequestScript: "" },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			// An empty string is still a value - how a collection script is cleared -
			// but clearing is now a removal from `elements`, so it costs the read the
			// merge needs, and a script alone still passes the empty-patch refusal.
			expect(client.getCollection).toHaveBeenCalledWith("col_1", undefined);
			expect(callArgs(client.updateCollection)[1]).toEqual({
				elements: [
					{
						id: "el_b",
						kind: "script.post",
						enabled: true,
						config: { script: "keep();" },
					},
				],
			});
		});

		test("update_collection refuses both `elements` and script sugar on the same call", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"update_collection",
				{
					collectionId: "col_1",
					elements: [{ kind: "assert.status", config: { in: [200] } }],
					postRequestScript: "pm.test('ok', () => {})",
				},
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/not both/);
			expect(client.updateCollection).not.toHaveBeenCalled();
		});
	});
});
