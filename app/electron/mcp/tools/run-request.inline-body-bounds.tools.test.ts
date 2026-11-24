/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test, vi } from "vitest";
import { dispatchTool, MAX_INLINE_BODY_BYTES, MAX_REPORT_TRACE_BYTES, TOOLS } from "../tools.js";
import type { EngineClient } from "../engine-client.js";
import {
	descriptionOf,
	advertisedOutputSchema,
	outputMemberDescription,
	declaredPaths,
	presentPaths,
	fakeClient,
	ctxWith,
	firstText,
} from "../tools.testkit.js";

/**
 * A declared `outputSchema` makes the SDK reject any non-error result whose
 * `structuredContent` does not validate, and that rejection reads as the tool's
 * schema being broken - hiding the body. So every 200 the engine can answer
 * with must produce a result the schema accepts.
 */
/**
 * Inline body bounds (issue #767).
 *
 * `run_request` and `get_run_report` were raw passthroughs, and an ordinary
 * page fetch came back as 1.3M characters - over the tool-result token limit,
 * so the agent got an error instead of a response. The bound lives here rather
 * than in the engine: full fidelity is right for a person clicking Send, and
 * what is being violated is specific to a result feeding a context window.
 */
describe("inline body bounds", () => {
	const allow = { allowlist: ["api.example.com"] };
	const huge = "x".repeat(MAX_INLINE_BODY_BYTES + 5_000);

	/** A `/execute` answer in the shape `serialize(Response)` emits. */
	function executeAnswer(over: Record<string, unknown>) {
		return {
			status: 200,
			statusText: "OK",
			headers: { "content-type": "application/json" },
			requestHeaders: {},
			bodySize: 128,
			httpVersion: "2",
			httpVersionDowngraded: false,
			body: null,
			bodyRaw: "",
			timing: { totalMs: 12 },
			...over,
		};
	}

	function executed(answer: Record<string, unknown>) {
		return fakeClient({ executeRequest: vi.fn().mockResolvedValue(answer) });
	}

	async function runRequest(client: EngineClient) {
		const res = await dispatchTool(
			"run_request",
			{ url: "https://api.example.com/x" },
			ctxWith(client, allow)
		);
		expect(res.isError).toBeFalsy();
		return JSON.parse(firstText(res)) as Record<string, unknown>;
	}

	test("run_request cuts an oversized body and states its real size", async () => {
		const answer = executeAnswer({ bodyRaw: huge, bodySize: huge.length });
		const out = await runRequest(executed(answer));

		expect(Buffer.byteLength(out.bodyRaw as string, "utf8")).toBe(MAX_INLINE_BODY_BYTES);
		expect(out.bodyTruncated).toBe(true);
		// The engine's own count, not the size of the slice we kept - the whole
		// point of the flag is to say how much was not sent.
		expect(out.bodySize).toBe(huge.length);
	});

	// Mutation check (#3704): drop `runId` / `resultId` from the bounded answer
	// (delete them in `boundExecuteResponse`) and both cases fail; the cut one is
	// the answer an agent needs them on, to page the body with read_body.
	test.each([
		["cut", huge],
		["whole", "{}"],
	])("run_request names the stored send on a %s body", async (_case, bodyRaw) => {
		const answer = executeAnswer({ runId: "run_7", resultId: 42, bodyRaw });
		const out = await runRequest(executed(answer));
		expect(out.runId).toBe("run_7");
		expect(out.resultId).toBe(42);
	});

	test("run_request leaves a body under the bound byte-for-byte", async () => {
		const small = JSON.stringify({ userId: 1, id: 5, completed: false });
		const answer = executeAnswer({
			body: { userId: 1, id: 5, completed: false },
			bodyRaw: small,
			bodySize: small.length,
		});
		const out = await runRequest(executed(answer));

		// Exact equality, not a subset: over-truncating an ordinary small
		// response would be its own regression, and so would a stray flag.
		expect(out).toEqual(answer);
		expect(out).not.toHaveProperty("bodyTruncated");
	});

	test("run_request nulls the parsed body once bodyRaw has been cut", async () => {
		const payload = {
			items: Array.from({ length: 4_000 }, (_, i) => ({ i, pad: "xxxxxxxx" })),
		};
		const raw = JSON.stringify(payload);
		expect(raw.length).toBeGreaterThan(MAX_INLINE_BODY_BYTES);
		const out = await runRequest(
			executed(executeAnswer({ body: payload, bodyRaw: raw, bodySize: raw.length }))
		);

		// The doubling case: `body` and `bodyRaw` carry the same payload, so a
		// cut bodyRaw beside an intact parsed body would hand back in full the
		// bytes it just claimed to have dropped.
		expect(out.body).toBeNull();
		expect(out.bodyTruncated).toBe(true);
	});

	test("run_request cuts a large rawRequest but keeps its headers whole", async () => {
		const head = "POST /x HTTP/2\r\nHost: api.example.com\r\nX-Trace: abc\r\n\r\n";
		const out = await runRequest(executed(executeAnswer({ rawRequest: head + huge })));

		const raw = out.rawRequest as string;
		expect(raw.startsWith(head)).toBe(true);
		expect(raw).toContain("X-Trace: abc");
		expect(Buffer.byteLength(raw, "utf8")).toBe(head.length + MAX_INLINE_BODY_BYTES);
		expect(out.rawRequestTruncated).toBe(true);
		expect(out.rawRequestBytes).toBe(head.length + huge.length);
	});

	test("run_request does not touch a headers-only rawRequest", async () => {
		const answer = executeAnswer({ rawRequest: "GET /x HTTP/2\r\nHost: api.example.com\r\n" });
		expect(await runRequest(executed(answer))).toEqual(answer);
	});

	test("run_request keeps the engine's bodyCapped distinct from its own cut", async () => {
		// Two different facts about one body (issue #1157). `bodyTruncated` is
		// this result showing less than the engine returned - read_body pages the
		// rest out of the stored trace. `bodyCapped` is the engine never having read more,
		// which a re-send reproduces. An agent that saw only the first flag would
		// keep re-sending a request that cannot return more.
		const out = await runRequest(
			executed(executeAnswer({ bodyRaw: huge, bodySize: huge.length, bodyCapped: true }))
		);

		expect(out.bodyCapped).toBe(true);
		expect(out.bodyTruncated).toBe(true);
	});

	test("run_request carries bodyCapped: false through untouched", async () => {
		// Always present on the wire, so "not capped" must stay distinguishable
		// from an engine too old to say. The bound must not eat the key.
		const answer = executeAnswer({ bodyRaw: "{}", bodySize: 2, bodyCapped: false });
		const out = await runRequest(executed(answer));

		expect(out).toEqual(answer);
		expect(out.bodyCapped).toBe(false);
	});

	test("the cut never splits a multi-byte character", async () => {
		// Two-byte characters against a bound that is not a multiple of two:
		// a naive byte slice would end mid-character and decode to U+FFFD.
		const out = await runRequest(
			executed(executeAnswer({ bodyRaw: "é".repeat(MAX_INLINE_BODY_BYTES) }))
		);
		expect(out.bodyRaw as string).not.toContain("�");
		expect(Buffer.byteLength(out.bodyRaw as string, "utf8")).toBeLessThanOrEqual(
			MAX_INLINE_BODY_BYTES
		);
	});

	describe("a base64 body (#2458)", () => {
		/** Bytes that are not UTF-8 text, as the engine answers them. */
		const bytesOf = (count: number) =>
			Buffer.from(Array.from({ length: count }, (_, i) => i % 256));
		const base64Answer = (bytes: Buffer) =>
			executeAnswer({
				bodyRaw: bytes.toString("base64"),
				bodyEncoding: "base64",
				bodySize: bytes.length,
				headers: { "content-type": "image/png" },
			});

		test("is cut on a whole 4-character group and still decodes", async () => {
			const bytes = bytesOf(MAX_INLINE_BODY_BYTES + 5_001);
			const out = await runRequest(executed(base64Answer(bytes)));

			const cut = out.bodyRaw as string;
			expect(cut.length % 4).toBe(0);
			// Strict: `atob` throws on a length the groups cannot make up.
			const decoded = Buffer.from(atob(cut), "latin1");
			expect(decoded.length).toBeLessThanOrEqual(MAX_INLINE_BODY_BYTES);
			expect(decoded.length).toBeGreaterThan(MAX_INLINE_BODY_BYTES - 3);
			expect(decoded.equals(bytes.subarray(0, decoded.length))).toBe(true);
			expect(out.bodyEncoding).toBe("base64");
			expect(out.bodyTruncated).toBe(true);
			expect(out.bodySize).toBe(bytes.length);
			expect(out.body).toBeNull();
		});

		test("is bounded by its decoded size, not by its text", async () => {
			// 40,000 characters of base64 over 30,000 bytes: past the bound as
			// text, inside it as the body it is.
			const answer = base64Answer(bytesOf(30_000));
			expect((answer.bodyRaw as string).length).toBeGreaterThan(MAX_INLINE_BODY_BYTES);
			expect(await runRequest(executed(answer))).toEqual(answer);
		});

		test("states its decoded size when the engine sent none", async () => {
			const bytes = bytesOf(MAX_INLINE_BODY_BYTES + 2);
			const answer: Record<string, unknown> = base64Answer(bytes);
			delete answer.bodySize;
			const out = await runRequest(executed(answer));
			// `=` padding carries no bytes: 32,770 bytes end in one `=`.
			expect((answer.bodyRaw as string).endsWith("=")).toBe(true);
			expect(out.bodySize).toBe(bytes.length);
		});

		test("a utf8 answer over the bound is cut as text, its encoding kept", async () => {
			const out = await runRequest(
				executed(
					executeAnswer({ bodyRaw: huge, bodySize: huge.length, bodyEncoding: "utf8" })
				)
			);
			expect(Buffer.byteLength(out.bodyRaw as string, "utf8")).toBe(MAX_INLINE_BODY_BYTES);
			expect(out.bodyEncoding).toBe("utf8");
		});

		test("on a stored trace node is cut the same way, with its decoded size", async () => {
			const bytes = bytesOf(MAX_INLINE_BODY_BYTES + 5_001);
			const out = await runReport(
				reported({
					results: [
						{
							id: 1,
							trace: {
								response: {
									body: bytes.toString("base64"),
									bodyEncoding: "base64",
								},
							},
						},
					],
				})
			);

			const response = (out.results as Row[])[0].trace!.response!;
			const cut = response.body as string;
			expect(cut.length % 4).toBe(0);
			expect(
				Buffer.from(atob(cut), "latin1").equals(bytes.subarray(0, (cut.length / 4) * 3))
			).toBe(true);
			expect(response.bodyEncoding).toBe("base64");
			expect(response.bodyTruncated).toBe(true);
			expect(response.bodyBytes).toBe(bytes.length);
		});
	});

	function reported(report: Record<string, unknown>) {
		return fakeClient({ getRunReport: vi.fn().mockResolvedValue(report) });
	}

	async function runReport(client: EngineClient) {
		const res = await dispatchTool("get_run_report", { runId: "run_1" }, ctxWith(client));
		expect(res.isError).toBeFalsy();
		return JSON.parse(firstText(res)) as Record<string, unknown>;
	}

	type Row = {
		trace?: { request?: Record<string, unknown>; response?: Record<string, unknown> };
	};

	test("get_run_report cuts a stored trace body on every row", async () => {
		const out = await runReport(
			reported({
				summary: {},
				results: [
					{ id: 1, trace: { request: { url: "u" }, response: { body: huge } } },
					{ id: 2, trace: { request: { url: "u" }, response: { body: huge } } },
				],
			})
		);

		// Per row, not just the first: a scenario run carries one trace per step
		// (up to 100 in a report), which is what multiplies this defect.
		for (const row of out.results as Row[]) {
			const response = row.trace!.response!;
			expect(Buffer.byteLength(response.body as string, "utf8")).toBe(MAX_INLINE_BODY_BYTES);
			expect(response.bodyTruncated).toBe(true);
			expect(response.bodyBytes).toBe(huge.length);
		}
	});

	// Mutation check (#3307): have boundRunReport rebuild a bounded trace from its
	// request and response nodes alone and the top-level `warnings` is lost.
	test("get_run_report keeps a stored trace's warnings, also when a body was cut", async () => {
		const warnings = [
			{ code: "cookie_limit_reached", message: "More than 150 cookies matched." },
		];
		const out = await runReport(
			reported({
				summary: {},
				results: [
					{ id: 1, trace: { request: { url: "u" }, response: { body: huge }, warnings } },
				],
			})
		);

		const trace = (out.results as Array<{ trace: Record<string, unknown> }>)[0].trace;
		expect(trace.warnings).toEqual(warnings);
		expect((trace.response as Record<string, unknown>).bodyTruncated).toBe(true);
	});

	// Mutation check (#2820): have boundRunReport or markPartialReport rebuild the
	// report without its `scenario` section and this fails.
	test("get_run_report hands a scenario load report's assertions through unchanged", async () => {
		const scenario = { passed: 4590, failed: 0, assertions: { passed: 10, failed: 4580 } };
		const out = await runReport(reported({ summary: { errorRate: 0 }, scenario, results: [] }));

		expect(out.scenario).toEqual(scenario);
	});

	// Mutation check (#3127): have boundRunReport or markPartialReport rebuild the
	// report without its element rows' `messages` / `console`, or strip
	// `failureCounts` off the validation row's trace, and this fails.
	test("get_run_report hands an element row's messages and the replay's failure counts through", async () => {
		const element = {
			id: "el_4",
			kind: "script.post",
			passed: 0,
			failed: 0,
			error: 480,
			skipped: 0,
			messages: [{ kind: "test", text: "status is 201: expected 200 to equal 201" }],
			messagesDropped: 3,
			console: [{ level: "warn", text: "saw 200" }],
			consoleDropped: 37,
		};
		const scenario = { steps: [{ index: 0, elements: [element] }] };
		const validationRow = {
			statusCode: 0,
			trace: {
				failures: ["status is 200: expected 404 to equal 200"],
				failureCounts: [3],
				failuresDistinct: 1,
				totalFailed: 3,
				totalPassed: 0,
			},
		};
		const out = await runReport(
			reported({
				summary: { errorRate: 0, elements: [element] },
				scenario,
				results: [validationRow],
			})
		);

		expect(out.scenario).toEqual(scenario);
		expect((out.summary as { elements: unknown[] }).elements).toEqual([element]);
		expect((out.results as unknown[])[0]).toEqual(validationRow);
	});

	test("get_run_report keeps the engine's own bodyBytes when it already truncated", async () => {
		const out = await runReport(
			reported({
				results: [
					{
						id: 1,
						trace: {
							// What a trace the engine cut at maxTraceBodyBytes looks
							// like: a 5MB slice that records the true original size.
							response: { body: huge, bodyTruncated: true, bodyBytes: 40_000_000 },
						},
					},
				],
			})
		);

		const response = (out.results as Row[])[0].trace!.response!;
		expect(response.bodyBytes).toBe(40_000_000);
	});

	test("get_run_report bounds the request side too", async () => {
		const head = "POST /x HTTP/2\r\nHost: api.example.com\r\n\r\n";
		const out = await runReport(
			reported({
				results: [{ id: 1, trace: { request: { body: huge, rawRequest: head + huge } } }],
			})
		);

		const request = (out.results as Row[])[0].trace!.request!;
		expect(Buffer.byteLength(request.body as string, "utf8")).toBe(MAX_INLINE_BODY_BYTES);
		expect(request.bodyTruncated).toBe(true);
		expect(Buffer.byteLength(request.rawRequest as string, "utf8")).toBe(
			head.length + MAX_INLINE_BODY_BYTES
		);
		expect(request.rawRequestTruncated).toBe(true);
	});

	test("a load-mode report passes through untouched", async () => {
		// A load run's results never go through build_result_trace, so they
		// carry no trace node - exact equality proves the walk added nothing.
		const report = {
			summary: { totalRequests: 5_000 },
			latency: { p95: 12 },
			results: [
				{ id: 1, statusCode: 200, latencyMs: 4 },
				{ id: 2, statusCode: 500, latencyMs: 9, error: "timeout" },
			],
		};
		expect(await runReport(reported(report))).toEqual(report);
	});

	test("a design report under the bound passes through untouched", async () => {
		const report = {
			summary: {},
			results: [
				{ id: 1, trace: { request: { url: "u" }, response: { body: '{"ok":true}' } } },
			],
		};
		expect(await runReport(reported(report))).toEqual(report);
	});

	/**
	 * The scenario shape, pinned ahead of `run_collection` (#754 / PR #765).
	 *
	 * A scenario step is written through the same pair a single `/execute` uses
	 * - `build_result_trace` then `cap_trace_bodies`
	 * (`scenario_runner.cpp:678-689`) - into the same `results.trace_data`
	 * column (`scenario_runner.cpp:715`) that `/runs/:id/report` parses back
	 * into `results[].trace`. So one scenario report carries one such trace per
	 * step, up to the report route's 100-row cap, instead of the single trace
	 * reproduced in #767. This fixture is that shape: step identity stamped on
	 * the trace beside the nodes, and a skipped step whose `response` the
	 * runner erased.
	 */
	test("a scenario report is bounded per step, skipped steps included", async () => {
		const out = await runReport(
			reported({
				summary: {},
				scenario: { iterations: 1, steps: [{ index: 0, name: "login", executed: 1 }] },
				results: [
					{
						id: 1,
						trace: {
							iteration: 0,
							stepIndex: 0,
							stepName: "login",
							outcome: "passed",
							request: { url: "u" },
							response: { body: huge },
						},
					},
					{
						id: 2,
						trace: {
							iteration: 0,
							stepIndex: 1,
							stepName: "checkout",
							outcome: "skipped",
							// No `response` node at all: the runner erases it for a
							// step that never sent.
							request: { body: huge },
						},
					},
				],
			})
		);

		const rows = out.results as Array<Row & { trace: Record<string, unknown> }>;
		expect(Buffer.byteLength(rows[0].trace.response!.body as string, "utf8")).toBe(
			MAX_INLINE_BODY_BYTES
		);
		expect(rows[0].trace.response!.bodyBytes).toBe(huge.length);
		// Identity survives the rebuild - the step list reads these.
		expect(rows[0].trace.stepName).toBe("login");
		// The skipped step's request is bounded, and no empty `response` is
		// invented for it: an erased node must stay erased, or the step's
		// expanded view reads as a server that answered with nothing.
		expect(Buffer.byteLength(rows[1].trace.request!.body as string, "utf8")).toBe(
			MAX_INLINE_BODY_BYTES
		);
		expect(rows[1].trace).not.toHaveProperty("response");
	});

	test("both tool descriptions state the bound, and each names its cut flag", () => {
		for (const name of ["run_request", "get_run_report"]) {
			const description = descriptionOf(TOOLS.find((t) => t.name === name));
			expect(description).toContain(String(MAX_INLINE_BODY_BYTES));
		}
		// Both declare their flag on the output schema (#3749).
		expect(outputMemberDescription("run_request", "bodyTruncated")).toMatch(/cut to the cap/);
		expect(
			outputMemberDescription("get_run_report", "results[].trace.response.bodyTruncated")
		).toMatch(/read_body/);
	});

	test("run_request's description tells the two body flags apart", () => {
		// The flags are one word apart and mean opposite things about what a
		// re-send would achieve, so the description has to name both and say
		// which remedy belongs to which.
		const description = descriptionOf(TOOLS.find((t) => t.name === "run_request"));
		expect(description).toMatch(/`bodyCapped` is not `bodyTruncated`/);
		expect(description).toMatch(/maxDesignResponseBodyBytes/);
	});

	describe("run_request's output schema (#3749)", () => {
		const schema = () => TOOLS.find((t) => t.name === "run_request")!.outputSchema!;
		const base64PastCap = "AAEC".repeat(MAX_INLINE_BODY_BYTES);
		const exchange = executeAnswer({
			body: { ok: true },
			bodyRaw: '{"ok":true}',
			bodyEncoding: "utf8",
			bodySize: 11,
			bodyCapped: false,
			headerLines: [{ name: "Set-Cookie", value: "a=1" }],
			requestHeaders: { Accept: "*/*" },
			requestHeaderLines: [{ name: "Accept", value: "*/*" }],
			redirects: [
				{
					status: 302,
					statusText: "Found",
					url: "https://api.example.com/x",
					schemeDowngrade: false,
					headerLines: [],
				},
			],
			rawRequest: `POST /x HTTP/1.1\r\nHost: api.example.com\r\n\r\n${huge}`,
			runId: "run_d",
			resultId: 7,
			mcp: { errorClass: "protocol", code: -32601, message: "Method not found" },
		});
		const capped = executeAnswer({ bodyRaw: huge, bodySize: huge.length, bodyCapped: true });
		const base64 = executeAnswer({ bodyRaw: base64PastCap, bodyEncoding: "base64" });
		const streamStarted = { runId: "run_s", eventsUrl: "/runs/run_s/events" };
		const streamRead = { events: [{ event: "tick" }], completed: true, capReached: false };

		/** Each answer path the handler has, with the call that reaches it. */
		const sends: [
			string,
			Record<string, unknown>,
			Partial<Record<keyof EngineClient, unknown>>,
		][] = [
			["buffered", {}, { executeRequest: vi.fn().mockResolvedValue(exchange) }],
			[
				"link-only",
				{ requestId: "req_1" },
				{ executeRequest: vi.fn().mockResolvedValue(exchange) },
			],
			["body-capped", {}, { executeRequest: vi.fn().mockResolvedValue(capped) }],
			["base64", {}, { executeRequest: vi.fn().mockResolvedValue(base64) }],
			["non-object", {}, { executeRequest: vi.fn().mockResolvedValue("not an object") }],
			[
				"streamed",
				{ stream: true },
				{
					executeRequest: vi.fn().mockResolvedValue(streamStarted),
					consumeStreamEvents: vi.fn().mockResolvedValue(streamRead),
				},
			],
			[
				"stream without a runId",
				{ stream: true },
				{ executeRequest: vi.fn().mockResolvedValue({ status: 200 }) },
			],
		];

		async function send(args: Record<string, unknown>, client: EngineClient) {
			const res = await dispatchTool(
				"run_request",
				{ url: "https://api.example.com/x", ...args },
				ctxWith(client, allow)
			);
			expect(res.isError).toBeFalsy();
			return res;
		}

		// Mutation check: rename a member in runRequestResultSchema, or drop
		// `structured: true` from the buffered send, and this fails.
		test("every answer satisfies it, and every member it declares reaches the agent", async () => {
			const present = new Set<string>();
			for (const [name, args, overrides] of sends) {
				const res = await send(args, fakeClient(overrides));
				expect(schema().safeParse(res.structuredContent).success, name).toBe(true);
				for (const path of presentPaths(res.structuredContent)) present.add(path);
			}

			const declared = declaredPaths(advertisedOutputSchema("run_request"));
			expect(declared.length).toBeGreaterThan(10);
			expect(declared.filter((path) => !present.has(path))).toEqual([]);
		});

		// Mutation check: drop `mcp` from runRequestResultSchema and the declared
		// -member lookups below throw. The answer is a loose object, so only a
		// lookup of the advertised schema sees the member go (#3809).
		test.each([
			["tool", { errorClass: "tool", message: "quota exceeded" }, false],
			[
				"protocol",
				{ errorClass: "protocol", code: -32601, message: "Method not found" },
				true,
			],
		])("a %s-class mcp failure reaches the agent", async (_name, mcp, hasCode) => {
			const res = await send(
				{},
				fakeClient({ executeRequest: vi.fn().mockResolvedValue(executeAnswer({ mcp })) })
			);
			expect(schema().safeParse(res.structuredContent).success).toBe(true);
			const node = (res.structuredContent as { mcp: Record<string, unknown> }).mcp;
			expect(node).toEqual(mcp);
			expect("code" in node).toBe(hasCode);
			for (const member of ["mcp", "mcp.errorClass", "mcp.code", "mcp.message"]) {
				expect(outputMemberDescription("run_request", member)).toBeDefined();
			}
		});

		test("an mcp request that succeeded carries the engine's empty node", async () => {
			const res = await send(
				{},
				fakeClient({
					executeRequest: vi.fn().mockResolvedValue(executeAnswer({ mcp: {} })),
				})
			);
			expect(schema().safeParse(res.structuredContent).success).toBe(true);
			expect((res.structuredContent as { mcp: unknown }).mcp).toEqual({});
		});

		// Mutation check: drop boundExecuteResponse from the no-runId branch of
		// runStreamingRequest and this fails.
		test("a streamed send answered without a runId bounds its body", async () => {
			const bodyRaw = "x".repeat(40_000);
			const res = await send(
				{ stream: true },
				fakeClient({
					executeRequest: vi
						.fn()
						.mockResolvedValue({ status: 200, body: bodyRaw, bodyRaw }),
				})
			);
			const out = res.structuredContent as Record<string, unknown>;
			expect(out.bodyTruncated).toBe(true);
			expect(out.body).toBeNull();
			expect((out.bodyRaw as string).length).toBeLessThanOrEqual(32 * 1024);
		});

		test("the text block is the structured answer, and a link-only send keeps its caveat", async () => {
			const res = await send({ requestId: "req_1" }, executed(exchange));
			expect(JSON.parse(firstText(res))).toEqual(res.structuredContent);
			expect(res.content[1]?.text).toMatch(/sent ad hoc/);
		});
	});

	/**
	 * The total bound (issue #769).
	 *
	 * The per-node bound does not bound the result: `results[]` holds up to 100
	 * rows and each keeps up to `MAX_INLINE_BODY_BYTES` per node, so a 100-step
	 * scenario measured 3.3M characters with every node correctly flagged as
	 * truncated - 2.5x the 1.3M that failed in #767. At that row count even an
	 * 8KB body, never touched by the per-node cut, totalled 845K.
	 */
	describe("total trace budget", () => {
		/** A scenario row in the shape `stamp_step_identity` writes. */
		function step(index: number, outcome: string, body: string) {
			return {
				id: index + 1,
				statusCode: outcome === "passed" ? 200 : 500,
				latencyMs: 4,
				trace: {
					iteration: 0,
					stepIndex: index,
					stepName: `step-${index}`,
					outcome,
					response: { body },
				},
			};
		}

		function scenarioReport(rows: unknown[]) {
			return { summary: {}, scenario: { stepsStored: rows.length }, results: rows };
		}

		test("a 100-step report of oversized bodies comes back inside the budget", async () => {
			const out = await runReport(
				reported(
					scenarioReport(Array.from({ length: 100 }, (_, i) => step(i, "passed", huge)))
				)
			);

			const rows = out.results as Array<Record<string, unknown>>;
			expect(rows).toHaveLength(100);
			const embedded = rows.filter((row) => row.trace !== undefined);
			const carried = embedded.reduce(
				(sum, row) => sum + Buffer.byteLength(JSON.stringify(row.trace), "utf8"),
				0
			);
			expect(carried).toBeLessThanOrEqual(MAX_REPORT_TRACE_BYTES);
			// The whole result, which is what actually reaches the agent: the
			// pre-fix measurement for this exact fixture was 3,328,454 characters.
			expect(JSON.stringify(out).length).toBeLessThan(200_000);
		});

		test("what was dropped is disclosed on the row and on the report", async () => {
			const out = await runReport(
				reported(
					scenarioReport(Array.from({ length: 100 }, (_, i) => step(i, "passed", huge)))
				)
			);

			const rows = out.results as Array<Record<string, unknown>>;
			const dropped = rows.filter((row) => row.traceOmitted === true);
			expect(dropped.length).toBeGreaterThan(0);
			expect(out.tracesOmitted).toBe(dropped.length);
			expect(out.traceBudgetBytes).toBe(MAX_REPORT_TRACE_BYTES);
			// A dropped row keeps everything that is not the trace - the run's
			// shape is the answer even when the payloads cannot come along.
			expect(dropped[0]).toMatchObject({ statusCode: 200, latencyMs: 4 });
			expect(dropped[0]).not.toHaveProperty("trace");
		});

		test("non-passing steps keep their traces first", async () => {
			// Failures last in run order, so a first-come budget would drop
			// exactly them - which is the engine's rule for `stepsStored`
			// (`ScenarioStepStore::add`) read backwards.
			const rows = [
				...Array.from({ length: 40 }, (_, i) => step(i, "passed", huge)),
				step(40, "failed", huge),
				step(41, "errored", huge),
			];
			const out = await runReport(reported(scenarioReport(rows)));

			const results = out.results as Array<Record<string, unknown>>;
			expect(results).toHaveLength(42);
			// Row order is the run's, not the budget's.
			expect((results[40].trace as Record<string, unknown>).outcome).toBe("failed");
			expect((results[41].trace as Record<string, unknown>).outcome).toBe("errored");
			expect(results[40]).not.toHaveProperty("traceOmitted");
			expect(results[41]).not.toHaveProperty("traceOmitted");
			expect(out.tracesOmitted).toBeGreaterThan(0);
		});

		test("a single oversized row keeps its trace whatever it costs", async () => {
			// The #767 case itself: a design report is one row, and a budget that
			// dropped it would answer nothing at all.
			const out = await runReport(
				reported({
					summary: {},
					results: [
						{
							id: 1,
							trace: {
								request: {
									body: huge,
									rawRequest: `POST /x HTTP/2\r\n\r\n${huge}`,
								},
								response: { body: huge },
							},
						},
					],
				})
			);

			const row = (out.results as Row[])[0];
			expect(Buffer.byteLength(row.trace!.response!.body as string, "utf8")).toBe(
				MAX_INLINE_BODY_BYTES
			);
			expect(out).not.toHaveProperty("tracesOmitted");
		});

		test("a report inside the budget is byte-for-byte unchanged", async () => {
			// Under the per-node bound and under the total: nothing added, no
			// disclosure invented, exactly the object the engine returned.
			const report = scenarioReport(
				Array.from({ length: 30 }, (_, i) => step(i, "passed", '{"ok":true}'))
			);
			expect(await runReport(reported(report))).toEqual(report);
		});

		test("rows carrying no trace are never counted or flagged", async () => {
			// A load report has no traces at all, so there is nothing to omit -
			// the budget must not invent a disclosure for rows it cannot spend on.
			const report = {
				summary: { totalRequests: 5_000 },
				results: Array.from({ length: 100 }, (_, i) => ({
					id: i,
					statusCode: 200,
					latencyMs: 4,
				})),
			};
			expect(await runReport(reported(report))).toEqual(report);
		});

		test("the tool description states the total bound and the output schema its disclosure", () => {
			const description = descriptionOf(TOOLS.find((t) => t.name === "get_run_report"));
			expect(description).toContain(String(MAX_REPORT_TRACE_BYTES));
			expect(outputMemberDescription("get_run_report", "results[].traceOmitted")).toMatch(
				/trace budget/
			);
			expect(outputMemberDescription("get_run_report", "tracesOmitted")).toMatch(
				/traceOmitted.*traceBudgetBytes/
			);
		});
	});
});
