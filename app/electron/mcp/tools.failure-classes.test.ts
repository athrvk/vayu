/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import { dispatchTool, INLINE_FILE_REFUSAL, TOOLS, type ToolResult } from "./tools.js";
import type { McpHost } from "./tools/contract.js";
import { EngineRequestError, EngineTimeoutError, type EngineClient } from "./engine-client.js";
import { resolveRemedyTokens } from "./remedy.js";
import { fakeClient, ctxWith, firstText, engineErrorBody } from "./tools.testkit.js";

/**
 * An abort is the one transport failure that means the engine *was* reachable
 * and busy: it may already have sent the request and written the run row. The
 * old handling matched `/abort/i` alongside ECONNREFUSED and answered "engine
 * not running, retry", which is wrong twice over and talks an agent into
 * re-firing a request that already ran.
 */
describe("engine transport failures are told apart", () => {
	async function runRequestFailingWith(err: unknown, host: McpHost = "app") {
		const client = fakeClient({ executeRequest: vi.fn().mockRejectedValue(err) });
		return dispatchTool(
			"run_request",
			{ url: "https://api.example.com/slow" },
			ctxWith(client, { allowlist: ["api.example.com"] }, host)
		);
	}

	test("a client-budget timeout names the budget and sends the agent to run history", async () => {
		const res = await runRequestFailingWith(
			new EngineTimeoutError("POST", "/execute", 130_000)
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/130s budget/);
		expect(firstText(res)).toMatch(/may still have completed/i);
		expect(firstText(res)).toMatch(/list_runs/);
		expect(firstText(res)).not.toMatch(/its engine is not answering/);
	});

	test("a cancelled call is not reported as an unreachable engine either", async () => {
		const res = await runRequestFailingWith(
			new DOMException("The operation was aborted.", "AbortError")
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/cancelled/i);
		expect(firstText(res)).toMatch(/list_runs/);
		expect(firstText(res)).not.toMatch(/its engine is not answering/);
	});

	test("a genuinely unreachable engine says so, naming the app for the app host", async () => {
		const res = await runRequestFailingWith(
			new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:9876"),
			"app"
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/Vayu app is open but its engine is not answering/);
		expect(firstText(res)).not.toMatch(/make sure|start the/i);
	});

	test("a genuinely unreachable engine says so, naming the process for the CLI host", async () => {
		const res = await runRequestFailingWith(
			new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:9876"),
			"cli"
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/Start vayu-engine, or point VAYU_ENGINE_URL/);
		expect(firstText(res)).not.toMatch(/Vayu app/);
	});
});

/*
 * A call that timed out or was cancelled may have taken effect, and what to do
 * about that is a fact about the tool (#2777): a create must be looked for in
 * its list before it is repeated, a read can simply be repeated, a send goes
 * through run history.
 */
describe("an interrupted call is told what to check, per tool", () => {
	const TIMEOUT = () => new EngineTimeoutError("POST", "/anything", 35_000);
	const ABORT = () => new DOMException("The operation was aborted.", "AbortError");
	const ALLOWED = { allowWrites: true, allowlist: ["api.example.com"] };

	const createRequestArgs = { collectionId: "c1", name: "Ping", url: "https://api.example.com/" };

	async function interrupted(
		name: string,
		args: Record<string, unknown>,
		method: keyof EngineClient,
		err: unknown
	) {
		const client = fakeClient({ [method]: vi.fn().mockRejectedValue(err) });
		return dispatchTool(name, args, ctxWith(client, ALLOWED));
	}

	describe.each([
		["a timeout", TIMEOUT],
		["a cancelled call", ABORT],
	])("%s", (_label, makeErr) => {
		test("on create_request names list_requests and warns against a blind retry", async () => {
			const res = await interrupted(
				"create_request",
				createRequestArgs,
				"createRequest",
				makeErr()
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/list_requests/);
			expect(firstText(res)).toMatch(/do not retry blindly/);
			expect(firstText(res)).not.toMatch(/list_runs/);
			const advice = (res.structuredContent as { error: { advice: string } }).error.advice;
			expect(advice).toBe(firstText(res));
		});

		test("on import_document names list_collections", async () => {
			const res = await interrupted(
				"import_document",
				{ content: "{}" },
				"importDocument",
				makeErr()
			);
			expect(firstText(res)).toMatch(/list_collections/);
			expect(firstText(res)).not.toMatch(/list_runs/);
		});

		test("on run_request still names list_runs", async () => {
			const res = await interrupted(
				"run_request",
				{ url: "https://api.example.com/slow" },
				"executeRequest",
				makeErr()
			);
			expect(firstText(res)).toMatch(/list_runs/);
		});

		test.each([
			// Declares "safe": a read without the idempotent hint.
			["get_live_metrics", { runId: "run_a" }, "getLiveMetricsSnapshot"],
			// Declares nothing and is annotated idempotent, so it is told "safe".
			["update_engine_config", { entries: {} }, "updateConfig"],
		] as Array<[string, Record<string, unknown>, keyof EngineClient]>)(
			"on %s says repeating it is safe",
			async (name, args, method) => {
				const res = await interrupted(name, args, method, makeErr());
				expect(firstText(res)).toMatch(/Repeating the call is safe/);
				expect(firstText(res)).not.toMatch(/list_runs/);
			}
		);
	});

	test("keeps the timeout's budget and the raise-the-ceiling tail beside the advice", async () => {
		const res = await interrupted(
			"create_request",
			createRequestArgs,
			"createRequest",
			TIMEOUT()
		);
		expect(firstText(res)).toMatch(/35s budget/);
		expect(firstText(res)).toMatch(/update_engine_config/);
	});

	test("a tool that declares no advice gets the generic run-history wording", async () => {
		const bare = {
			...TOOLS.find((t) => t.name === "run_request")!,
			name: "bare",
			retry: undefined,
		};
		TOOLS.push(bare);
		try {
			const res = await interrupted(
				"bare",
				{ url: "https://api.example.com/slow" },
				"executeRequest",
				TIMEOUT()
			);
			expect(firstText(res)).toMatch(/check run history \(list_runs\)/);
		} finally {
			TOOLS.pop();
		}
	});

	test("every tool that is not idempotent declares what to check", () => {
		const scanned = TOOLS.filter((t) => t.annotations.idempotentHint !== true);
		expect(scanned.length).toBeGreaterThan(0);
		const undeclared = scanned.filter((t) => t.retry === undefined).map((t) => t.name);
		expect(undeclared).toEqual([]);
	});

	test("a check names a tool that exists and is a read", () => {
		const checks = TOOLS.flatMap((t) => (typeof t.retry === "object" ? [t.retry.check] : []));
		expect(checks.length).toBeGreaterThan(0);
		for (const check of checks) {
			const tool = TOOLS.find((t) => t.name === check);
			expect(tool, check).toBeDefined();
			expect(tool?.category, check).toBe("read");
		}
	});
});

