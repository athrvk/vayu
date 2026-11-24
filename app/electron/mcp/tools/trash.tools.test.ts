/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test, vi } from "vitest";
import { dispatchTool, TOOLS } from "../tools.js";
import { DEFAULT_LIST_PAGE_LIMIT, EngineRequestError } from "../engine-client.js";
import { page, lastPageAnswer, fakeClient, ctxWith, firstText } from "../tools.testkit.js";

/**
 * The Trash tools (issue #1071): list what `delete_collection` / `delete_request`
 * left recoverable, restore from it, or purge it for good. `restore_trash_entry`
 * is the one write here that is not destructive - it puts a row back rather than
 * removing one - so it carries the write toggle alone; `purge_trash_entry` is the
 * Trash's own hard delete and carries both gates the way `delete_collection` does.
 */
describe("trash tools", () => {
	const TRASH_ITEM = {
		id: "col_9",
		kind: "collection",
		name: "Retired API",
		deletedAt: 1_755_000_000_000,
		parentId: null,
		// The cohort a restore puts back: a floor. An earlier delete left more
		// under the collection, which only the purge totals count (#3449).
		collections: 2,
		requests: 5,
		purgeCollections: 3,
		purgeRequests: 8,
	};
	// The engine's environment entry (#2970): a root that takes nothing with it,
	// and the one kind that carries `variables`.
	const ENVIRONMENT_TRASH_ITEM = {
		id: "env_4",
		kind: "environment",
		name: "Staging",
		deletedAt: 1_755_000_000_000,
		parentId: null,
		collections: 0,
		requests: 0,
		purgeCollections: 0,
		purgeRequests: 0,
		variables: 6,
	};

	// A user-saved example (#2971): a root that takes nothing with it, whose
	// `parentId` is the owning request.
	const EXAMPLE_TRASH_ITEM = {
		id: "exa_5",
		kind: "example",
		name: "Happy path",
		deletedAt: 1_755_000_000_000,
		parentId: "req_2",
		parentName: "Create payment",
		collections: 0,
		requests: 0,
		purgeCollections: 0,
		purgeRequests: 0,
	};

	// A client certificate (#2973): a root named by its target, owning no parent.
	const CERTIFICATE_TRASH_ITEM = {
		id: "cert_3",
		kind: "clientCertificate",
		name: "api.example.com:8443",
		deletedAt: 1_755_000_000_000,
		parentId: null,
		collections: 0,
		requests: 0,
		purgeCollections: 0,
		purgeRequests: 0,
	};

	test("list_trash answers a client certificate row as the engine wrote it", async () => {
		const client = fakeClient({
			listTrashPage: vi.fn().mockResolvedValue(page([CERTIFICATE_TRASH_ITEM])),
		});
		const res = await dispatchTool("list_trash", {}, ctxWith(client));
		expect(res.isError).toBeFalsy();
		expect(JSON.parse(firstText(res))).toEqual(lastPageAnswer(page([CERTIFICATE_TRASH_ITEM])));
	});

	test("purge_trash_entry says a certificate's registry entry and passphrase go and its files stay", async () => {
		// Mutation check: take the `clientCertificate` case out of
		// `describeTrashEntry` (or the kind out of the known list) and the preview
		// stops naming it, or the purge is refused as an unknown kind.
		const client = fakeClient({
			listTrash: vi.fn().mockResolvedValue({ items: [CERTIFICATE_TRASH_ITEM], total: 1 }),
		});
		const res = await dispatchTool(
			"purge_trash_entry",
			{ entryId: "cert_3" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		expect(firstText(res)).toContain(
			'This would permanently destroy the client certificate registry entry for "api.example.com:8443" and its stored passphrase'
		);
		expect(firstText(res)).toContain("files on disk are not touched");
		expect(firstText(res)).not.toContain("collection");
		expect(client.purgeTrashEntry).not.toHaveBeenCalled();
	});

	test("purge_trash_entry purges a client certificate once confirmed", async () => {
		const client = fakeClient({
			listTrash: vi.fn().mockResolvedValue({ items: [CERTIFICATE_TRASH_ITEM], total: 1 }),
			purgeTrashEntry: vi.fn().mockResolvedValue({ ...CERTIFICATE_TRASH_ITEM, purged: true }),
		});
		const res = await dispatchTool(
			"purge_trash_entry",
			{ entryId: "cert_3", confirmed: true },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		expect(client.purgeTrashEntry).toHaveBeenCalledWith("cert_3", undefined);
	});

	test("restore_trash_entry puts a client certificate back and answers the engine's entry", async () => {
		const restored = { ...CERTIFICATE_TRASH_ITEM, restored: true, reparentedToRoot: false };
		const client = fakeClient({ restoreTrashEntry: vi.fn().mockResolvedValue(restored) });
		const res = await dispatchTool(
			"restore_trash_entry",
			{ entryId: "cert_3" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		expect(client.restoreTrashEntry).toHaveBeenCalledWith("cert_3", undefined);
		expect(JSON.parse(firstText(res))).toMatchObject({
			kind: "clientCertificate",
			name: "api.example.com:8443",
		});
		expect(res.content.map((c) => c.text).join("\n")).not.toMatch(/top level/i);
	});

	test("restore_trash_entry surfaces the engine's 409 when a live certificate holds the target", async () => {
		const message =
			"Client certificate 'cert_3' cannot be restored - 'api.example.com:8443' is already registered to client certificate 'cert_9', so delete that entry first";
		const client = fakeClient({
			restoreTrashEntry: vi
				.fn()
				.mockRejectedValue(
					new EngineRequestError(
						"Engine responded 409",
						409,
						JSON.stringify({ error: { code: "conflict", message } })
					)
				),
		});
		const res = await dispatchTool(
			"restore_trash_entry",
			{ entryId: "cert_3" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toBe(message);
	});

	test("the Trash tools describe client certificates as a kind they hold, and refresh the registry", () => {
		const trash = Object.fromEntries(
			TOOLS.filter((t) =>
				["list_trash", "restore_trash_entry", "purge_trash_entry"].includes(t.name)
			).map((t) => [t.name, t])
		);
		expect(String(trash.list_trash.description)).toContain("'clientCertificate'");
		expect(String(trash.restore_trash_entry.description)).toContain("client certificate");
		expect(String(trash.purge_trash_entry.description)).toContain("stored passphrase");
		expect(trash.restore_trash_entry.invalidates).toContain("clientCertificate");
		expect(trash.purge_trash_entry.invalidates).toContain("clientCertificate");
	});

	test("list_client_certificates says a removed entry is in the Trash, not listed", () => {
		const description = String(
			TOOLS.find((t) => t.name === "list_client_certificates")?.description
		);
		expect(description).toContain("Trash");
		expect(description).toContain("neither listed nor presented");
	});

	test("list_client_certificates names usable and problem, which only the list carries", () => {
		const description = String(
			TOOLS.find((t) => t.name === "list_client_certificates")?.description
		);
		expect(description).toContain("`usable`");
		expect(description).toContain("`problem`");
	});

	test("list_trash answers one page of entries, each as the engine wrote it", async () => {
		const client = fakeClient({ listTrashPage: vi.fn().mockResolvedValue(page([TRASH_ITEM])) });
		const res = await dispatchTool("list_trash", { q: "retired" }, ctxWith(client));
		expect(res.isError).toBeFalsy();
		expect(JSON.parse(firstText(res))).toEqual(lastPageAnswer(page([TRASH_ITEM])));
		expect(client.listTrashPage).toHaveBeenCalledWith(
			{ q: "retired", limit: DEFAULT_LIST_PAGE_LIMIT, offset: 0 },
			undefined
		);
		// The unpaged read stays the purge prompt's, not the list's.
		expect(client.listTrash).not.toHaveBeenCalled();
	});

	test("restore_trash_entry restores and reports a re-parented collection", async () => {
		const client = fakeClient({
			restoreTrashEntry: vi
				.fn()
				.mockResolvedValue({ ...TRASH_ITEM, restored: true, reparentedToRoot: true }),
		});
		const res = await dispatchTool(
			"restore_trash_entry",
			{ entryId: "col_9" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		expect(client.restoreTrashEntry).toHaveBeenCalledWith("col_9", undefined);
		// The caveat is what tells the caller its parent did not survive - without
		// it the result reads as an ordinary restore to where it was.
		expect(res.content.map((c) => c.text).join("\n")).toMatch(/top level/i);
	});

	test("restore_trash_entry surfaces the engine's own 409 message verbatim", async () => {
		// The engine's actual wording, in the shape `error_response` actually
		// sends it: nested `{"error": {"code", "message"}}` per routes.hpp, which
		// is the one shape issue #173 settled on. A flat `{"error": "..."}`
		// fixture here would have passed against a body the trash routes never
		// produce, and the agent would have been shown raw JSON.
		const message =
			"Request 'Charge' cannot be restored on its own - the collection it belongs to, 'Payments', is in the trash under 'Archive' (col_1), so restore that first";
		const client = fakeClient({
			restoreTrashEntry: vi
				.fn()
				.mockRejectedValue(
					new EngineRequestError(
						"Engine responded 409",
						409,
						JSON.stringify({ error: { code: "conflict", message } })
					)
				),
		});
		const res = await dispatchTool(
			"restore_trash_entry",
			{ entryId: "req_5" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		// Verbatim - not a paraphrase this tool invented and could disagree with.
		expect(firstText(res)).toBe(message);
	});

	test("restore_trash_entry refuses while writes are disabled, without calling the engine", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"restore_trash_entry",
			{ entryId: "col_9" },
			ctxWith(client)
		);
		expect(res.isError).toBe(true);
		expect(client.restoreTrashEntry).not.toHaveBeenCalled();
	});

	test("restore_trash_entry and purge_trash_entry name `entryId` when the id is missing, bare `id` or not", async () => {
		const client = fakeClient();
		const ctx = ctxWith(client, { allowWrites: true });
		for (const tool of ["restore_trash_entry", "purge_trash_entry"]) {
			for (const args of [{}, { id: "col_9", confirmed: true }]) {
				const res = await dispatchTool(tool, args, ctx);
				expect(res.isError, tool).toBe(true);
				expect(firstText(res), tool).toBe('"entryId" is required.');
			}
		}
		expect(client.restoreTrashEntry).not.toHaveBeenCalled();
		expect(client.purgeTrashEntry).not.toHaveBeenCalled();
	});

	test("purge_trash_entry previews the entry's name and what a purge destroys, and purges nothing", async () => {
		// The prompt counts everything the purge destroys (#3449), not the cohort
		// a restore puts back (2 and 5 in the fixture). Mutation check: read
		// `collections` / `requests` again in `readTrashEntry` and this fails.
		const client = fakeClient({
			listTrash: vi.fn().mockResolvedValue({ items: [TRASH_ITEM], total: 1 }),
		});
		const res = await dispatchTool(
			"purge_trash_entry",
			{ entryId: "col_9" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		expect(firstText(res)).toMatch(/awaiting confirmation/i);
		expect(firstText(res)).toContain("Retired API");
		expect(firstText(res)).toContain("3 sub-collection(s)");
		expect(firstText(res)).toContain("8 saved request(s)");
		expect(firstText(res)).not.toContain("5 saved request(s)");
		expect(client.purgeTrashEntry).not.toHaveBeenCalled();
	});

	test("purge_trash_entry names an environment and its variables, not a collection", async () => {
		// Mutation check: map every non-request kind to "collection" again in
		// `readTrashEntry` and this preview names a collection with no contents.
		const client = fakeClient({
			listTrash: vi.fn().mockResolvedValue({ items: [ENVIRONMENT_TRASH_ITEM], total: 1 }),
		});
		const res = await dispatchTool(
			"purge_trash_entry",
			{ entryId: "env_4" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		expect(firstText(res)).toContain(
			'This would permanently destroy the environment "Staging", with 6 variables in it.'
		);
		expect(firstText(res)).not.toContain("collection");
		expect(client.purgeTrashEntry).not.toHaveBeenCalled();
	});

	test("purge_trash_entry refuses a kind it does not know, rather than naming it as another", async () => {
		const client = fakeClient({
			listTrash: vi
				.fn()
				.mockResolvedValue({ items: [{ ...TRASH_ITEM, kind: "dataset" }], total: 1 }),
		});
		const res = await dispatchTool(
			"purge_trash_entry",
			{ entryId: "col_9", confirmed: true },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain('"dataset"');
		expect(client.purgeTrashEntry).not.toHaveBeenCalled();
	});

	test("purge_trash_entry names a saved example, not a collection", async () => {
		// Mutation check: take the `example` case out of `describeTrashEntry` (or
		// `"example"` out of the known kinds) and this preview stops naming it.
		const client = fakeClient({
			listTrash: vi.fn().mockResolvedValue({ items: [EXAMPLE_TRASH_ITEM], total: 1 }),
		});
		const res = await dispatchTool(
			"purge_trash_entry",
			{ entryId: "exa_5" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		expect(firstText(res)).toContain(
			'This would permanently destroy the saved example "Happy path" from the request "Create payment".'
		);
		expect(firstText(res)).not.toContain("collection");
		expect(client.purgeTrashEntry).not.toHaveBeenCalled();
	});

	test("purge_trash_entry names the collection a saved request came from, and nothing when the engine named none", async () => {
		// Mutation check: drop the `parentName` read in `readTrashEntry` and the
		// owner leaves the prompt.
		const request = {
			id: "req_7",
			kind: "request",
			name: "Charge",
			deletedAt: 1_755_000_000_000,
			parentId: "col_2",
			parentName: "Payments",
			collections: 0,
			requests: 0,
			purgeCollections: 0,
			purgeRequests: 0,
		};
		const { parentName: _omitted, ...unowned } = request;
		for (const [item, expected] of [
			[request, 'the saved request "Charge" from the collection "Payments".'],
			[unowned, 'the saved request "Charge".'],
		] as const) {
			const client = fakeClient({
				listTrash: vi.fn().mockResolvedValue({ items: [item], total: 1 }),
			});
			const res = await dispatchTool(
				"purge_trash_entry",
				{ entryId: "req_7" },
				ctxWith(client, { allowWrites: true })
			);
			expect(firstText(res)).toContain(expected);
		}
	});

	test("restore_trash_entry puts a saved example back and answers the engine's entry", async () => {
		const restored = { ...EXAMPLE_TRASH_ITEM, restored: true, reparentedToRoot: false };
		const client = fakeClient({ restoreTrashEntry: vi.fn().mockResolvedValue(restored) });
		const res = await dispatchTool(
			"restore_trash_entry",
			{ entryId: "exa_5" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		expect(client.restoreTrashEntry).toHaveBeenCalledWith("exa_5", undefined);
		expect(JSON.parse(firstText(res))).toMatchObject({ kind: "example", parentId: "req_2" });
		expect(res.content.map((c) => c.text).join("\n")).not.toMatch(/top level/i);
	});

	test("restore_trash_entry surfaces the engine's 409 for an example whose request is full", async () => {
		const message = "Request 'req_2' already holds the maximum of 100 examples";
		const client = fakeClient({
			restoreTrashEntry: vi
				.fn()
				.mockRejectedValue(
					new EngineRequestError(
						"Engine responded 409",
						409,
						JSON.stringify({ error: { code: "conflict", message } })
					)
				),
		});
		const res = await dispatchTool(
			"restore_trash_entry",
			{ entryId: "exa_5" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toBe(message);
	});

	test("the Trash tools describe saved examples as a kind they hold", () => {
		const descriptions = Object.fromEntries(
			TOOLS.filter((t) =>
				["list_trash", "restore_trash_entry", "purge_trash_entry"].includes(t.name)
			).map((t) => [t.name, String(t.description)])
		);
		expect(descriptions.list_trash).toContain("'example'");
		expect(descriptions.list_trash).toContain("delete_request_example");
		expect(descriptions.restore_trash_entry).toContain("saved example");
		expect(descriptions.purge_trash_entry).toContain("saved example");
	});

	test("restore_trash_entry puts an environment back and answers the engine's entry", async () => {
		const restored = { ...ENVIRONMENT_TRASH_ITEM, restored: true, reparentedToRoot: false };
		const client = fakeClient({ restoreTrashEntry: vi.fn().mockResolvedValue(restored) });
		const res = await dispatchTool(
			"restore_trash_entry",
			{ entryId: "env_4" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		expect(client.restoreTrashEntry).toHaveBeenCalledWith("env_4", undefined);
		expect(JSON.parse(firstText(res))).toMatchObject({ kind: "environment", variables: 6 });
		// No re-parent caveat: an environment has no parent to lose.
		expect(res.content.map((c) => c.text).join("\n")).not.toMatch(/top level/i);
	});

	test("purge_trash_entry purges once confirmed", async () => {
		const client = fakeClient({
			listTrash: vi.fn().mockResolvedValue({ items: [TRASH_ITEM], total: 1 }),
			purgeTrashEntry: vi.fn().mockResolvedValue({ ...TRASH_ITEM, purged: true }),
		});
		const res = await dispatchTool(
			"purge_trash_entry",
			{ entryId: "col_9", confirmed: true },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		expect(client.purgeTrashEntry).toHaveBeenCalledWith("col_9", undefined);
	});

	test("purge_trash_entry refuses an id the trash does not hold, without a prompt", async () => {
		const client = fakeClient({
			listTrash: vi.fn().mockResolvedValue({ items: [], total: 0 }),
		});
		const res = await dispatchTool(
			"purge_trash_entry",
			{ entryId: "col_missing", confirmed: true },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain("col_missing");
		expect(client.purgeTrashEntry).not.toHaveBeenCalled();
	});

	test("purge_trash_entry refuses while writes are disabled, without reading the trash", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"purge_trash_entry",
			{ entryId: "col_9", confirmed: true },
			ctxWith(client)
		);
		expect(res.isError).toBe(true);
		expect(client.listTrash).not.toHaveBeenCalled();
		expect(client.purgeTrashEntry).not.toHaveBeenCalled();
	});
});
