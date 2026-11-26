/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { dispatchTool, TOOLS } from "../tools.js";
import { argumentsSchema } from "./kit.js";
import { EngineRequestError, type EngineClient } from "../engine-client.js";
import { listingEnv1, fakeClient, ctxWith, firstText } from "../tools.testkit.js";

describe("run_collection_smoke", () => {
	test("runs each request and reports pass/fail; skips off-allowlist hosts", async () => {
		const composedByRequest: Record<string, object> = {
			r1: { method: "GET", url: "https://api.example.com/ok" },
			r2: { method: "GET", url: "https://api.example.com/bad" },
			r3: { method: "GET", url: "https://evil.test/x" },
		};
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([
				{ id: "r1", name: "ok", method: "GET", url: "https://api.example.com/ok" },
				{ id: "r2", name: "bad", method: "GET", url: "https://api.example.com/bad" },
				{ id: "r3", name: "offlist", method: "GET", url: "https://evil.test/x" },
			]),
			composeRequest: vi
				.fn()
				.mockImplementation(({ requestId }: { requestId: string }) =>
					Promise.resolve(composedByRequest[requestId])
				),
			executeRequest: vi
				.fn()
				.mockResolvedValueOnce({ status: 200, testResults: [] })
				.mockResolvedValueOnce({ status: 500, testResults: [] }),
		});
		const res = await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		const summary = res.structuredContent as {
			total: number;
			passed: number;
			failed: number;
			skipped: number;
		};
		expect(summary).toMatchObject({ total: 3, passed: 1, failed: 1, skipped: 1 });
		// The off-allowlist request was never executed - and the gate read the
		// *composed* URL, which is why composition (pure, sends nothing) may run
		// for it while execution must not.
		expect((client.executeRequest as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
	});

	test("skips a request whose host is left as {{baseUrl}} with the gate's remedy as its reason (#2450)", async () => {
		const client = fakeClient({
			listRequests: vi
				.fn()
				.mockResolvedValue([
					{ id: "r1", name: "one", method: "GET", url: "{{baseUrl}}/x" },
				]),
			composeRequest: vi.fn().mockResolvedValue({ method: "GET", url: "{{baseUrl}}/x" }),
		});
		const res = await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		const matrix = res.structuredContent as {
			skipped: number;
			results: Array<{ reason?: string }>;
		};
		expect(matrix.skipped).toBe(1);
		const reason = matrix.results[0].reason ?? "";
		expect(reason).toMatch(/^Could not determine the target host/);
		expect(reason).toContain("{{baseUrl}}");
		expect(reason).toContain("update_collection");
		expect(client.executeRequest).not.toHaveBeenCalled();
	});

	test("does not skip a scheme-less host:port request whose host is allowlisted", async () => {
		// A collection saved against "localhost:3000/..." had every request
		// skipped, with a reason blaming unresolved {{variables}} in a URL that
		// carried none.
		const client = fakeClient({
			listRequests: vi
				.fn()
				.mockResolvedValue([
					{ id: "r1", name: "local", method: "GET", url: "localhost:3000/health" },
				]),
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "localhost:3000/health" }),
			executeRequest: vi.fn().mockResolvedValue({ status: 200, testResults: [] }),
		});
		const res = await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["localhost"] })
		);
		expect(res.structuredContent).toMatchObject({ total: 1, passed: 1, skipped: 0 });
		expect(client.executeRequest).toHaveBeenCalledTimes(1);
	});

	test("composes each request engine-side and executes the composed payload unchanged", async () => {
		// Canned engine output mirroring what POST /compose returns for a saved
		// request: variables resolved, inherited auth applied, chain + own script
		// parts attached. The composition itself is asserted engine-side
		// (request_composer_test.cpp); MCP's job is to request it by id and
		// forward it byte-for-byte.
		const composed = {
			method: "GET",
			url: "https://api.example.com/users",
			headers: { Accept: "application/json" },
			auth: { mode: "bearer", token: "abc123" },
			preRequestScripts: [
				{ origin: "collection", id: "c1", script: "pm.collectionVariables.set('x', 1)" },
			],
			postRequestScripts: [
				{
					origin: "request",
					id: "r1",
					script: "pm.test('ok', () => pm.response.to.have.status(200))",
				},
			],
			requestId: "r1",
			environmentId: "env_1",
		};
		const client = fakeClient({
			listEnvironments: listingEnv1(),
			listRequests: vi
				.fn()
				.mockResolvedValue([{ id: "r1", collectionId: "c1", name: "get user" }]),
			composeRequest: vi.fn().mockResolvedValue(composed),
			executeRequest: vi
				.fn()
				.mockResolvedValue({ status: 200, testResults: [{ passed: true }] }),
		});
		const res = await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1", environmentId: "env_1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		// Composed by id, scoped by the caller's environment.
		expect(client.composeRequest).toHaveBeenCalledWith(
			{ requestId: "r1", environmentId: "env_1" },
			undefined
		);
		// Executed exactly as composed - resolved once, never re-resolved - with
		// only the run's origin, the session's target policy and the buffered
		// answer it judges added beside it.
		const outgoing = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(outgoing).toEqual({
			...composed,
			stream: false,
			origin: { kind: "mcp" },
			targetPolicy: { allowAll: false, allowedHosts: ["api.example.com"] },
		});
		expect((res.structuredContent as { passed: number }).passed).toBe(1);
	});

	test("buffers a request stored with stream: true, since a row is judged by its exchange (#3561)", async () => {
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "events" }]),
			composeRequest: vi.fn().mockResolvedValue({
				method: "GET",
				url: "https://api.example.com/events",
				stream: true,
			}),
			executeRequest: vi.fn().mockResolvedValue({ status: 200, testResults: [] }),
		});
		const res = await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.structuredContent).toMatchObject({ total: 1, passed: 1 });
		const outgoing = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(outgoing).toMatchObject({ stream: false });
	});

	// Mutation check: spread `{ ...outgoing, stream: false }` as before and the
	// path rides the buffered send.
	test("buffers a stored streaming request without its stream text path (#3773)", async () => {
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "chat" }]),
			composeRequest: vi.fn().mockResolvedValue({
				method: "POST",
				url: "https://api.example.com/chat",
				stream: true,
				streamTextPath: "$.choices[0].delta.content",
				streamFirstContentMarker: "content_block_delta",
			}),
			executeRequest: vi.fn().mockResolvedValue({ status: 200, testResults: [] }),
		});
		await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		const outgoing = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(outgoing).toMatchObject({ stream: false });
		expect(outgoing).not.toHaveProperty("streamTextPath");
		expect(outgoing).not.toHaveProperty("streamFirstContentMarker");
	});

	test("a request that fails to compose is reported failed, not dropped", async () => {
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "broken" }]),
			composeRequest: vi
				.fn()
				.mockRejectedValue(new EngineRequestError("Engine responded 500", 500, "boom")),
		});
		const res = await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		const summary = res.structuredContent as {
			failed: number;
			results: Array<{ error?: string }>;
		};
		expect(summary.failed).toBe(1);
		expect(summary.results[0].error).toMatch(/500/);
		expect(client.executeRequest).not.toHaveBeenCalled();
	});

	/**
	 * `GET /requests?collectionId=` returns direct children only, so a smoke run
	 * on a parent folder is structurally partial. A green matrix that does not
	 * say so reads as "the whole collection passed".
	 */
	test("discloses the sub-collections it did not run", async () => {
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "ok" }]),
			listCollections: vi.fn().mockResolvedValue([
				{ id: "c1", name: "API" },
				{ id: "c2", name: "Billing", parentId: "c1" },
				{ id: "c3", name: "Users", parentId: "c1" },
				{ id: "c4", name: "Unrelated", parentId: "c9" },
				{ id: "c5", name: "Root" },
			]),
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "https://api.example.com/ok" }),
			executeRequest: vi.fn().mockResolvedValue({ status: 200, testResults: [] }),
		});
		const res = await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		const text = res.content.map((c) => c.text).join("\n");
		expect(text).toMatch(/2 sub-collection\(s\) were NOT run/);
		expect(text).toContain("Billing");
		expect(text).toContain("Users");
		// Only descendants of *this* collection are named.
		expect(text).not.toContain("Unrelated");
		expect(text).not.toContain("Root");
		// Both ways out are named: the smoke option, and the stored run.
		expect(text).toContain("`recursive: true` to run the whole tree in this tool");
		expect(text).toMatch(/`run_collection` with `recursive: true`/);
		// The matrix itself is untouched: it counts the direct requests it ran.
		expect(res.structuredContent).toMatchObject({ total: 1, passed: 1 });
		// Direct-only rows name no folder.
		expect(
			(res.structuredContent as { results: Array<{ folder?: string }> }).results[0].folder
		).toBeUndefined();
	});

	test("names the recursive paths when the collection list could not be read", async () => {
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "ok" }]),
			listCollections: vi
				.fn()
				.mockRejectedValueOnce(new Error("engine hiccup"))
				// The masking read after the sends asks for the list again.
				.mockResolvedValue([]),
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "https://api.example.com/ok" }),
			executeRequest: vi.fn().mockResolvedValue({ status: 200, testResults: [] }),
		});
		const res = await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		const text = res.content.map((c) => c.text).join("\n");
		expect(text).toContain("could not read the collection list");
		expect(text).toMatch(/`run_collection` with `recursive: true`/);
	});

	describe("recursive", () => {
		/**
		 * Root `c1` ("API") files, in sibling order: folder Users (order 0), its
		 * own request (order 1), folder Billing (order 2) - the shape an OpenAPI
		 * import gives, plus a direct request between two subtrees.
		 */
		function treeClient(overrides: Parameters<typeof fakeClient>[0] = {}) {
			const requestsByCollection: Record<string, object[]> = {
				c1: [{ id: "r_direct", name: "direct", order: 1 }],
				c2: [{ id: "r_user", name: "user", order: 0 }],
				c3: [
					{ id: "r_invoice", name: "invoice", order: 0 },
					{ id: "r_refund", name: "refund", order: 1 },
				],
			};
			return fakeClient({
				listCollections: vi.fn().mockResolvedValue([
					{ id: "c1", name: "API" },
					{ id: "c3", name: "Billing", parentId: "c1", order: 2 },
					{ id: "c2", name: "Users", parentId: "c1", order: 0 },
					{ id: "c9", name: "Elsewhere" },
				]),
				listRequests: vi
					.fn()
					.mockImplementation((id: string) =>
						Promise.resolve(requestsByCollection[id] ?? [])
					),
				composeRequest: vi
					.fn()
					.mockResolvedValue({ method: "GET", url: "https://api.example.com/ok" }),
				executeRequest: vi.fn().mockResolvedValue({ status: 200, testResults: [] }),
				...overrides,
			});
		}

		test("runs the whole tree in the sidebar's order and names each row's folder", async () => {
			const client = treeClient();
			const res = await dispatchTool(
				"run_collection_smoke",
				{ collectionId: "c1", recursive: true },
				ctxWith(client, { allowlist: ["api.example.com"] })
			);
			expect(res.isError).toBeFalsy();
			const summary = res.structuredContent as {
				total: number;
				passed: number;
				results: Array<{ name: string; folder?: string }>;
			};
			// Non-empty on purpose: a walk that found nothing would also be "in order".
			expect(summary.total).toBe(4);
			expect(summary.passed).toBe(4);
			expect(summary.results.map((row) => [row.name, row.folder])).toEqual([
				["user", "API / Users"],
				["direct", "API"],
				["invoice", "API / Billing"],
				["refund", "API / Billing"],
			]);
			expect(
				(client.composeRequest as ReturnType<typeof vi.fn>).mock.calls.map(
					(call) => (call[0] as { requestId: string }).requestId
				)
			).toEqual(["r_user", "r_direct", "r_invoice", "r_refund"]);
			// The SDK client checks structuredContent against the advertised JSON
			// schema, where an undeclared row field is refused; zod's own parse
			// strips it silently, so compare the keys against the emitted schema.
			const advertised = z.toJSONSchema(
				TOOLS.find((t) => t.name === "run_collection_smoke")!.outputSchema!,
				{ io: "output" }
			) as unknown as {
				properties: { results: { items: { properties: Record<string, unknown> } } };
			};
			const declared = Object.keys(advertised.properties.results.items.properties);
			expect(declared).toContain("folder");
			for (const row of summary.results) {
				expect(declared).toEqual(expect.arrayContaining(Object.keys(row)));
			}
			// A collection outside the subtree is never read, and the run left
			// nothing out, so it carries no scope caveat.
			expect(client.listRequests).not.toHaveBeenCalledWith("c9", undefined);
			expect(res.content.map((c) => c.text).join("\n")).not.toContain("NOT run");
		});

		test("without recursive the same tree runs the direct request alone", async () => {
			const client = treeClient();
			const res = await dispatchTool(
				"run_collection_smoke",
				{ collectionId: "c1" },
				ctxWith(client, { allowlist: ["api.example.com"] })
			);
			expect(res.structuredContent).toMatchObject({ total: 1, passed: 1 });
			expect(res.content.map((c) => c.text).join("\n")).toContain(
				"2 sub-collection(s) were NOT run"
			);
		});

		test("a page slices the expanded list, not the direct requests", async () => {
			const client = treeClient();
			const res = await dispatchTool(
				"run_collection_smoke",
				{ collectionId: "c1", recursive: true, limit: 2, offset: 1 },
				ctxWith(client, { allowlist: ["api.example.com"] })
			);
			const summary = res.structuredContent as {
				results: Array<{ name: string; folder?: string }>;
			};
			// Expanded order is user, direct, invoice, refund: offset 1 starts at "direct".
			expect(summary.results.map((row) => [row.name, row.folder])).toEqual([
				["direct", "API"],
				["invoice", "API / Billing"],
			]);
			expect(res.structuredContent).toMatchObject({
				total: 2,
				requestTotal: 4,
				hasMore: true,
				next: { offset: 3 },
			});
			// Only the page was composed; the rest of the list was read, not run.
			expect(client.composeRequest).toHaveBeenCalledTimes(2);
		});

		test("a parent cycle terminates and runs each request once", async () => {
			const client = treeClient({
				listCollections: vi.fn().mockResolvedValue([
					{ id: "c1", name: "A", parentId: "c2" },
					{ id: "c2", name: "B", parentId: "c1" },
				]),
				listRequests: vi
					.fn()
					.mockImplementation((id: string) =>
						Promise.resolve([{ id: `r_${id}`, name: `req ${id}` }])
					),
			});
			const res = await dispatchTool(
				"run_collection_smoke",
				{ collectionId: "c1", recursive: true },
				ctxWith(client, { allowlist: ["api.example.com"] })
			);
			expect(res.isError).toBeFalsy();
			expect(res.structuredContent).toMatchObject({ total: 2, passed: 2 });
		});

		test("a collection list that cannot be read is the engine error, and nothing is sent", async () => {
			const client = treeClient({
				listCollections: vi
					.fn()
					.mockRejectedValue(new EngineRequestError("Engine responded 500", 500, "boom")),
			});
			const res = await dispatchTool(
				"run_collection_smoke",
				{ collectionId: "c1", recursive: true },
				ctxWith(client, { allowlist: ["api.example.com"] })
			);
			expect(res.isError).toBe(true);
			expect(client.composeRequest).not.toHaveBeenCalled();
			expect(client.executeRequest).not.toHaveBeenCalled();
		});
	});

	/**
	 * The contract's verdict folds into `ok` the way `testResults` does
	 * (issue #681), and the three cases are deliberately spelled differently:
	 * checked-and-wrong fails the request, checked-and-right does not, and a
	 * response the document declares no schema for is neither.
	 */
	test("a response that contradicts its declared schema fails the request", async () => {
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([
				{ id: "r1", name: "matches" },
				{ id: "r2", name: "contradicts" },
				{ id: "r3", name: "undeclared" },
			]),
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "https://api.example.com/ok" }),
			executeRequest: vi
				.fn()
				.mockResolvedValueOnce({
					status: 200,
					testResults: [],
					validation: { checked: true, valid: true, failures: [], failuresTotal: 0 },
				})
				.mockResolvedValueOnce({
					status: 200,
					testResults: [],
					validation: {
						checked: true,
						valid: false,
						failuresTotal: 1,
						failures: [{ path: "/id", message: "unexpected instance type" }],
					},
				})
				.mockResolvedValueOnce({
					status: 200,
					testResults: [],
					validation: { checked: false, reason: "no_schema_for_status" },
				}),
		});
		const res = await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		const summary = res.structuredContent as {
			passed: number;
			failed: number;
			results: Array<{ ok: boolean; schema?: { checked: boolean; failures?: string[] } }>;
		};
		// Only the contradicting one failed - a 200 with an undeclared status
		// schema is not a broken API.
		expect(summary).toMatchObject({ passed: 2, failed: 1 });
		expect(summary.results[0].ok).toBe(true);
		expect(summary.results[1].ok).toBe(false);
		expect(summary.results[2].ok).toBe(true);
		// And the row says *why*, so an agent does not have to re-run to find out.
		expect(summary.results[1].schema?.failures).toEqual(["/id: unexpected instance type"]);
		expect(summary.results[2].schema).toMatchObject({
			checked: false,
			reason: "no_schema_for_status",
		});
	});

	/**
	 * The schema verdict above explains itself on the row; a test failure did
	 * not (issue #733) - `ok:false` beside a 200 named no reason, and an agent
	 * had no way to reach the detail the tool had already been handed. Passing
	 * assertions ride the row too: "2 tests, none failed" is the evidence that
	 * a request judged `ok` was judged against something.
	 */
	test("a request that failed on its tests says which tests failed", async () => {
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([
				{ id: "r1", name: "asserts and passes" },
				{ id: "r2", name: "asserts and fails" },
				{ id: "r3", name: "asserts nothing" },
			]),
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "https://api.example.com/ok" }),
			executeRequest: vi
				.fn()
				.mockResolvedValueOnce({
					status: 200,
					testResults: [
						{ name: "status is 200", passed: true },
						{ name: "body has id", passed: true },
					],
				})
				.mockResolvedValueOnce({
					status: 200,
					testResults: [
						{ name: "status is 200", passed: true },
						{
							name: "body has id",
							passed: false,
							error: "expected undefined to be a number",
						},
					],
				})
				.mockResolvedValueOnce({ status: 200, testResults: [] }),
		});
		const res = await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		const summary = res.structuredContent as {
			passed: number;
			failed: number;
			results: Array<{
				ok: boolean;
				tests?: { total: number; failed: number; failures?: string[] };
			}>;
		};
		expect(summary).toMatchObject({ passed: 2, failed: 1 });
		expect(summary.results[0]).toMatchObject({ ok: true, tests: { total: 2, failed: 0 } });
		expect(summary.results[0].tests?.failures).toBeUndefined();
		// The row a `ok:false` with a 200 status would otherwise leave unexplained.
		expect(summary.results[1].ok).toBe(false);
		expect(summary.results[1].tests).toMatchObject({ total: 2, failed: 1 });
		expect(summary.results[1].tests?.failures).toEqual([
			"body has id: expected undefined to be a number",
		]);
		// No assertions ran at all is not "everything passed", so the node is
		// absent rather than a zero the agent would read as a verdict.
		expect(summary.results[2]).toMatchObject({ ok: true });
		expect(summary.results[2].tests).toBeUndefined();
	});

	/**
	 * A pre-request assertion fails for different reasons than one about the
	 * response - a token fetch that did not return one, a fixture that is not
	 * there - and the engine lists both phases since #810. An agent handed the
	 * name alone would read every failure as the latter and go looking at the
	 * response.
	 */
	test("a failing pre-request assertion says it was made before the request", async () => {
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "logs in first" }]),
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "https://api.example.com/ok" }),
			executeRequest: vi.fn().mockResolvedValue({
				status: 200,
				testResults: [
					{
						name: "token was issued",
						passed: false,
						error: "expected 401 to equal 200",
						source: "pre",
					},
					{ name: "status is 200", passed: false, error: "nope", source: "test" },
				],
			}),
		});
		const res = await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		const summary = res.structuredContent as {
			results: Array<{ tests?: { total: number; failed: number; failures?: string[] } }>;
		};

		expect(summary.results[0].tests).toMatchObject({ total: 2, failed: 2 });
		// Only the pre-request one is labelled: the post-request assertions are
		// what this list has always been.
		expect(summary.results[0].tests?.failures).toEqual([
			"[pre-request] token was issued: expected 401 to equal 200",
			"status is 200: nope",
		]);
	});

	test("a failing inherited assertion names its level, ahead of the script it ran in", async () => {
		// Issue #2522: a collection's or a folder's assertion failed this request,
		// and the request's own script is the wrong place to go looking for it.
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "inherits" }]),
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "https://api.example.com/ok" }),
			executeRequest: vi.fn().mockResolvedValue({
				status: 200,
				testResults: [
					{ name: "root check", passed: false, source: "test", scope: "collection" },
					{ name: "folder setup", passed: false, source: "pre", scope: "folder" },
					{ name: "own check", passed: false, source: "test", scope: "request" },
					{ name: "stored before", passed: false, source: "test" },
					{ name: "unheard of", passed: false, source: "test", scope: "toString" },
				],
			}),
		});
		const res = await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		const summary = res.structuredContent as {
			results: Array<{ tests?: { failures?: string[] } }>;
		};

		expect(summary.results[0].tests?.failures).toEqual([
			"[collection] root check",
			"[folder] [pre-request] folder setup",
			"own check",
			"stored before",
			"unheard of",
		]);
	});

	/**
	 * Nothing caps `testResults` upstream, so a script writing hundreds of
	 * failing assertions would otherwise put all of them on one row of a matrix
	 * that already carries a row per request. `failed` stays the true count, so
	 * a cut list is visible as one.
	 */
	test("a row's failed-test list is capped, and the count still reports the total", async () => {
		const testResults = Array.from({ length: 25 }, (_, i) => ({
			name: `check ${i}`,
			passed: false,
			error: "nope",
		}));
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "noisy" }]),
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "https://api.example.com/ok" }),
			executeRequest: vi.fn().mockResolvedValue({ status: 200, testResults }),
		});
		const res = await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		const row = (
			res.structuredContent as {
				results: Array<{ tests?: { total: number; failed: number; failures?: string[] } }>;
			}
		).results[0];
		expect(row.tests).toMatchObject({ total: 25, failed: 25 });
		expect(row.tests?.failures).toHaveLength(10);
		expect(row.tests?.failures?.[0]).toBe("check 0: nope");
	});

	/**
	 * The gate, made switchable (issue #720). Both directions in one test on the
	 * same fixture, because the pair is the claim: the argument has to change
	 * the verdict *and* leave the row's evidence alone. Absent is the on state -
	 * this tool has folded since #681 and says so in its description, so a
	 * default of off would silently pass contract failures for every agent
	 * already reading the matrix.
	 */
	test.each([
		{ label: "absent", args: {}, ok: false, passed: 0, failed: 1 },
		{ label: "true", args: { failOnSchemaError: true }, ok: false, passed: 0, failed: 1 },
		{ label: "false", args: { failOnSchemaError: false }, ok: true, passed: 1, failed: 0 },
	])(
		"failOnSchemaError $label: a contradicting response is ok=$ok, verdict kept either way",
		async ({ args, ok, passed, failed }) => {
			const client = fakeClient({
				listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "contradicts" }]),
				composeRequest: vi
					.fn()
					.mockResolvedValue({ method: "GET", url: "https://api.example.com/ok" }),
				executeRequest: vi.fn().mockResolvedValue({
					status: 200,
					testResults: [],
					validation: {
						checked: true,
						valid: false,
						failuresTotal: 1,
						failures: [{ path: "/id", message: "unexpected instance type" }],
					},
				}),
			});
			const res = await dispatchTool(
				"run_collection_smoke",
				{ collectionId: "c1", ...args },
				ctxWith(client, { allowlist: ["api.example.com"] })
			);
			const summary = res.structuredContent as {
				passed: number;
				failed: number;
				results: Array<{ ok: boolean; schema?: { valid?: boolean; failures?: string[] } }>;
			};
			expect(summary).toMatchObject({ passed, failed });
			expect(summary.results[0].ok).toBe(ok);
			// Withheld from the outcome, never from the row: an agent that turned
			// the gate off still has to be able to see what it turned off.
			expect(summary.results[0].schema).toMatchObject({ valid: false });
			expect(summary.results[0].schema?.failures).toEqual(["/id: unexpected instance type"]);
		}
	);

	test("failOnSchemaError: false does not rescue a failing status or a failing test", async () => {
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([
				{ id: "r1", name: "500s" },
				{ id: "r2", name: "assertion fails" },
			]),
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "https://api.example.com/ok" }),
			executeRequest: vi
				.fn()
				.mockResolvedValueOnce({ status: 500, testResults: [] })
				.mockResolvedValueOnce({ status: 200, testResults: [{ passed: false }] }),
		});
		const res = await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1", failOnSchemaError: false },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.structuredContent).toMatchObject({ passed: 0, failed: 2 });
	});
});