/*
 * Every error result carries `structuredContent.error` (#2776): the class an
 * agent acts on, whether the same call can succeed again, and the advice, which
 * is the result's own text.
 */
describe("every error result carries a failure class", () => {
	const ALLOWED = { allowlist: ["api.example.com"] };

	/** `run_request` against an allowed host, its send failing with @p err. */
	const sendFailingWith = (err: unknown) =>
		dispatchTool(
			"run_request",
			{ url: "https://api.example.com/x" },
			ctxWith(fakeClient({ executeRequest: vi.fn().mockRejectedValue(err) }), ALLOWED)
		);
	const engineAnswered = (status: number, body: string) =>
		sendFailingWith(new EngineRequestError(`Engine responded ${status}`, status, body));

	const cases: Array<[string, string, () => Promise<ToolResult>]> = [
		[
			"a host off the allowlist",
			"policy",
			() =>
				dispatchTool(
					"run_request",
					{ url: "https://elsewhere.example.com/" },
					ctxWith(fakeClient(), ALLOWED)
				),
		],
		[
			"a load run over the concurrency cap",
			"policy",
			() =>
				dispatchTool(
					"start_load_run",
					{ url: "https://api.example.com/", concurrency: 100_000, duration: "10s" },
					ctxWith(fakeClient(), ALLOWED)
				),
		],
		[
			"a load run whose duration is not one",
			"input",
			() =>
				dispatchTool(
					"start_load_run",
					{ url: "https://api.example.com/", concurrency: 1, duration: "forever" },
					ctxWith(fakeClient(), ALLOWED)
				),
		],
		[
			"a write while writes are off",
			"policy",
			() => dispatchTool("create_collection", { name: "API" }, ctxWith(fakeClient())),
		],
		[
			"a tool switched off in Settings",
			"policy",
			() =>
				dispatchTool(
					"get_engine_health",
					{},
					ctxWith(fakeClient(), { disabledTools: ["get_engine_health"] })
				),
		],
		[
			// The stdio CLI never has a window, so calling again cannot help.
			"no Vayu window to ask",
			"policy",
			() => dispatchTool("get_app_focus", {}, ctxWith(fakeClient())),
		],
		[
			"a file body sent inline",
			"policy",
			() =>
				dispatchTool(
					"run_request",
					{ url: "https://api.example.com/", bodyType: "binary" },
					ctxWith(fakeClient(), ALLOWED)
				),
		],
		[
			"an engine target-policy refusal",
			"policy",
			() =>
				engineAnswered(
					400,
					engineErrorBody("target_not_allowed", 'Host "evil.example.com" is not allowed.')
				),
		],
		["an engine 403", "policy", () => engineAnswered(403, "forbidden")],
		["an engine 400", "input", () => engineAnswered(400, "bad request")],
		["an engine 409", "input", () => engineAnswered(409, "already exists")],
		["an engine 413", "input", () => engineAnswered(413, "too large")],
		[
			"a missing required argument",
			"input",
			() => dispatchTool("get_run", {}, ctxWith(fakeClient())),
		],
		["an unknown tool", "input", () => dispatchTool("no_such_tool", {}, ctxWith(fakeClient()))],
		["an engine 404", "not_found", () => engineAnswered(404, "not found")],
		[
			"a run id the engine does not hold",
			"not_found",
			() =>
				dispatchTool(
					"get_run",
					{ runId: "run_gone" },
					ctxWith(
						fakeClient({
							getRun: vi
								.fn()
								.mockRejectedValue(
									new EngineRequestError("Engine responded 404", 404, "")
								),
						})
					)
				),
		],
		[
			"a saved request id compose does not hold",
			"not_found",
			() =>
				dispatchTool(
					"run_request",
					{ requestId: "req_gone" },
					ctxWith(
						fakeClient({
							composeRequest: vi
								.fn()
								.mockRejectedValue(
									new EngineRequestError("Engine responded 404", 404, "")
								),
						}),
						ALLOWED
					)
				),
		],
		[
			"a client-budget timeout",
			"transient",
			() => sendFailingWith(new EngineTimeoutError("POST", "/execute", 130_000)),
		],
		[
			"a cancelled call",
			"transient",
			() => sendFailingWith(new DOMException("The operation was aborted.", "AbortError")),
		],
		["an engine 500", "transient", () => engineAnswered(500, "boom")],
		["an engine 507", "transient", () => engineAnswered(507, "disk full")],
		[
			"a busy database",
			"transient",
			() => engineAnswered(503, engineErrorBody("unavailable", "The database is busy")),
		],
		[
			"an unclassified transport error",
			"transient",
			() => sendFailingWith(new Error("socket hang up")),
		],
		[
			"a handler that threw",
			"transient",
			() =>
				dispatchTool(
					"get_app_focus",
					{},
					{
						...ctxWith(fakeClient()),
						appFocus: () => {
							throw new Error("window gone mid-read");
						},
					}
				),
		],
		[
			"a masking lookup that failed",
			"transient",
			() =>
				dispatchTool(
					"run_request",
					{ url: "https://api.example.com/" },
					ctxWith(
						fakeClient({
							executeRequest: vi
								.fn()
								.mockResolvedValue({ status: 200, bodyRaw: "ok" }),
							getGlobals: vi
								.fn()
								.mockRejectedValue(new Error("Engine responded 500")),
						}),
						ALLOWED
					)
				),
		],
		[
			"an engine that refused the connection",
			"unreachable",
			() =>
				sendFailingWith(new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:9876")),
		],
		[
			"an engine shutting down",
			"unreachable",
			() => engineAnswered(503, engineErrorBody("unavailable", "Engine is shutting down")),
		],
	];

	const RETRYABLE = new Set(["transient", "unreachable"]);

	test.each(cases)("%s is %s", async (_, failureClass, call) => {
		const res = await call();
		expect(res.isError).toBe(true);
		expect(res.structuredContent).toEqual({
			error: {
				class: failureClass,
				retryable: RETRYABLE.has(failureClass),
				advice: firstText(res),
			},
		});
	});

	test("the advice is the remedy-resolved text, not the token", async () => {
		const res = await dispatchTool(
			"run_request",
			{ url: "https://api.example.com/", bodyType: "binary" },
			ctxWith(fakeClient(), ALLOWED, "cli")
		);
		const error = (res.structuredContent as { error: { advice: string } }).error;
		expect(error.advice).toBe(resolveRemedyTokens(INLINE_FILE_REFUSAL, "cli"));
		expect(error.advice).not.toMatch(/\{\{remedy:/);
	});

	test("a caveat appended to an error keeps the error's class", async () => {
		const res = await dispatchTool(
			"run_request",
			{ url: "https://api.example.com/", requestId: "req_1" },
			ctxWith(
				fakeClient({
					executeRequest: vi
						.fn()
						.mockRejectedValue(new TypeError("fetch failed: connect ECONNREFUSED")),
				}),
				ALLOWED
			)
		);
		expect(res.content.length).toBe(2);
		expect(res.structuredContent).toMatchObject({ error: { class: "unreachable" } });
	});

	test("a success carries no failure", async () => {
		const res = await dispatchTool("get_engine_health", {}, ctxWith(fakeClient()));
		expect(res.isError).toBeFalsy();
		expect(res.structuredContent).not.toHaveProperty("error");
	});

	/*
	 * `errorResult` is what records the class, so an error result assembled by
	 * hand would reach dispatch unclassed and be answered with a guess. The one
	 * other builder is dispatch's own answer, made from the recorded class.
	 */
	test("no source builds an error result except errorResult and dispatch", () => {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const sources = readdirSync(here, { recursive: true, encoding: "utf8" }).filter(
			(file) =>
				file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.includes("testkit")
		);
		const builders = sources.filter((file) =>
			/isError:\s*true/.test(readFileSync(path.join(here, file), "utf8"))
		);
		// A scan that found neither read nothing.
		expect(builders.sort()).toEqual(["tools.ts", path.join("tools", "kit.ts")]);
	});
});
