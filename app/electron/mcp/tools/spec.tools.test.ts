/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test, vi } from "vitest";
import { dispatchTool, MAX_INLINE_BODY_BYTES, MAX_SPEC_DIFF_ENTRIES, TOOLS } from "../tools.js";
import { EngineRequestError } from "../engine-client.js";
import { describeImport, describeImportPreview } from "./spec-bindings.js";
import { fakeClient, ctxWith, firstText } from "../tools.testkit.js";

/**
 * OpenAPI spec binding, phase A (issue #761).
 *
 * Two things are worth locking here, and neither is the passthrough.
 *
 * The first is that describing a binding must not transfer the document. That
 * is the whole reason `GET /specs/:id/meta` exists (#712) - a real spec is
 * megabytes, and one in a tool result exceeds the result token limit outright -
 * so the tests assert *which route was called*, not just what came back. A
 * version that read the full document and dropped `content` would answer
 * identically and cost the same megabytes.
 *
 * The third is that `export_spec` is a read that bounds what it hands back: an
 * exported document is as large as the stored one, so the text is capped like
 * every other body an agent sees (#767) and `contentBytes` says what the cap is
 * a prefix of.
 *
 * The second is that `unbind_spec` writes `openapi: null` and never `{}`. The
 * engine reads an absent field as "keep" and null as "reset to the default";
 * `{}` is a value that happens to serialize as unbound today, and the two would
 * drift the first time the default changed. The Spec tab's Unbind sends null for
 * the same reason.
 */