/**
 * Scenario runs from MCP (issue #754), reversing #454's deferral. Two surfaces
 * over one engine route: `run_collection` posts a `scenario` block with no
 * `mode` (design-mode runner), `start_load_run` posts the same block *with* one
 * (virtual users). What these tests own is the same thing every other tool test
 * owns - what reaches `POST /runs`, and that no traffic is arranged before the
 * gates have run. The plan resolution itself is engine-side.
 */
describe("run_collection", () => {
	/** A client whose collection `c1` holds two allowlisted requests. */
	function scenarioClient(overrides: Partial<Record<keyof EngineClient, unknown>> = {}) {
		return fakeClient({
			listEnvironments: listingEnv1(),
			listRequests: vi.fn().mockResolvedValue([
				{ id: "r1", name: "login" },
				{ id: "r2", name: "checkout" },
			]),
			composeRequest: vi
				.fn()
				.mockImplementation(({ requestId }: { requestId: string }) =>
					Promise.resolve({ method: "GET", url: `https://api.example.com/${requestId}` })
				),
			...overrides,
		});
	}

	test("is an execute tool that invalidates runs, the cookie jar and saved-back variables", () => {
		const tool = TOOLS.find((t) => t.name === "run_collection");
		expect(tool?.category).toBe("execute");
		// Steps share the environment's jar, the way a Send does, and a step's
		// script can persist variables (#1916).
		expect(tool?.invalidates).toEqual(["run", "cookie", "variables"]);
	});

	test("posts the scenario block with rows, recursion and iterations intact", async () => {
		const client = scenarioClient();
		const rows = [{ id: "1" }, { id: "2" }];
		const res = await dispatchTool(
			"run_collection",
			{
				collectionId: "c1",
				environmentId: "env_1",
				recursive: false,
				iterations: 3,
				data: rows,
			},
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		expect(client.startRun).toHaveBeenCalledTimes(1);
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload).toEqual({
			scenario: {
				source: "collection",
				collectionId: "c1",
				recursive: false,
				iterations: 3,
				data: rows,
			},
			environmentId: "env_1",
			origin: { kind: "mcp" },
			targetPolicy: { allowAll: false, allowedHosts: ["api.example.com"] },
		});
		// The absence of `mode` is what makes this a design-mode run: a mode
		// beside the block would hand the same plan to the load executor.
		expect(payload).not.toHaveProperty("mode");
	});

	// How the file was read rides with it (#2540). Mutation check: drop
	// `dataFileCastNumbers` from `scenarioBlock` and this fails.
	test("forwards the rows' file name, hash and reading into the scenario block (#2051)", async () => {
		const client = scenarioClient();
		const rows = [{ id: "1" }];
		const hash = "c".repeat(64);
		const res = await dispatchTool(
			"run_collection",
			{
				collectionId: "c1",
				data: rows,
				dataFileName: "users.csv",
				dataFileHash: hash,
				dataFileCastNumbers: true,
			},
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
			string,
			unknown
		>;
		// Inside the block, where the engine reads them; top level beside a
		// scenario is refused engine-side.
		expect(payload.scenario).toMatchObject({
			data: rows,
			dataFileName: "users.csv",
			dataFileHash: hash,
			dataFileCastNumbers: true,
		});
		expect(payload).not.toHaveProperty("dataFileName");
		expect(payload).not.toHaveProperty("dataFileHash");
		expect(payload).not.toHaveProperty("dataFileCastNumbers");
	});

	test("the schema refuses a reading that is not a boolean, on every tool that takes one", () => {
		const schemaOf = (name: string) =>
			argumentsSchema(
				TOOLS.find((t) => t.name === name)!.inputSchema as Record<string, z.ZodType>
			);
		const cases = [
			[
				"run_collection",
				(cast: unknown) => ({ collectionId: "c1", dataFileCastNumbers: cast }),
			],
			["start_load_run", (cast: unknown) => ({ dataFileCastNumbers: cast })],
			[
				"start_load_run",
				(cast: unknown) => ({
					scenario: { collectionId: "c1", dataFileCastNumbers: cast },
				}),
			],
		] as const;
		for (const [name, args] of cases) {
			expect(schemaOf(name).safeParse(args(true)).success, name).toBe(true);
			expect(schemaOf(name).safeParse(args(false)).success, name).toBe(true);
			expect(schemaOf(name).safeParse(args("true")).success, name).toBe(false);
		}
	});

	test("the schema refuses a hash that is not 64 lowercase hex, on every tool that takes one", () => {
		const schemaOf = (name: string) =>
			argumentsSchema(
				TOOLS.find((t) => t.name === name)!.inputSchema as Record<string, z.ZodType>
			);
		const hash = "c".repeat(64);
		const cases = [
			["run_collection", (dataFileHash: string) => ({ collectionId: "c1", dataFileHash })],
			["start_load_run", (dataFileHash: string) => ({ dataFileHash })],
			[
				"start_load_run",
				(dataFileHash: string) => ({ scenario: { collectionId: "c1", dataFileHash } }),
			],
		] as const;
		for (const [name, args] of cases) {
			expect(schemaOf(name).safeParse(args(hash)).success, name).toBe(true);
			for (const bad of ["C".repeat(64), "abc", "/home/u/users.csv"]) {
				expect(schemaOf(name).safeParse(args(bad)).success, `${name} ${bad}`).toBe(false);
			}
		}
	});

	// A display name, never a path (#2051), refused before the engine has to.
	// Mutation check: drop the regex from `dataFileNameInput` and every path
	// case passes the schema.
	test("the schema refuses a path as a file name, pointing at dataFile.fileName", () => {
		const schemaOf = (name: string) =>
			argumentsSchema(
				TOOLS.find((t) => t.name === name)!.inputSchema as Record<string, z.ZodType>
			);
		const cases = [
			["run_collection", (dataFileName: string) => ({ collectionId: "c1", dataFileName })],
			["start_load_run", (dataFileName: string) => ({ dataFileName })],
			[
				"start_load_run",
				(dataFileName: string) => ({ scenario: { collectionId: "c1", dataFileName } }),
			],
		] as const;
		for (const [name, args] of cases) {
			expect(schemaOf(name).safeParse(args("users.csv")).success, name).toBe(true);
			for (const path of ["/home/u/users.csv", "exports/users.csv", "C:\\data\\users.csv"]) {
				const parsed = schemaOf(name).safeParse(args(path));
				expect(parsed.success, `${name} ${path}`).toBe(false);
				expect(parsed.error?.issues[0].message).toMatch(/never a path.*dataFile\.fileName/);
			}
		}
	});

	test("omits iterations and data when the caller named neither", async () => {
		const client = scenarioClient();
		await dispatchTool(
			"run_collection",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
			scenario: Record<string, unknown>;
		};
		// The engine owns both defaults (1 pass, or the row count with data), so
		// a computed copy here would be a second place for that rule to live.
		expect(payload.scenario).not.toHaveProperty("iterations");
		expect(payload.scenario).not.toHaveProperty("data");
		expect(payload.scenario.recursive).toBe(false);
	});

	test("forwards a timers override - the design-mode runner still waits on timer.pacing", async () => {
		// Unlike scripts (load-run only), execute_scenario_run wires
		// RunContext::timers_override into the same ExchangeInputs a scenario
		// load run does, so "off" is a real control here, not a no-op.
		const client = scenarioClient();
		const res = await dispatchTool(
			"run_collection",
			{ collectionId: "c1", elements: { timers: "off" } },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
			string,
			unknown
		>;
		expect(payload.elements).toEqual({ timers: "off" });
	});

	test("offers no scripts control - it has no effect on a design-mode run", () => {
		// scripts_override's one reader is replay_scenario_steps, the load
		// path's own post-run replay; run_collection never reads it, so
		// offering the control here would be an argument written and never
		// read.
		const tool = TOOLS.find((t) => t.name === "run_collection");
		const elementsShape = (
			tool!.inputSchema.elements as z.ZodOptional<z.ZodObject<Record<string, z.ZodType>>>
		)._def.innerType.shape;
		expect(Object.keys(elementsShape)).toEqual(["timers"]);
	});

	test("refuses the whole run on the first un-allowlisted step, starting nothing", async () => {
		const client = scenarioClient({
			listRequests: vi.fn().mockResolvedValue([
				{ id: "r1", name: "login" },
				{ id: "r2", name: "offsite" },
				{ id: "r3", name: "checkout" },
			]),
			composeRequest: vi.fn().mockImplementation(({ requestId }: { requestId: string }) =>
				Promise.resolve({
					method: "GET",
					url:
						requestId === "r2"
							? "https://evil.test/x"
							: `https://api.example.com/${requestId}`,
				})
			),
		});
		const res = await dispatchTool(
			"run_collection",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBe(true);
		// Named the way the engine names a step, so the row is findable.
		expect(firstText(res)).toMatch(/step 1 \(request 'offsite', id 'r2'\)/);
		expect(firstText(res)).toMatch(/evil\.test/);
		expect(firstText(res)).toMatch(/Nothing was started/);
		expect(client.startRun).not.toHaveBeenCalled();
		// The walk stops at the refusal rather than composing the rest.
		expect(client.composeRequest).toHaveBeenCalledTimes(2);
	});

	test("the refusal names the host and withholds the resolved URL (#1892)", async () => {
		const client = scenarioClient({
			getGlobals: vi.fn().mockResolvedValue({
				id: "globals",
				variables: { api_key: { value: "SECRETVALUE", secret: true, enabled: true } },
			}),
			composeRequest: vi.fn().mockImplementation(({ requestId }: { requestId: string }) =>
				Promise.resolve({
					method: "GET",
					url:
						requestId === "r2"
							? "https://evil.test/x?api_key=SECRETVALUE"
							: `https://api.example.com/${requestId}`,
				})
			),
		});
		const res = await dispatchTool(
			"run_collection",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/evil\.test/);
		expect(firstText(res)).not.toMatch(/SECRETVALUE/);
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("a step that cannot compose refuses the run rather than starting a plan the engine would reject", async () => {
		const client = scenarioClient({
			composeRequest: vi
				.fn()
				.mockRejectedValue(new EngineRequestError("Engine responded 500", 500, "boom")),
		});
		const res = await dispatchTool(
			"run_collection",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/Cannot compose step 0 \(request 'login', id 'r1'\)/);
		expect(client.startRun).not.toHaveBeenCalled();
	});

	/**
	 * The pre-flight walk has to visit steps in `collect_requests`' order, or its
	 * "first bad step" names a step the run reaches later. Every row here sits at
	 * 0, so the kind rank puts each folder's subtree ahead of its parent's own
	 * request; the interleaved shapes are `sibling-order.conformance.test.ts`'s.
	 */
	test("walks sub-collections in the engine's order when recursive", async () => {
		const requestsByCollection: Record<string, Array<{ id: string; name: string }>> = {
			c1: [{ id: "root_a", name: "root a" }],
			c2: [{ id: "child_a", name: "child a" }],
			c3: [{ id: "grand_a", name: "grand a" }],
		};
		const client = scenarioClient({
			listCollections: vi.fn().mockResolvedValue([
				{ id: "c1", name: "API" },
				{ id: "c2", name: "Billing", parentId: "c1" },
				{ id: "c3", name: "Invoices", parentId: "c2" },
				{ id: "c9", name: "Elsewhere" },
			]),
			listRequests: vi
				.fn()
				.mockImplementation((id: string) =>
					Promise.resolve(requestsByCollection[id] ?? [])
				),
		});
		const res = await dispatchTool(
			"run_collection",
			{ collectionId: "c1", recursive: true },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		const composedIds = (client.composeRequest as ReturnType<typeof vi.fn>).mock.calls.map(
			(call) => (call[0] as { requestId: string }).requestId
		);
		expect(composedIds).toEqual(["grand_a", "child_a", "root_a"]);
		expect(res.structuredContent).toMatchObject({ plannedSteps: 3 });
		// A collection outside the subtree is not walked.
		expect(client.listRequests).not.toHaveBeenCalledWith("c9", undefined);
	});

	test("a parent cycle terminates instead of walking forever", async () => {
		const client = scenarioClient({
			listCollections: vi.fn().mockResolvedValue([
				{ id: "c1", name: "A", parentId: "c2" },
				{ id: "c2", name: "B", parentId: "c1" },
			]),
			listRequests: vi.fn().mockResolvedValue([]),
		});
		const res = await dispatchTool(
			"run_collection",
			{ collectionId: "c1", recursive: true },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		// An empty plan is the engine's refusal to make, not this walk's - what
		// matters here is that the walk returned at all.
		expect(res.isError).toBeFalsy();
		expect(client.startRun).toHaveBeenCalledTimes(1);
	});

	test("returns the run id with the plan size and how to follow it", async () => {
		const client = scenarioClient({
			startRun: vi.fn().mockResolvedValue({
				runId: "run_7",
				status: "pending",
				message: "Collection run started",
			}),
		});
		const res = await dispatchTool(
			"run_collection",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.structuredContent).toMatchObject({
			runId: "run_7",
			status: "pending",
			plannedSteps: 2,
		});
		// The report's own bound, stated where the agent reads the run id: the
		// rows are the stored steps, and resultsStored/resultsCap say if cut.
		expect(firstText(res)).toMatch(/every stored step row/);
		expect(firstText(res)).toMatch(/resultsStored/);
		expect(firstText(res)).toMatch(/get_run_report/);
		// And that the rows carry bodies inline. A design-mode step trace embeds
		// the request and response bodies (`build_result_trace`), unlike a load
		// run's captures, which live behind GET /runs/:id/samples - so an agent
		// told the opposite would size a 100-step report as if it were metadata.
		expect(firstText(res)).toMatch(/bodies inline/);
	});

	test("surfaces the engine's own refusal verbatim", async () => {
		const client = scenarioClient({
			startRun: vi
				.fn()
				.mockRejectedValue(
					new EngineRequestError(
						"Engine responded 400",
						400,
						"'scenario.data' has 2000 rows, over the limit of 1000"
					)
				),
		});
		const res = await dispatchTool(
			"run_collection",
			{ collectionId: "c1", data: [{ id: "1" }] },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/over the limit of 1000/);
	});

	/**
	 * The contract as a gate (issue #766). `failOnSchemaError` is **run-scoped
	 * and top-level**, beside `scenario` rather than inside it, because that is
	 * where `read_fail_on_schema_error` looks - and it is sent only when the
	 * caller asked for it, so a stored payload carries the key exactly when it
	 * changed what "failed" meant for that run.
	 */
	describe("failOnSchemaError", () => {
		async function payloadFor(args: Record<string, unknown>) {
			const client = scenarioClient();
			const res = await dispatchTool(
				"run_collection",
				{ collectionId: "c1", ...args },
				ctxWith(client, { allowlist: ["api.example.com"] })
			);
			expect(res.isError).toBeFalsy();
			return (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
				string,
				unknown
			>;
		}

		test("reaches POST /runs top-level, not inside the scenario block", async () => {
			const payload = await payloadFor({ failOnSchemaError: true });
			expect(payload.failOnSchemaError).toBe(true);
			expect(payload.scenario).not.toHaveProperty("failOnSchemaError");
		});

		test.each([
			["omitted", {}],
			["false", { failOnSchemaError: false }],
		])("is absent from the payload when the caller passed %s", async (_label, args) => {
			const payload = await payloadFor(args);
			expect(payload).not.toHaveProperty("failOnSchemaError");
		});

		/**
		 * The two surfaces share one fragment and must not share one default: the
		 * smoke tool has folded the verdict into `ok` since #681, while the
		 * engine's `POST /runs` flag is off unless asked for.
		 */
		test("each surface states its own default, in its own unit", () => {
			const shapeOf = (name: string) =>
				TOOLS.find((t) => t.name === name)!.inputSchema as Record<string, z.ZodType>;
			const scenario = shapeOf("run_collection").failOnSchemaError.description ?? "";
			const smoke = shapeOf("run_collection_smoke").failOnSchemaError.description ?? "";
			expect(scenario).toContain("fails its step (default false)");
			expect(smoke).toContain("fails its request (default true)");
		});
	});

	/**
	 * Ending an iteration at a script error (issue #2526). Top-level beside
	 * `scenario`, like `failOnSchemaError`, and sent only when true: the engine's
	 * default is false, so a stored payload carries the key exactly when it
	 * changed what ended an iteration.
	 */
	describe("stopOnError", () => {
		async function runWith(args: Record<string, unknown>) {
			const client = scenarioClient();
			const res = await dispatchTool(
				"run_collection",
				{ collectionId: "c1", ...args },
				ctxWith(client, { allowlist: ["api.example.com"] })
			);
			expect(res.isError).toBeFalsy();
			const payload = (client.startRun as ReturnType<typeof vi.fn>).mock
				.calls[0][0] as Record<string, unknown>;
			return { res, payload };
		}

		test("reaches POST /runs top-level, not inside the scenario block", async () => {
			const { payload } = await runWith({ stopOnError: true });
			expect(payload.stopOnError).toBe(true);
			expect(payload.scenario).not.toHaveProperty("stopOnError");
		});

		test.each([
			["omitted", {}],
			["false", { stopOnError: false }],
		])("is absent from the payload when the caller passed %s", async (_label, args) => {
			const { payload } = await runWith(args);
			expect(payload).not.toHaveProperty("stopOnError");
		});

		test("the tool and its next step tell an agent what an error costs", async () => {
			const tool = TOOLS.find((t) => t.name === "run_collection")!;
			expect(tool.description).toContain("stopOnError");
			expect(tool.description).toContain("stepsNotRun");
			const shape = tool.inputSchema as Record<string, z.ZodType>;
			expect(shape.stopOnError.description).toMatch(/script error/);

			const { res } = await runWith({});
			expect(firstText(res)).toContain("stepsNotRun");
		});
	});

	/**
	 * The stream caps (#3235): the engine runs a stored streaming request as a
	 * stream and bounds it by these two top-level numbers, accepted without
	 * `stream` (which is a 400 on a collection run, so it is never sent).
	 */
	describe("stream caps", () => {
		async function payloadFor(args: Record<string, unknown>) {
			const client = scenarioClient();
			const res = await dispatchTool(
				"run_collection",
				{ collectionId: "c1", ...args },
				ctxWith(client, { allowlist: ["api.example.com"] })
			);
			expect(res.isError).toBeFalsy();
			return (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
				string,
				unknown
			>;
		}

		test("reach POST /runs top-level, without a stream flag", async () => {
			const payload = await payloadFor({ maxStreamDurationMs: 20_000, maxStreamEvents: 50 });
			expect(payload.maxStreamDurationMs).toBe(20_000);
			expect(payload.maxStreamEvents).toBe(50);
			expect(payload).not.toHaveProperty("stream");
			expect(payload.scenario).not.toHaveProperty("maxStreamEvents");
		});

		test("are absent when the caller named none", async () => {
			const payload = await payloadFor({});
			expect(payload).not.toHaveProperty("maxStreamDurationMs");
			expect(payload).not.toHaveProperty("maxStreamEvents");
		});

		test("take exactly the engine's ranges and no `stream` argument", () => {
			const parseArgs = (args: Record<string, unknown>) =>
				argumentsSchema(
					TOOLS.find((t) => t.name === "run_collection")!.inputSchema as Record<
						string,
						z.ZodType
					>
				).parse(args);
			for (const ok of [
				{ maxStreamDurationMs: 1000 },
				{ maxStreamDurationMs: 86_400_000 },
				{ maxStreamEvents: 1 },
				{ maxStreamEvents: 10_000_000 },
			]) {
				expect(() => parseArgs({ collectionId: "c1", ...ok })).not.toThrow();
			}
			for (const bad of [
				{ maxStreamDurationMs: 999 },
				{ maxStreamDurationMs: 86_400_001 },
				{ maxStreamEvents: 0 },
				{ maxStreamEvents: 10_000_001 },
				{ maxStreamEvents: 2.5 },
			]) {
				expect(() => parseArgs({ collectionId: "c1", ...bad })).toThrow();
			}
			const shape = TOOLS.find((t) => t.name === "run_collection")!.inputSchema as Record<
				string,
				z.ZodType
			>;
			expect(shape).not.toHaveProperty("stream");
		});
	});

	/**
	 * Pass/fail budgets (issue #1564): the engine now judges a design-mode
	 * collection run against `thresholds` exactly as it always has a load run,
	 * so this tool takes the same argument `start_load_run` does and forwards
	 * it verbatim.
	 */
	describe("thresholds", () => {
		async function payloadFor(args: Record<string, unknown>) {
			const client = scenarioClient();
			const res = await dispatchTool(
				"run_collection",
				{ collectionId: "c1", ...args },
				ctxWith(client, { allowlist: ["api.example.com"] })
			);
			return { res, client };
		}

		test("forwards a declared budget to POST /runs unchanged", async () => {
			const { res, client } = await payloadFor({
				thresholds: { maxErrorRatePct: 0.1, failRun: true },
			});
			expect(res.isError).toBeFalsy();
			const payload = (client.startRun as ReturnType<typeof vi.fn>).mock
				.calls[0][0] as Record<string, unknown>;
			expect(payload.thresholds).toEqual({ maxErrorRatePct: 0.1, failRun: true });
		});

		test("is absent from the payload when the caller named none", async () => {
			const { res, client } = await payloadFor({});
			expect(res.isError).toBeFalsy();
			const payload = (client.startRun as ReturnType<typeof vi.fn>).mock
				.calls[0][0] as Record<string, unknown>;
			expect(payload).not.toHaveProperty("thresholds");
		});

		// start_load_run re-describes it as a pointer (#3747), so the two
		// arguments are distinct wrappers around the one budget schema.
		test("shares its schema with start_load_run's own thresholds argument", () => {
			const thresholdsOf = (name: string) =>
				(TOOLS.find((t) => t.name === name)!.inputSchema as Record<string, z.ZodOptional>)
					.thresholds;
			expect(thresholdsOf("run_collection").unwrap()).toBe(
				thresholdsOf("start_load_run").unwrap()
			);
			expect(thresholdsOf("start_load_run").description).toBe("As on `run_collection`.");
		});

		// Mutation check: drop the populations sentence from `thresholdsInput` and
		// this fails. An agent that reads only the argument must learn that the
		// assertion budget judges the worse of the exact and sampled populations
		// (#2892).
		test("describes the assertion budget's two populations (#2892)", () => {
			const shape = TOOLS.find((t) => t.name === "run_collection")!.inputSchema as Record<
				string,
				z.ZodType
			>;
			const description = shape.thresholds.description ?? "";
			expect(description).toContain(
				"judges the worse of the exact inline assertions and the sampled"
			);
			for (const key of ["assertionsExact", "assertionsSampled", "sampleRate"]) {
				expect(description).toContain(key);
			}
		});
	});
});
