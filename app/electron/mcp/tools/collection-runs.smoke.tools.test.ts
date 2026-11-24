/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { dispatchTool, TOOLS, type ToolContext, type ToolResult } from "../tools.js";
import { argumentsSchema } from "./kit.js";
import { EngineRequestError, type EngineClient } from "../engine-client.js";
import { REDACTED_MARKER } from "../withhold.js";
import { descriptionOf, fakeClient, ctxWith, firstText } from "../tools.testkit.js";

describe("run_collection_smoke", () => {
	describe("the engine's error on a row (#3552)", () => {
		const smokeWith = (answer: Record<string, unknown>) =>
			dispatchTool(
				"run_collection_smoke",
				{ collectionId: "c1" },
				ctxWith(
					fakeClient({
						listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "one" }]),
						composeRequest: vi.fn().mockResolvedValue({
							method: "GET",
							url: "https://api.example.com/ok",
						}),
						executeRequest: vi.fn().mockResolvedValue(answer),
					}),
					{ allowlist: ["api.example.com"] }
				)
			);
		const firstRow = (res: Awaited<ReturnType<typeof smokeWith>>) =>
			(res.structuredContent as { results: Array<Record<string, unknown>> }).results[0];

		test("a status 0 answer with an errorCode names the code and the message", async () => {
			const row = firstRow(
				await smokeWith({
					status: 0,
					errorCode: "TIMEOUT",
					errorMessage: "no response within 30000ms",
					testResults: [],
				})
			);
			expect(row).toMatchObject({
				ok: false,
				statusCode: 0,
				error: "TIMEOUT: no response within 30000ms",
			});
		});

		test("an errorCode with no message is the code alone", async () => {
			expect(firstRow(await smokeWith({ status: 0, errorCode: "DNS_ERROR" })).error).toBe(
				"DNS_ERROR"
			);
		});

		test("an answer with no errorCode leaves error unset", async () => {
			const row = firstRow(await smokeWith({ status: 500, testResults: [] }));
			expect(row).toMatchObject({ ok: false, statusCode: 500 });
			expect(row).not.toHaveProperty("error");
		});
	});

	describe("an mcp request's failure on a row (#3809)", () => {
		const smokeWith = (answer: Record<string, unknown>, overrides = {}) =>
			dispatchTool(
				"run_collection_smoke",
				{ collectionId: "c1" },
				ctxWith(
					fakeClient({
						listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "one" }]),
						composeRequest: vi.fn().mockResolvedValue({
							method: "POST",
							url: "https://api.example.com/mcp",
						}),
						executeRequest: vi.fn().mockResolvedValue(answer),
						...overrides,
					}),
					{ allowlist: ["api.example.com"] }
				)
			);
		const rowOf = (res: Awaited<ReturnType<typeof smokeWith>>) =>
			(res.structuredContent as { results: Array<Record<string, unknown>> }).results[0];
		const failedTest = [{ name: "mcp", passed: false, error: "tool failure" }];

		test("a tool-class failure behind HTTP 200 names its class and message, and no code", async () => {
			const res = await smokeWith({
				status: 200,
				testResults: failedTest,
				mcp: { errorClass: "tool", message: "quota exceeded" },
			});
			const row = rowOf(res);
			expect(row).toMatchObject({
				ok: false,
				statusCode: 200,
				mcp: { errorClass: "tool", message: "quota exceeded" },
			});
			expect(row.mcp).not.toHaveProperty("code");
			// The SDK refuses an undeclared row member, and zod's parse strips it,
			// so a row member the schema does not declare is gone after the parse.
			const parsed = TOOLS.find(
				(t) => t.name === "run_collection_smoke"
			)!.outputSchema!.parse(res.structuredContent) as {
				results: Array<Record<string, unknown>>;
			};
			expect(parsed.results[0].mcp).toEqual(row.mcp);
		});

		test("a protocol failure carries the JSON-RPC code", async () => {
			const row = rowOf(
				await smokeWith({
					status: 200,
					testResults: failedTest,
					mcp: { errorClass: "protocol", code: -32601, message: "Method not found" },
				})
			);
			expect(row.mcp).toEqual({
				errorClass: "protocol",
				code: -32601,
				message: "Method not found",
			});
		});

		test("a success carries no mcp member, the engine's empty node included", async () => {
			expect(
				rowOf(await smokeWith({ status: 200, testResults: [], mcp: {} }))
			).not.toHaveProperty("mcp");
			expect(rowOf(await smokeWith({ status: 200, testResults: [] }))).not.toHaveProperty(
				"mcp"
			);
		});

		test("a transfer that failed is reported once, as the row's error", async () => {
			const row = rowOf(
				await smokeWith({
					status: 0,
					errorCode: "TIMEOUT",
					errorMessage: "no response",
					mcp: { errorClass: "transport", message: "no response" },
				})
			);
			expect(row.error).toBe("TIMEOUT: no response");
			expect(row).not.toHaveProperty("mcp");
		});

		test("the message is masked like the row's other server text", async () => {
			const getGlobals = vi.fn().mockResolvedValue({
				id: "globals",
				variables: { api_key: { value: "SECRETVALUE", secret: true, enabled: true } },
			});
			const row = rowOf(
				await smokeWith(
					{
						status: 200,
						testResults: failedTest,
						mcp: { errorClass: "tool", message: "bad key SECRETVALUE" },
					},
					{ getGlobals }
				)
			);
			expect((row.mcp as { message: string }).message).toBe(`bad key ${REDACTED_MARKER}`);
		});
	});

	test("a collection bound to no document reports no schema field at all", async () => {
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "ok" }]),
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "https://api.example.com/ok" }),
			// No `validation` node - what the engine returns for an unbound
			// collection. Absent must not become `{checked: false}`, which would
			// claim a contract could not judge this response when there was none.
			executeRequest: vi.fn().mockResolvedValue({ status: 200, testResults: [] }),
		});
		const res = await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		const summary = res.structuredContent as { results: Array<Record<string, unknown>> };
		expect(summary.results[0]).not.toHaveProperty("schema");
	});

	/**
	 * The declared-schema-must-be-updated trap: a field the handler returns but
	 * the `outputSchema` does not declare is rejected by the SDK before an agent
	 * sees it, and only asserting the result against the tool's own schema
	 * catches it.
	 */
	test("what the handler returns validates against the tool's declared outputSchema", async () => {
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([
				{ id: "r1", name: "ok" },
				{ id: "r2", name: "offlist" },
			]),
			composeRequest: vi.fn().mockImplementation(({ requestId }: { requestId: string }) =>
				Promise.resolve({
					method: "GET",
					url: requestId === "r1" ? "https://api.example.com/ok" : "https://evil.test/x",
				})
			),
			executeRequest: vi.fn().mockResolvedValue({
				status: 200,
				testResults: [],
				validation: {
					checked: true,
					valid: false,
					failuresTotal: 2,
					failures: [{ path: "", message: "required property 'name' missing" }],
				},
			}),
		});
		const res = await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		const tool = TOOLS.find((t) => t.name === "run_collection_smoke");
		expect(tool?.outputSchema).toBeDefined();
		expect(() => tool!.outputSchema!.parse(res.structuredContent)).not.toThrow();
		// A body-level failure keeps a readable location rather than an empty one.
		const summary = res.structuredContent as {
			results: Array<{ schema?: { failures?: string[]; failuresTotal?: number } }>;
		};
		expect(summary.results[0].schema?.failures).toEqual([
			"(body): required property 'name' missing",
		]);
		expect(summary.results[0].schema?.failuresTotal).toBe(2);
	});

	test("says nothing extra when the collection has no sub-collections", async () => {
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "ok" }]),
			listCollections: vi.fn().mockResolvedValue([{ id: "c1", name: "API" }]),
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
		expect(res.content.map((c) => c.text).join("\n")).not.toMatch(/sub-collection/);
	});

	test("an unreadable collection list is disclosed as unchecked, not as no children", async () => {
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "ok" }]),
			listCollections: vi
				.fn()
				.mockRejectedValue(new EngineRequestError("Engine responded 500", 500, "boom")),
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "https://api.example.com/ok" }),
			executeRequest: vi.fn().mockResolvedValue({ status: 200, testResults: [] }),
		});
		// Revealed, because with secrets withheld the same failed read leaves the
		// matrix unmaskable and the call fails closed (`secret withholding`).
		const res = await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"], revealSecretsToAgents: true })
		);
		// The run itself still succeeds - the lookup is a disclosure, not a gate.
		expect(res.isError).toBeFalsy();
		expect(res.structuredContent).toMatchObject({ total: 1, passed: 1 });
		expect(res.content.map((c) => c.text).join("\n")).toMatch(
			/could not read the collection list/
		);
	});

	test("the tool description states the scope it actually runs", () => {
		const tool = TOOLS.find((t) => t.name === "run_collection_smoke");
		expect(descriptionOf(tool)).toMatch(/DIRECT requests/);
		expect(descriptionOf(tool)).toMatch(/one at a time/);
	});

	test("the tool description steers a large collection to run_collection and says it reports progress", () => {
		const text = descriptionOf(TOOLS.find((t) => t.name === "run_collection_smoke"));
		expect(text).toMatch(/past about 25 requests or on a slow API use run_collection/);
		expect(text).toMatch(/get_run_report/);
		expect(text).toMatch(/Reports progress when the client asks/);
	});

	/**
	 * A long smoke run was silent until it finished (#2451). The client hears
	 * of it through `ctx.progress`, which exists only when it sent a
	 * `progressToken`; every row ticks it exactly once, however the row ended.
	 */
	describe("progress", () => {
		const SECRET = "s3cr3t-token-value";

		/** Five rows, one per way a row can end; each carries SECRET wherever a row could echo it. */
		function mixedRows() {
			const rows = ["ok", "compose", "offlist", "status", "send"].map((kind, i) => ({
				id: `r${i + 1}`,
				name: `${kind} ${SECRET}`,
				method: "GET",
				url: `https://${kind === "offlist" ? "evil.test" : "api.example.com"}/${kind}?k=${SECRET}`,
			}));
			const byId = new Map(rows.map((r) => [r.id, r]));
			return fakeClient({
				listRequests: vi.fn().mockResolvedValue(rows),
				composeRequest: vi
					.fn()
					.mockImplementation(({ requestId }: { requestId: string }) => {
						if (requestId === "r2") {
							return Promise.reject(new Error(`compose failed for ${SECRET}`));
						}
						const row = byId.get(requestId)!;
						return Promise.resolve({ method: row.method, url: row.url, requestId });
					}),
				executeRequest: vi
					.fn()
					.mockImplementation(({ requestId }: { requestId: string }) => {
						if (requestId === "r5")
							return Promise.reject(new Error(`send failed ${SECRET}`));
						return Promise.resolve({
							status: requestId === "r4" ? 500 : 200,
							testResults: [],
						});
					}),
			});
		}

		const smoke = (ctx: ToolContext) =>
			dispatchTool("run_collection_smoke", { collectionId: "c1" }, ctx);
		const onApi = { allowlist: ["api.example.com"] };

		test("ticks 0/total, then once per row, for a collection that all passes", async () => {
			const rows = [1, 2, 3, 4, 5].map((n) => ({
				id: `r${n}`,
				name: `n${n}`,
				method: "GET",
				url: `https://api.example.com/${n}`,
			}));
			const client = fakeClient({
				listRequests: vi.fn().mockResolvedValue(rows),
				composeRequest: vi.fn().mockImplementation(({ requestId }: { requestId: string }) =>
					Promise.resolve({
						method: "GET",
						url: `https://api.example.com/${requestId}`,
					})
				),
				executeRequest: vi.fn().mockResolvedValue({ status: 200, testResults: [] }),
			});
			const progress = vi.fn();
			const res = await smoke({ ...ctxWith(client, onApi), progress });
			expect(res.structuredContent).toMatchObject({ total: 5, passed: 5 });
			expect(progress.mock.calls).toEqual([
				[0, 5],
				[1, 5, "1/5 ok"],
				[2, 5, "2/5 ok"],
				[3, 5, "3/5 ok"],
				[4, 5, "4/5 ok"],
				[5, 5, "5/5 ok"],
			]);
		});

		test("a skipped row, a compose failure, a bad status and a send error each still tick", async () => {
			const progress = vi.fn();
			const res = await smoke({ ...ctxWith(mixedRows(), onApi), progress });
			expect(res.structuredContent).toMatchObject({
				total: 5,
				passed: 1,
				failed: 3,
				skipped: 1,
			});
			expect(progress.mock.calls).toEqual([
				[0, 5],
				[1, 5, "1/5 ok"],
				[2, 5, "2/5 failed"],
				[3, 5, "3/5 skipped"],
				[4, 5, "4/5 failed"],
				[5, 5, "5/5 failed"],
			]);
		});

		test("a message is an index and a status word, never a name, url or error text", async () => {
			const progress = vi.fn();
			await smoke({ ...ctxWith(mixedRows(), onApi), progress });
			const messages = progress.mock.calls.map(([, , message]) => message).filter(Boolean);
			// Non-empty, so the loop below cannot pass by reading nothing.
			expect(messages).toHaveLength(5);
			for (const message of messages) {
				expect(message).toMatch(/^\d+\/5 (ok|skipped|failed)$/);
				expect(message).not.toContain(SECRET);
			}
		});

		test("an empty collection ticks nothing", async () => {
			const progress = vi.fn();
			const client = fakeClient({ listRequests: vi.fn().mockResolvedValue([]) });
			await smoke({ ...ctxWith(client, onApi), progress });
			expect(progress).not.toHaveBeenCalled();
		});

		test("without ctx.progress the result is the same", async () => {
			const progress = vi.fn();
			const plain = await smoke(ctxWith(mixedRows(), onApi));
			const ticked = await smoke({ ...ctxWith(mixedRows(), onApi), progress });
			expect(progress).toHaveBeenCalled();
			expect(plain.isError).toBeFalsy();
			expect(plain.structuredContent).toEqual(ticked.structuredContent);
		});
	});

	/**
	 * A call runs one bounded page of the collection and says in the result what
	 * it left (#2451). `total` and the counts stay the rows run in this call;
	 * `requestTotal` is the collection's size in scope.
	 */
	describe("paging", () => {
		const onApi = { allowlist: ["api.example.com"] };

		/** `count` saved requests, named "req N", each composing to its own passing URL. */
		function pagedClient(count: number, overrides: Parameters<typeof fakeClient>[0] = {}) {
			const rows = Array.from({ length: count }, (_, i) => ({
				id: `r${i + 1}`,
				name: `req ${i + 1}`,
				method: "GET",
				url: `https://api.example.com/${i + 1}`,
			}));
			return fakeClient({
				listRequests: vi.fn().mockResolvedValue(rows),
				composeRequest: vi.fn().mockImplementation(({ requestId }: { requestId: string }) =>
					Promise.resolve({
						method: "GET",
						url: `https://api.example.com/${requestId}`,
					})
				),
				executeRequest: vi.fn().mockResolvedValue({ status: 200, testResults: [] }),
				...overrides,
			});
		}

		interface Paged {
			total: number;
			passed: number;
			requestTotal: number;
			hasMore: boolean;
			next?: { offset: number };
			cancelled?: boolean;
			note?: string;
			results: Array<{ name: string }>;
		}

		const smokePage = (
			client: EngineClient,
			args: Record<string, unknown>,
			signal?: AbortSignal
		) =>
			dispatchTool(
				"run_collection_smoke",
				{ collectionId: "c1", ...args },
				ctxWith(client, onApi),
				signal
			);
		const pagedOf = (res: ToolResult) => res.structuredContent as unknown as Paged;
		const namesOf = (res: ToolResult) => pagedOf(res).results.map((row) => row.name);

		test("limit and offset cut a window from the list and say where the next one starts", async () => {
			const client = pagedClient(5);
			const res = await smokePage(client, { limit: 2, offset: 0 });
			expect(namesOf(res)).toEqual(["req 1", "req 2"]);
			expect(pagedOf(res)).toMatchObject({
				total: 2,
				passed: 2,
				requestTotal: 5,
				hasMore: true,
				next: { offset: 2 },
			});
			expect(pagedOf(res).cancelled).toBeUndefined();
			expect(pagedOf(res).note).toContain("Ran 2 of 5 requests");
			expect(pagedOf(res).note).toContain("offset: 2");
			expect(client.executeRequest).toHaveBeenCalledTimes(2);

			const second = await smokePage(client, { limit: 2, offset: 2 });
			expect(namesOf(second)).toEqual(["req 3", "req 4"]);
			expect(pagedOf(second).next).toEqual({ offset: 4 });
		});

		test("the last page runs what is left and offers no next page", async () => {
			const res = await smokePage(pagedClient(5), { limit: 2, offset: 4 });
			expect(namesOf(res)).toEqual(["req 5"]);
			expect(pagedOf(res)).toMatchObject({ total: 1, requestTotal: 5, hasMore: false });
			expect(pagedOf(res)).not.toHaveProperty("next");
			expect(pagedOf(res)).not.toHaveProperty("note");
		});

		test.each([5, 99])(
			"an offset of %i past a 5-request list runs nothing and says so",
			async (offset) => {
				const client = pagedClient(5);
				const res = await smokePage(client, { offset });
				expect(res.isError).toBeFalsy();
				expect(pagedOf(res)).toMatchObject({
					total: 0,
					requestTotal: 5,
					hasMore: false,
					results: [],
				});
				expect(pagedOf(res)).not.toHaveProperty("next");
				expect(pagedOf(res).note).toMatch(/past the end/);
				expect(client.composeRequest).not.toHaveBeenCalled();
			}
		);

		test("a collection that fits one page carries the size and no note", async () => {
			const res = await smokePage(pagedClient(3), {});
			expect(pagedOf(res)).toMatchObject({ total: 3, requestTotal: 3, hasMore: false });
			expect(pagedOf(res)).not.toHaveProperty("note");
		});

		test("the default limit of 25 cuts a longer list and discloses the rest in the result", async () => {
			const client = pagedClient(30);
			const first = await smokePage(client, {});
			expect(pagedOf(first).results).toHaveLength(25);
			expect(pagedOf(first)).toMatchObject({
				total: 25,
				requestTotal: 30,
				hasMore: true,
				next: { offset: 25 },
			});
			expect(pagedOf(first).note).toContain("Ran 25 of 30 requests");
			// The note is in the text block a client reads, not only the structured one.
			expect(firstText(first)).toContain("call again with offset: 25");

			const rest = await smokePage(client, { offset: 25 });
			expect(namesOf(rest)).toEqual(["req 26", "req 27", "req 28", "req 29", "req 30"]);
			expect(pagedOf(rest).hasMore).toBe(false);
		});

		test.each([
			["limit above 100", { limit: 101 }],
			["limit of 0", { limit: 0 }],
			["fractional limit", { limit: 1.5 }],
			["negative offset", { offset: -1 }],
		])("%s is refused before any request is composed or sent", async (_label, args) => {
			const client = pagedClient(5);
			const res = await smokePage(client, args);
			expect(res.isError).toBe(true);
			expect(client.composeRequest).not.toHaveBeenCalled();
			expect(client.executeRequest).not.toHaveBeenCalled();
		});

		test("the advertised input bounds limit at 100 and offset at 0", () => {
			const shape = TOOLS.find((t) => t.name === "run_collection_smoke")!.inputSchema!;
			const input = argumentsSchema(shape);
			expect(input.safeParse({ collectionId: "c1", limit: 100, offset: 0 }).success).toBe(
				true
			);
			expect(input.safeParse({ collectionId: "c1", limit: 101 }).success).toBe(false);
			expect(input.safeParse({ collectionId: "c1", offset: -1 }).success).toBe(false);
		});

		test("progress counts the page it runs, not the collection", async () => {
			const progress = vi.fn();
			await dispatchTool(
				"run_collection_smoke",
				{ collectionId: "c1", limit: 2, offset: 1 },
				{ ...ctxWith(pagedClient(5), onApi), progress }
			);
			expect(progress.mock.calls).toEqual([
				[0, 2],
				[1, 2, "1/2 ok"],
				[2, 2, "2/2 ok"],
			]);
		});

		test("a paged result validates against the advertised output schema, field for field", async () => {
			const res = await smokePage(pagedClient(5), { limit: 2 });
			const outputSchema = TOOLS.find(
				(t) => t.name === "run_collection_smoke"
			)!.outputSchema!;
			expect(() => outputSchema.parse(res.structuredContent)).not.toThrow();
			// zod's own parse strips an undeclared key; the SDK client refuses it.
			const advertised = z.toJSONSchema(outputSchema, { io: "output" }) as unknown as {
				properties: Record<string, unknown>;
			};
			const returned = Object.keys(res.structuredContent!);
			expect(returned).toEqual(
				expect.arrayContaining(["requestTotal", "hasMore", "next", "note"])
			);
			expect(Object.keys(advertised.properties)).toEqual(expect.arrayContaining(returned));
		});

		describe("cancellation", () => {
			/** An `executeRequest` that completes @p completing sends, then runs @p onNext on the next. */
			function executeUntil(completing: number, onNext: () => Promise<unknown>) {
				let calls = 0;
				return vi.fn().mockImplementation(() => {
					calls += 1;
					return calls <= completing
						? Promise.resolve({ status: 200, testResults: [] })
						: onNext();
				});
			}
			const abortError = () =>
				Object.assign(new Error("This operation was aborted"), { name: "AbortError" });

			test("a cancellation after row 2 returns those two rows and where to resume", async () => {
				const controller = new AbortController();
				const client = pagedClient(5, {
					executeRequest: vi.fn().mockImplementation(() => {
						// The cancellation lands as the second send finishes.
						if (
							(client.executeRequest as ReturnType<typeof vi.fn>).mock.calls
								.length === 2
						) {
							controller.abort();
						}
						return Promise.resolve({ status: 200, testResults: [] });
					}),
				});
				const res = await smokePage(client, {}, controller.signal);
				expect(res.isError).toBeFalsy();
				expect(namesOf(res)).toEqual(["req 1", "req 2"]);
				expect(pagedOf(res)).toMatchObject({
					total: 2,
					passed: 2,
					requestTotal: 5,
					cancelled: true,
					hasMore: true,
					next: { offset: 2 },
				});
				expect(pagedOf(res).note).toMatch(/^Cancelled after 2 of 5 requests/);
				expect(client.executeRequest).toHaveBeenCalledTimes(2);
			});

			test("a send the cancellation interrupts is not a row, and the resume offset points at it", async () => {
				const controller = new AbortController();
				const client = pagedClient(5, {
					executeRequest: executeUntil(2, () => {
						controller.abort();
						return Promise.reject(abortError());
					}),
				});
				const res = await smokePage(client, { offset: 1 }, controller.signal);
				expect(namesOf(res)).toEqual(["req 2", "req 3"]);
				expect(pagedOf(res)).toMatchObject({
					total: 2,
					failed: 0,
					cancelled: true,
					hasMore: true,
					next: { offset: 3 },
				});
				expect(pagedOf(res).note).toContain("may have been sent");
			});

			test("a compose the cancellation interrupts is not a failed row either", async () => {
				const controller = new AbortController();
				let composed = 0;
				const client = pagedClient(3, {
					composeRequest: vi
						.fn()
						.mockImplementation(({ requestId }: { requestId: string }) => {
							composed += 1;
							if (composed === 2) {
								controller.abort();
								return Promise.reject(abortError());
							}
							return Promise.resolve({
								method: "GET",
								url: `https://api.example.com/${requestId}`,
							});
						}),
				});
				const res = await smokePage(client, {}, controller.signal);
				expect(namesOf(res)).toEqual(["req 1"]);
				expect(pagedOf(res)).toMatchObject({
					failed: 0,
					cancelled: true,
					next: { offset: 1 },
				});
			});

			test("a send error with no cancellation stays a failed row and the run goes on", async () => {
				const controller = new AbortController();
				const client = pagedClient(3, {
					executeRequest: executeUntil(1, () =>
						Promise.reject(new Error("socket hang up"))
					),
				});
				const res = await smokePage(client, {}, controller.signal);
				expect(pagedOf(res)).toMatchObject({
					total: 3,
					passed: 1,
					failed: 2,
					hasMore: false,
				});
				expect(pagedOf(res).cancelled).toBeUndefined();
				expect(
					(res.structuredContent as { results: Array<{ error?: string }> }).results[1]
						.error
				).toBe("socket hang up");
			});

			test("a cancelled call reads its masking scopes without the aborted signal, so the rows still return", async () => {
				const controller = new AbortController();
				const refusesAborted = () => (signal?: AbortSignal) =>
					signal?.aborted ? Promise.reject(abortError()) : Promise.resolve([]);
				const client = pagedClient(3, {
					executeRequest: executeUntil(1, () => {
						controller.abort();
						return Promise.reject(abortError());
					}),
					listCollections: vi.fn().mockImplementation(refusesAborted()),
					listEnvironments: vi.fn().mockImplementation(refusesAborted()),
					listAllRequests: vi.fn().mockImplementation(refusesAborted()),
					getGlobals: vi
						.fn()
						.mockImplementation((signal?: AbortSignal) =>
							signal?.aborted
								? Promise.reject(abortError())
								: Promise.resolve({ variables: [] })
						),
				});
				const res = await smokePage(client, {}, controller.signal);
				expect(res.isError).toBeFalsy();
				expect(namesOf(res)).toEqual(["req 1"]);
				expect(pagedOf(res).cancelled).toBe(true);
			});

			test("a cancelled result validates against the advertised output schema, field for field", async () => {
				const controller = new AbortController();
				const client = pagedClient(3, {
					executeRequest: executeUntil(1, () => {
						controller.abort();
						return Promise.reject(abortError());
					}),
				});
				const res = await smokePage(client, {}, controller.signal);
				const outputSchema = TOOLS.find(
					(t) => t.name === "run_collection_smoke"
				)!.outputSchema!;
				expect(() => outputSchema.parse(res.structuredContent)).not.toThrow();
				const advertised = z.toJSONSchema(outputSchema, { io: "output" }) as unknown as {
					properties: Record<string, unknown>;
				};
				const returned = Object.keys(res.structuredContent!);
				expect(returned).toContain("cancelled");
				expect(Object.keys(advertised.properties)).toEqual(
					expect.arrayContaining(returned)
				);
			});
		});
	});

	test("the description states the page size and how to page", () => {
		const text = descriptionOf(TOOLS.find((t) => t.name === "run_collection_smoke"));
		expect(text).toMatch(/25 requests a call by default \(`limit`, max 100\)/);
		expect(text).toMatch(/page with `offset`/);
		expect(text).toMatch(/edited between pages shifts the window/);
	});
});