describe("OpenAPI spec binding tools", () => {
	const WRITES = { allowWrites: true };
	const allText = (r: { content: Array<{ text: string }> }) =>
		r.content.map((c) => c.text).join("\n");

	/** A collection row bound to `spec_1`, as the engine serializes one. */
	const boundCollection = {
		id: "col_1",
		name: "API",
		openapi: { specId: "spec_1", specHash: "abc123", syncedAt: 1_755_000_000_000 },
	};

	/** The unbound state as the engine stores it: an empty object, not absent. */
	const unboundCollection = { id: "col_1", name: "API", openapi: {} };

	test("get_spec resolves a collection's binding and reads metadata, not the document", async () => {
		const client = fakeClient({
			getCollection: vi.fn().mockResolvedValue(boundCollection),
		});
		const res = await dispatchTool("get_spec", { collectionId: "col_1" }, ctxWith(client));
		expect(res.isError).toBeFalsy();
		expect(client.getSpecMeta).toHaveBeenCalledWith("spec_1", undefined);
		// The document itself is never fetched for a metadata read - the point.
		expect(client.getSpec).not.toHaveBeenCalled();
		const value = JSON.parse(firstText(res));
		expect(value).toMatchObject({
			specId: "spec_1",
			bound: true,
			collectionId: "col_1",
			sourceUrl: "https://api.example.com/openapi.json",
			hash: "abc123",
			contentBytes: 4,
			binding: { specId: "spec_1", specHash: "abc123" },
		});
		expect(value).not.toHaveProperty("content");
	});

	test("get_spec reads a spec by id without touching collections", async () => {
		const client = fakeClient();
		const res = await dispatchTool("get_spec", { specId: "spec_9" }, ctxWith(client));
		expect(res.isError).toBeFalsy();
		expect(client.getCollection).not.toHaveBeenCalled();
		expect(client.getSpecMeta).toHaveBeenCalledWith("spec_9", undefined);
		// No collection was named, so there is no binding to report - the field is
		// absent rather than null, which would read as "bound to nothing".
		expect(JSON.parse(firstText(res))).not.toHaveProperty("binding");
	});

	test("an unbound collection is an answer, not an error, and reads no spec", async () => {
		const client = fakeClient({
			getCollection: vi.fn().mockResolvedValue(unboundCollection),
		});
		const res = await dispatchTool("get_spec", { collectionId: "col_1" }, ctxWith(client));
		expect(res.isError).toBeFalsy();
		expect(JSON.parse(firstText(res))).toEqual({ collectionId: "col_1", bound: false });
		expect(client.getSpecMeta).not.toHaveBeenCalled();
		expect(allText(res)).toMatch(/not bound/i);
	});

	test("get_spec refuses no selector and both selectors", async () => {
		const client = fakeClient();
		const neither = await dispatchTool("get_spec", {}, ctxWith(client));
		expect(neither.isError).toBe(true);
		const both = await dispatchTool(
			"get_spec",
			{ collectionId: "col_1", specId: "spec_1" },
			ctxWith(client)
		);
		expect(both.isError).toBe(true);
		expect(firstText(both)).toMatch(/not both/i);
		expect(client.getSpecMeta).not.toHaveBeenCalled();
	});

	test("get_spec names a collection id nothing matches", async () => {
		const client = fakeClient({ getCollection: vi.fn().mockResolvedValue(null) });
		const res = await dispatchTool("get_spec", { collectionId: "nope" }, ctxWith(client));
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain("nope");
		expect(client.getSpecMeta).not.toHaveBeenCalled();
	});

	test("includeContent reads the document and caps it, reporting the true size", async () => {
		const document = "x".repeat(MAX_INLINE_BODY_BYTES * 2);
		const client = fakeClient({
			getSpec: vi.fn().mockResolvedValue({
				id: "spec_1",
				content: document,
				sourceUrl: null,
				fetchedAt: 1,
				hash: "h",
			}),
		});
		const res = await dispatchTool(
			"get_spec",
			{ specId: "spec_1", includeContent: true },
			ctxWith(client)
		);
		expect(res.isError).toBeFalsy();
		expect(client.getSpec).toHaveBeenCalledWith("spec_1", undefined);
		expect(client.getSpecMeta).not.toHaveBeenCalled();
		const value = JSON.parse(firstText(res));
		expect(Buffer.byteLength(value.content as string, "utf8")).toBeLessThanOrEqual(
			MAX_INLINE_BODY_BYTES
		);
		expect(value.contentTruncated).toBe(true);
		// The full read carries no `contentBytes`, so the true size has to be
		// measured here - a cut that reported its own length would tell an agent
		// the spec is 32 KB.
		expect(value.contentBytes).toBe(document.length);
		expect(value.sourceUrl).toBeNull();
	});

	test("export_spec asks the engine for the document and passes its notes through", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"export_spec",
			{ collectionId: "col_1", format: "yaml" },
			ctxWith(client)
		);
		expect(res.isError).toBeFalsy();
		expect(client.exportSpec).toHaveBeenCalledWith("col_1", "yaml", "contract", undefined);
		// The assembly is the engine's, so nothing here reads the collection, its
		// requests or the document it is bound to - one call is the whole tool.
		expect(client.listRequests).not.toHaveBeenCalled();
		expect(client.getSpec).not.toHaveBeenCalled();
		const value = JSON.parse(firstText(res));
		expect(value).toMatchObject({
			collectionId: "col_1",
			format: "yaml",
			fileName: "api.openapi.json",
			documentTruncated: false,
		});
		expect(value.notes.direction).toBe("document");
		expect(value.document).toContain("openapi");
	});

	test("export_spec defaults to JSON and caps a document too large to hand back whole", async () => {
		const document = `{"openapi":"3.1.0","x":"${"a".repeat(MAX_INLINE_BODY_BYTES)}"}`;
		const client = fakeClient({
			exportSpec: vi
				.fn()
				.mockResolvedValue({ text: document, fileName: "api.openapi.json", notes: {} }),
		});
		const res = await dispatchTool("export_spec", { collectionId: "col_1" }, ctxWith(client));
		expect(client.exportSpec).toHaveBeenCalledWith("col_1", "json", "contract", undefined);
		const value = JSON.parse(firstText(res));
		expect(Buffer.byteLength(value.document, "utf8")).toBeLessThanOrEqual(
			MAX_INLINE_BODY_BYTES
		);
		expect(value.documentTruncated).toBe(true);
		// The cut says what it is a prefix of - a length read off the truncated
		// text would tell an agent the document is 32 KB.
		expect(value.contentBytes).toBe(document.length);
	});

	test("export_spec asks for a write-everything export when told to", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"export_spec",
			{ collectionId: "col_1", mode: "full" },
			ctxWith(client)
		);
		expect(res.isError).toBeFalsy();
		expect(client.exportSpec).toHaveBeenCalledWith("col_1", "json", "full", undefined);
		expect(JSON.parse(firstText(res)).mode).toBe("full");
	});

	test("export_spec passes the engine's refusal through rather than inventing one", async () => {
		// A binding whose document is not stored is a 409 with a sentence naming
		// it - the one answer a caller can act on, so it is not reworded here.
		const client = fakeClient({
			exportSpec: vi
				.fn()
				.mockRejectedValue(
					new EngineRequestError(
						"Engine responded 409",
						409,
						"Collection is bound to spec 'spec_1', which is not stored"
					)
				),
		});
		const res = await dispatchTool("export_spec", { collectionId: "col_1" }, ctxWith(client));
		expect(res.isError).toBe(true);
		expect(allText(res)).toContain("spec_1");
	});

	test("export_postman asks the engine for the document with secrets omitted", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"export_postman",
			// An argument the schema does not declare is not a way in: the
			// secrets stay out whatever the caller sends.
			{ collectionId: "col_1", includeSecrets: true },
			ctxWith(client)
		);
		expect(res.isError).toBeFalsy();
		expect(client.exportPostman).toHaveBeenCalledWith("col_1", undefined);
		expect(client.listRequests).not.toHaveBeenCalled();
		const value = JSON.parse(firstText(res));
		expect(value).toMatchObject({
			collectionId: "col_1",
			fileName: "API.postman_collection.json",
			documentTruncated: false,
		});
		expect(value.notes.secretsOmitted).toBe(1);
		expect(value.notes.notCarried).toEqual([
			{ code: "load-test", count: 1, message: "Load-test settings" },
		]);
		expect(value.document).toContain("info");
	});

	test("export_postman caps a document too large to hand back whole", async () => {
		const document = `{"info":{},"x":"${"a".repeat(MAX_INLINE_BODY_BYTES)}"}`;
		const client = fakeClient({
			exportPostman: vi.fn().mockResolvedValue({
				text: document,
				fileName: "API.postman_collection.json",
				notes: {},
			}),
		});
		const res = await dispatchTool(
			"export_postman",
			{ collectionId: "col_1" },
			ctxWith(client)
		);
		const value = JSON.parse(firstText(res));
		expect(Buffer.byteLength(value.document, "utf8")).toBeLessThanOrEqual(
			MAX_INLINE_BODY_BYTES
		);
		expect(value.documentTruncated).toBe(true);
		expect(value.contentBytes).toBe(document.length);
	});

	test("export_postman passes the engine's refusal through", async () => {
		const client = fakeClient({
			exportPostman: vi
				.fn()
				.mockRejectedValue(
					new EngineRequestError(
						"Engine responded 404",
						404,
						"Collection 'nope' not found"
					)
				),
		});
		const res = await dispatchTool("export_postman", { collectionId: "nope" }, ctxWith(client));
		expect(res.isError).toBe(true);
		expect(allText(res)).toContain("nope");
	});

	test("diff_spec sends the candidate document and nothing it could compare wrongly", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"diff_spec",
			{ collectionId: "col_1", content: '{"openapi":"3.1.0"}' },
			ctxWith(client)
		);
		expect(res.isError).toBeFalsy();
		// Neither the requests nor the bound document ride in the payload: the
		// engine walks the subtree and reads the binding itself, so a caller
		// cannot make a stale copy the "previous" side of a three-way compare.
		expect(client.diffSpec).toHaveBeenCalledWith(
			{ collectionId: "col_1", spec: { content: '{"openapi":"3.1.0"}' } },
			undefined
		);
		expect(client.listRequests).not.toHaveBeenCalled();
		expect(client.getSpec).not.toHaveBeenCalled();
		expect(client.getCollection).not.toHaveBeenCalled();

		const value = JSON.parse(firstText(res));
		expect(value.identical).toBe(false);
		expect(value.summary).toEqual({
			added: 1,
			declined: 1,
			removed: 1,
			changed: 1,
			unchanged: 12,
			unmapped: 1,
		});
		expect(value.added[0].operation.operationId).toBe("listOwners");
		// Its own bucket, shaped like `added` and without the draft: a deleted
		// request is not a missing one, and the agent must not read it as new.
		expect(value.declined).toEqual([
			{
				operation: { operationId: "getOwner", method: "GET", path: "/owners/{ownerId}" },
				folder: "owners",
			},
		]);
		expect(value.removed[0].requestId).toBe("req_9");
		expect(value.changed[0].fields[0]).toMatchObject({
			field: "name",
			current: "List pets",
			next: "List all the pets",
			userTouched: false,
		});
		expect(value.entriesTruncated).toBe(false);
		// Reads only, and the caveat says so rather than leaving an agent to
		// assume a diff applied something.
		expect(allText(res)).toContain("Nothing was written");
	});

	test("diff_spec drops the drafts the engine attaches to every entry", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"diff_spec",
			{ collectionId: "col_1", content: "{}" },
			ctxWith(client)
		);
		// `draft` is what an apply *would* write, and `POST /specs/sync` re-reads
		// it off the document being stored rather than being handed it - so no
		// reader on either side of this tool consumes it. Passing it through
		// would be the heaviest field in the answer and the "written but never
		// read" defect at once. The rendered current/next pair, which is what
		// says *what* moved, survives - asserted above.
		expect(firstText(res)).not.toContain("draft");
		expect(firstText(res)).not.toContain("{{baseUrl}}");
	});

	test("diff_spec names the fields a person edited, and stays quiet when none were", async () => {
		const edited = {
			identical: false,
			added: [],
			removed: [],
			changed: [
				{
					requestId: "req_1",
					name: "List pets",
					operation: { operationId: "listPets", method: "GET", path: "/pets" },
					matchedBy: "operationId",
					renamed: false,
					previousUnknown: false,
					fields: [{ field: "url", current: "{{host}}/pets", next: "{{baseUrl}}/pets" }],
				},
			],
			unchanged: 0,
			unmapped: 0,
		};
		const untouched = await dispatchTool(
			"diff_spec",
			{ collectionId: "col_1", content: "{}" },
			ctxWith(fakeClient({ diffSpec: vi.fn().mockResolvedValue(edited) }))
		);
		// The flag rides on every field either way; what must not appear is the
		// warning, which is about fields somebody actually edited.
		expect(allText(untouched)).not.toContain("overwrites a person's work");

		// The same drift with the flag set is the one an agent must not propose
		// applying silently, so it is named rather than left inside the JSON.
		const client = fakeClient({
			diffSpec: vi.fn().mockResolvedValue({
				...edited,
				changed: [
					{
						...edited.changed[0],
						fields: [{ ...edited.changed[0].fields[0], userTouched: true }],
					},
				],
			}),
		});
		const res = await dispatchTool(
			"diff_spec",
			{ collectionId: "col_1", content: "{}" },
			ctxWith(client)
		);
		expect(allText(res)).toContain("userTouched");
		expect(allText(res)).toContain("overwrites a person's work");
		expect(JSON.parse(firstText(res)).changed[0].fields[0].userTouched).toBe(true);
	});

	test("diff_spec says what a declined operation is, and only when there is one", async () => {
		const withDeclined = await dispatchTool(
			"diff_spec",
			{ collectionId: "col_1", content: "{}" },
			ctxWith(fakeClient())
		);
		const text = allText(withDeclined);
		expect(text).toMatch(/1 operation the user deleted the request for/);
		expect(text).toMatch(/never creates one/);
		// The sentence offers nobody a way to bring one back: that is the user's.
		expect(text).toMatch(/the user's call/);
		expect(text).not.toMatch(/pass .*declined|tick .*declined/i);

		const none = await dispatchTool(
			"diff_spec",
			{ collectionId: "col_1", content: "{}" },
			ctxWith(
				fakeClient({
					diffSpec: vi.fn().mockResolvedValue({
						identical: false,
						added: [],
						removed: [],
						changed: [],
						unchanged: 3,
						unmapped: 0,
					}),
				})
			)
		);
		expect(allText(none)).not.toMatch(/the user deleted the request for/);
		// The bucket is present and empty even from an engine that omits it.
		expect(JSON.parse(firstText(none)).declined).toEqual([]);
		expect(JSON.parse(firstText(none)).summary.declined).toBe(0);
	});

	test("diff_spec caps the declined bucket and reports the true total", async () => {
		const over = MAX_SPEC_DIFF_ENTRIES + 3;
		const client = fakeClient({
			diffSpec: vi.fn().mockResolvedValue({
				identical: false,
				added: [],
				declined: Array.from({ length: over }, (_unused, index) => ({
					operation: { operationId: `op_${index}`, method: "GET", path: `/p${index}` },
					folder: "",
				})),
				removed: [],
				changed: [],
				unchanged: 0,
				unmapped: 0,
			}),
		});
		const res = await dispatchTool(
			"diff_spec",
			{ collectionId: "col_1", content: "{}" },
			ctxWith(client)
		);
		const value = JSON.parse(firstText(res));
		expect(value.declined).toHaveLength(MAX_SPEC_DIFF_ENTRIES);
		expect(value.summary.declined).toBe(over);
		// A cut declined list is a cut list: the flag and the caveat say so.
		expect(value.entriesTruncated).toBe(true);
	});

	test("diff_spec says a byte-identical document has nothing to apply", async () => {
		const client = fakeClient({
			diffSpec: vi.fn().mockResolvedValue({
				identical: true,
				added: [],
				removed: [],
				changed: [],
				unchanged: 14,
				unmapped: 0,
			}),
		});
		const res = await dispatchTool(
			"diff_spec",
			{ collectionId: "col_1", content: "{}" },
			ctxWith(client)
		);
		const value = JSON.parse(firstText(res));
		expect(value.identical).toBe(true);
		expect(value.summary).toEqual({
			added: 0,
			declined: 0,
			removed: 0,
			changed: 0,
			unchanged: 14,
			unmapped: 0,
		});
		expect(allText(res)).toContain("byte-identical");
	});

	test("diff_spec caps each bucket and keeps the counts true", async () => {
		const over = MAX_SPEC_DIFF_ENTRIES + 7;
		const client = fakeClient({
			diffSpec: vi.fn().mockResolvedValue({
				identical: false,
				added: Array.from({ length: over }, (_unused, index) => ({
					operation: { operationId: `op_${index}`, method: "GET", path: `/p${index}` },
					folder: "",
				})),
				removed: [],
				changed: [],
				unchanged: 0,
				unmapped: 0,
			}),
		});
		const res = await dispatchTool(
			"diff_spec",
			{ collectionId: "col_1", content: "{}" },
			ctxWith(client)
		);
		const value = JSON.parse(firstText(res));
		expect(value.added).toHaveLength(MAX_SPEC_DIFF_ENTRIES);
		// The count an agent reads to decide whether a contract drifted is the
		// engine's, never the cut list's length - a total read off the list
		// would report 50 additions for a document that made 57.
		expect(value.summary.added).toBe(over);
		expect(value.entriesTruncated).toBe(true);
		expect(allText(res)).toContain(`capped at ${MAX_SPEC_DIFF_ENTRIES}`);
	});

	test("diff_spec passes the engine's refusal through rather than inventing one", async () => {
		// A collection that binds nothing has no middle term for the three-way
		// comparison, and the engine's sentence already says what to do about it.
		const client = fakeClient({
			diffSpec: vi
				.fn()
				.mockRejectedValue(
					new EngineRequestError(
						"Engine responded 400",
						400,
						"Collection 'col_1' is not bound to a spec; bind it before asking what a document would change"
					)
				),
		});
		const res = await dispatchTool(
			"diff_spec",
			{ collectionId: "col_1", content: "{}" },
			ctxWith(client)
		);
		expect(res.isError).toBe(true);
		expect(allText(res)).toContain("not bound to a spec");
	});

	/**
	 * Importing a document over MCP (issue #877).
	 *
	 * The verb the spec tools were missing: an agent could bind, describe, diff,
	 * sync, export and unbind, and could not *import*, because the apply took a
	 * tree only the renderer could build. What this file holds down is the tool's
	 * half - the guard, the options travelling verbatim, and the losses being said
	 * out loud - since what a document parses to is the engine's and pinned there.
	 */
	describe("import_document", () => {
		test("is refused while writes are off, and sends nothing", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"import_document",
				{ content: "{}" },
				ctxWith(client, { allowWrites: false })
			);
			expect(res.isError).toBe(true);
			expect(client.importDocument).not.toHaveBeenCalled();
		});

		test("sends the document and the options the caller stated, and nothing else", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"import_document",
				{
					content: '{"info":{}}',
					importScripts: false,
					sourceUrl: "https://acme.dev/api.json",
				},
				ctxWith(client, WRITES)
			);
			expect(res.isError).toBeFalsy();
			const [payload] = (client.importDocument as ReturnType<typeof vi.fn>).mock.calls[0];
			// An option the caller did not state is absent rather than defaulted here:
			// the engine's default is the one the import dialog offers, and restating
			// it would be a second place for it to drift.
			expect(payload).toEqual({
				content: '{"info":{}}',
				importScripts: false,
				sourceUrl: "https://acme.dev/api.json",
			});
		});

		test("says what was created and what the document lost", async () => {
			const res = await dispatchTool(
				"import_document",
				{ content: "{}" },
				ctxWith(fakeClient(), WRITES)
			);
			expect(res.isError).toBeFalsy();
			expect(allText(res)).toContain("Postman Collection v2.1");
			expect(allText(res)).toContain("2 request(s)");
			// The half a caller cannot see from the counts: an import that dropped a
			// WebSocket request looks exactly like one that had none.
			expect(allText(res)).toMatch(/Not everything imported: 1 websocket/);
		});

		test("names the sub-collections the requests went into and the one-call way to run them", async () => {
			const res = await dispatchTool(
				"import_document",
				{ content: "{}" },
				ctxWith(
					fakeClient({
						importDocument: vi.fn().mockResolvedValue({
							meta: {
								format: "OpenAPI 3.1.0",
								requestCount: 9,
								folderCount: 3,
								skipped: [],
							},
							collections: 4,
							requests: 9,
							environments: 0,
							globals: 0,
						}),
					}),
					WRITES
				)
			);
			expect(allText(res)).toContain("filed under 3 sub-collection(s)");
			expect(allText(res)).toContain(
				"recursive: true to run_collection or run_collection_smoke"
			);
		});

		test("a preview names the one-call way to run the folders it would create", () => {
			const meta = { format: "OpenAPI 3.1.0", requestCount: 9, skipped: [] };
			expect(describeImportPreview({ meta: { ...meta, folderCount: 3 } })).toContain(
				"recursive: true to run_collection or run_collection_smoke"
			);
			expect(describeImportPreview({ meta: { ...meta, folderCount: 0 } })).not.toContain(
				"recursive"
			);
		});

		test("tells the caller how to define {{baseUrl}} when the document named no server (#2450)", () => {
			const base = { format: "OpenAPI 3.1.0", requestCount: 2, folderCount: 0 };
			const noServer = { ...base, skipped: [{ kind: "no_server_url", count: 1 }] };
			const other = { ...base, skipped: [{ kind: "websocket", count: 1 }] };
			expect(noServer.skipped.map((s) => s.kind)).toContain("no_server_url");
			const remedy = "{{baseUrl}} is undefined";
			const imported = { collections: 1, requests: 2, environments: 0, globals: 0 };

			const preview = describeImportPreview({ meta: noServer });
			expect(preview).toContain(remedy);
			expect(preview).toContain("update_collection");
			expect(preview).toContain("update_environment");
			expect(describeImportPreview({ meta: other })).not.toContain(remedy);
			expect(describeImportPreview({ meta: { ...base, skipped: [] } })).not.toContain(remedy);

			const done = describeImport({ ...imported, meta: noServer });
			expect(done).toContain(remedy);
			expect(done).toContain("update_collection");
			expect(done).toContain("update_environment");
			expect(describeImport({ ...imported, meta: other })).not.toContain(remedy);
			expect(describeImport({ ...imported, meta: { ...base, skipped: [] } })).not.toContain(
				remedy
			);
		});

		test("adds nothing about sub-collections when the document made none", async () => {
			const res = await dispatchTool(
				"import_document",
				{ content: "{}" },
				ctxWith(
					fakeClient({
						importDocument: vi.fn().mockResolvedValue({
							meta: {
								format: "OpenAPI 3.1.0",
								requestCount: 2,
								folderCount: 0,
								skipped: [],
							},
							collections: 1,
							requests: 2,
							environments: 0,
							globals: 0,
						}),
					}),
					WRITES
				)
			);
			expect(allText(res)).toContain(
				"Imported OpenAPI 3.1.0: 1 collection(s), 2 request(s)."
			);
			expect(allText(res)).not.toContain("sub-collection");
			expect(allText(res)).not.toContain("recursive");
		});

		test("passes the engine's refusal through rather than inventing one", async () => {
			const client = fakeClient({
				importDocument: vi
					.fn()
					.mockRejectedValue(
						new EngineRequestError("Engine responded 400", 400, "Unrecognised format")
					),
			});
			const res = await dispatchTool(
				"import_document",
				{ content: '{"x":1}' },
				ctxWith(client, WRITES)
			);
			expect(res.isError).toBe(true);
			expect(allText(res)).toContain("Unrecognised format");
		});
	});

	test("unbind_spec is refused while writes are off, and reads nothing", async () => {
		const client = fakeClient({
			getCollection: vi.fn().mockResolvedValue(boundCollection),
		});
		const res = await dispatchTool(
			"unbind_spec",
			{ collectionId: "col_1" },
			ctxWith(client, { allowWrites: false })
		);
		expect(res.isError).toBe(true);
		expect(client.updateCollection).not.toHaveBeenCalled();
		expect(client.getCollection).not.toHaveBeenCalled();
	});

	test("unbind_spec sends openapi: null and names the document it detached", async () => {
		const client = fakeClient({
			getCollection: vi.fn().mockResolvedValue(boundCollection),
		});
		const res = await dispatchTool(
			"unbind_spec",
			{ collectionId: "col_1" },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBeFalsy();
		const [id, payload] = (client.updateCollection as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(id).toBe("col_1");
		// Null, not `{}` - see this block's header.
		expect(payload).toEqual({ openapi: null });
		expect(Object.prototype.hasOwnProperty.call(payload, "openapi")).toBe(true);
		expect((payload as { openapi: unknown }).openapi).toBeNull();
		expect(allText(res)).toContain("spec_1");
	});

	test("unbind_spec writes nothing for a collection that binds nothing", async () => {
		const client = fakeClient({
			getCollection: vi.fn().mockResolvedValue(unboundCollection),
		});
		const res = await dispatchTool(
			"unbind_spec",
			{ collectionId: "col_1" },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBeFalsy();
		expect(client.updateCollection).not.toHaveBeenCalled();
		expect(allText(res)).toMatch(/Nothing to do/i);
	});

	test("unbind_spec names a collection id nothing matches", async () => {
		const client = fakeClient({ getCollection: vi.fn().mockResolvedValue(null) });
		const res = await dispatchTool(
			"unbind_spec",
			{ collectionId: "nope" },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBe(true);
		expect(client.updateCollection).not.toHaveBeenCalled();
	});

	test("the categories and cache families are declared", () => {
		const tools = new Map(TOOLS.map((t) => [t.name, t]));
		expect(tools.get("get_spec")?.category).toBe("read");
		expect(tools.get("get_spec")?.invalidates).toEqual([]);
		// An export writes nothing and needs no write toggle: it is a read of what
		// the collection already is.
		expect(tools.get("export_spec")?.category).toBe("read");
		expect(tools.get("export_spec")?.invalidates).toEqual([]);
		expect(tools.get("export_spec")?.annotations.readOnlyHint).toBe(true);
		expect(tools.get("export_postman")?.category).toBe("read");
		expect(tools.get("export_postman")?.invalidates).toEqual([]);
		expect(tools.get("export_postman")?.annotations.readOnlyHint).toBe(true);
		expect(tools.get("unbind_spec")?.category).toBe("write");
		// The Spec tab reads the binding off the collection row, so the family that
		// refetches that row is the one that refreshes it - no `spec` entity, and
		// no request list, since the stamps stay where they are.
		expect(tools.get("unbind_spec")?.invalidates).toEqual(["collectionRow"]);
		// Nothing it names is destroyed: the document stays and so do the stamps.
		expect(tools.get("unbind_spec")?.annotations.destructiveHint).toBe(false);
	});

	/*
	 * Binding (#862). Phase A deliberately shipped no bind tool, because a bind
	 * without operation matching stores a document with no index and leaves
	 * stale stamps uncleared - which makes coverage claim the wrong operation
	 * rather than none. Both halves moved engine-side (#853, #860), so the tool
	 * exists now and is one call to `POST /specs/bind`.
	 *
	 * What these cases hold is the two things the tool layer can get wrong: it
	 * must send the document and nothing it decided itself, and it must tell the
	 * agent about the identities the bind *removed* - the half a caller would
	 * otherwise learn about from a later run reporting no coverage.
	 */
	test("bind_spec is refused while writes are off, and writes nothing", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"bind_spec",
			{ collectionId: "col_1", content: "openapi: 3.0.0" },
			ctxWith(client, { allowWrites: false })
		);
		expect(res.isError).toBe(true);
		expect(client.bindSpec).not.toHaveBeenCalled();
	});

	test("bind_spec sends the document and no pairing of its own", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"bind_spec",
			{
				collectionId: "col_1",
				content: "openapi: 3.0.0",
				sourceUrl: "https://api.example.com/openapi.yaml",
			},
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBeFalsy();
		const [payload] = (client.bindSpec as ReturnType<typeof vi.fn>).mock.calls[0];
		// Exhaustive on purpose: an agent has no OpenAPI reader, and a `stamps`
		// or `clear` list appearing here would mean one had been written.
		expect(payload).toEqual({
			collectionId: "col_1",
			spec: {
				content: "openapi: 3.0.0",
				sourceUrl: "https://api.example.com/openapi.yaml",
			},
		});
		expect(allText(res)).toContain("spec_2");
	});

	test("bind_spec omits sourceUrl for a document handed over as text", async () => {
		const client = fakeClient();
		await dispatchTool(
			"bind_spec",
			{ collectionId: "col_1", content: "openapi: 3.0.0" },
			ctxWith(client, WRITES)
		);
		const [payload] = (client.bindSpec as ReturnType<typeof vi.fn>).mock.calls[0];
		// Absent, not null: the engine reads absent as "it did not come from a
		// URL", and a null would be a second spelling of the same thing.
		expect(Object.keys((payload as { spec: object }).spec)).toEqual(["content"]);
	});

	test("bind_spec says how many identities it removed, not only how many it wrote", async () => {
		const client = fakeClient({
			bindSpec: vi.fn().mockResolvedValue({
				specId: "spec_2",
				specHash: "def456",
				syncedAt: 1_755_000_100_000,
				stamped: 1,
				cleared: 2,
				unmatchedRequests: ["req_8", "req_9"],
				unmatchedOperations: [
					{ operationId: "getPet", method: "GET", path: "/pets/{petId}" },
				],
			}),
		});
		const res = await dispatchTool(
			"bind_spec",
			{ collectionId: "col_1", content: "openapi: 3.0.0" },
			ctxWith(client, WRITES)
		);
		const text = allText(res);
		// The count a re-bind takes away is the one an agent acts on: it means
		// requests that were part of a contract are no longer part of this one.
		expect(text).toMatch(/Cleared identity from 2 requests/i);
		expect(text).toMatch(/Recorded identity on 1 request\./i);
		expect(text).toMatch(/2 requests matched no operation/i);
		expect(text).toMatch(/1 operation matched no request/i);
	});

	test("bind_spec reports an engine refusal rather than claiming a bind", async () => {
		const client = fakeClient({
			bindSpec: vi.fn().mockRejectedValue(new Error("Collection not found")),
		});
		const res = await dispatchTool(
			"bind_spec",
			{ collectionId: "nope", content: "openapi: 3.0.0" },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBe(true);
		expect(allText(res)).not.toMatch(/Bound to spec/i);
	});

	test("sync_spec is refused when writes are disabled", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"sync_spec",
			{ collectionId: "col_1", content: "openapi: 3.0.0" },
			ctxWith(client, { allowWrites: false })
		);
		expect(res.isError).toBe(true);
		expect(client.syncSpec).not.toHaveBeenCalled();
	});

	test("sync_spec asks for the safe policy and states no rows of its own", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"sync_spec",
			{ collectionId: "col_1", content: '{"openapi":"3.1.0"}' },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBeFalsy();
		/*
		 * The whole design of the tool, in one assertion (issue #871). Which of a
		 * drift is safe to write is `core::safe_spec_apply`, and a payload naming
		 * rows here would be a second opinion about which of a person's fields a
		 * sync may overwrite. Adding a `create` / `update` / `delete` section -
		 * or dropping the policy - reddens this.
		 */
		expect(client.syncSpec).toHaveBeenCalledWith(
			{
				collectionId: "col_1",
				spec: { content: '{"openapi":"3.1.0"}' },
				policy: "safe",
			},
			undefined
		);
		const [payload] = (client.syncSpec as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(Object.keys(payload as object).sort()).toEqual(["collectionId", "policy", "spec"]);
		// Nothing is worked out here either - no reading of the collection, no
		// diff of its own to decide from.
		expect(client.diffSpec).not.toHaveBeenCalled();
		expect(client.listRequests).not.toHaveBeenCalled();
	});

	test("sync_spec says what the policy declined, not only what it wrote", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"sync_spec",
			{ collectionId: "col_1", content: "openapi: 3.0.0" },
			ctxWith(client, WRITES)
		);
		const text = allText(res);
		expect(text).toMatch(/1 request created, 2 requests updated, 0 requests deleted/i);
		/*
		 * The half an agent would otherwise assume did not exist. A caller that
		 * ticked nothing cannot see what it did not tick, so "2 updated" alone
		 * reads as "applied the drift" - and the two things left are a person's
		 * edit and a request the document dropped, which are exactly the two an
		 * agent must not conclude it has handled. Dropping the `skipped` sentence
		 * reddens this.
		 */
		expect(text).toMatch(/declined the rest/i);
		expect(text).toMatch(/1 changed request left untouched/i);
		expect(text).toMatch(/3 fields not written/i);
		expect(text).toMatch(/NOT deleted/);
		// A request the user deleted is not an omission to fix, and the agent is
		// told so rather than left to conclude the sync lost it. Dropping the
		// `skipped.declined` branch of `describeSync` reddens this.
		expect(text).toMatch(
			/2 operations whose request the user deleted and which was NOT created again/
		);
		// And the counts are in the structured body too, not only in the prose.
		expect(JSON.parse(firstText(res)).skipped).toEqual({
			requests: 1,
			fields: 3,
			deletions: 1,
			declined: 2,
		});
	});

	test("sync_spec stays quiet about a policy that declined nothing", async () => {
		const client = fakeClient({
			syncSpec: vi.fn().mockResolvedValue({
				idMap: {},
				specId: "spec_3",
				specHash: "aaa",
				syncedAt: 1,
				created: 0,
				updated: 1,
				deleted: 0,
				skipped: { requests: 0, fields: 0, deletions: 0, declined: 0 },
			}),
		});
		const res = await dispatchTool(
			"sync_spec",
			{ collectionId: "col_1", content: "openapi: 3.0.0" },
			ctxWith(client, WRITES)
		);
		// A caveat that always warns is one nobody reads by the third call.
		expect(allText(res)).not.toMatch(/declined the rest/i);
	});

	test("sync_spec reports an engine refusal rather than claiming an apply", async () => {
		const client = fakeClient({
			syncSpec: vi
				.fn()
				.mockRejectedValue(
					new Error("Collection 'col_1' is not bound to a spec; bind it before syncing")
				),
		});
		const res = await dispatchTool(
			"sync_spec",
			{ collectionId: "col_1", content: "openapi: 3.0.0" },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBe(true);
		// The engine's own sentence, which names the fix.
		expect(allText(res)).toMatch(/not bound to a spec/i);
		expect(allText(res)).not.toMatch(/Applied in one transaction/i);
	});

	test("sync_spec sends a sourceUrl only when it was given one", async () => {
		const client = fakeClient();
		await dispatchTool(
			"sync_spec",
			{ collectionId: "col_1", content: "openapi: 3.0.0" },
			ctxWith(client, WRITES)
		);
		const [bare] = (client.syncSpec as ReturnType<typeof vi.fn>).mock.calls[0];
		// Absent, not null: the engine reads absent as "it did not come from a
		// URL", the same reading `bind_spec` relies on.
		expect(Object.keys((bare as { spec: object }).spec)).toEqual(["content"]);

		const withUrl = fakeClient();
		await dispatchTool(
			"sync_spec",
			{
				collectionId: "col_1",
				content: "openapi: 3.0.0",
				sourceUrl: "https://api.example.com/openapi.json",
			},
			ctxWith(withUrl, WRITES)
		);
		const [stated] = (withUrl.syncSpec as ReturnType<typeof vi.fn>).mock.calls[0];
		expect((stated as { spec: { sourceUrl?: string } }).spec.sourceUrl).toBe(
			"https://api.example.com/openapi.json"
		);
	});

	test("sync_spec's description says a user-deleted request is not re-created, and offers no way to", () => {
		const description = TOOLS.find((t) => t.name === "sync_spec")?.description;
		expect(typeof description).toBe("string");
		expect(description).toMatch(/except those the user deleted the request for \(`declined`\)/);
		expect(description).toMatch(/declined operations not re-created/);
		// No argument could name a declined operation to create: the schema is the
		// three it always was.
		const shape = TOOLS.find((t) => t.name === "sync_spec")?.inputSchema ?? {};
		expect(Object.keys(shape).sort()).toEqual(["collectionId", "content", "sourceUrl"]);
	});

	test("sync_spec declares both families it changes", () => {
		const tools = new Map(TOOLS.map((t) => [t.name, t]));
		expect(tools.get("sync_spec")?.category).toBe("write");
		// The same set a bind uses: the document and the binding are collection
		// state, and the rows this creates, updates and deletes are requests.
		expect(tools.get("sync_spec")?.invalidates).toEqual(["collection", "request"]);
		expect(tools.get("sync_spec")?.annotations.idempotentHint).toBe(false);
	});

	test("bind_spec declares both families it changes", () => {
		const tools = new Map(TOOLS.map((t) => [t.name, t]));
		expect(tools.get("bind_spec")?.category).toBe("write");
		// Requests as well as collections: the binding is a collection field, but
		// the identity this writes and clears lives on the requests beneath it.
		expect(tools.get("bind_spec")?.invalidates).toEqual(["collection", "request"]);
		// Each call mints a new document row, so the same arguments twice is not
		// the same call twice.
		expect(tools.get("bind_spec")?.annotations.idempotentHint).toBe(false);
	});
});
