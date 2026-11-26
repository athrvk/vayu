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
import { dispatchTool, TOOLS } from "./tools.js";
import { engineCode } from "./tools/failure.js";
import type { McpSafetyConfig } from "./config.js";
import { EngineRequestError } from "./engine-client.js";
import { descriptionOf, fakeClient, ctxWith, firstText, engineErrorBody } from "./tools.testkit.js";

describe("dispatchTool", () => {
	test("get_engine_health passes the engine response through", async () => {
		const client = fakeClient();
		const res = await dispatchTool("get_engine_health", {}, ctxWith(client));
		expect(res.isError).toBeFalsy();
		expect(firstText(res)).toContain("1.2.3");
	});

	test("unknown tool returns an error result", async () => {
		const res = await dispatchTool("nope", {}, ctxWith(fakeClient()));
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/unknown tool/i);
	});

	test("list_requests with an empty collectionId is a readable arg error, not a workspace read", async () => {
		const client = fakeClient();
		const res = await dispatchTool("list_requests", { collectionId: "" }, ctxWith(client));
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/collectionId.*must not be empty/i);
		expect(client.listRequestsPage).not.toHaveBeenCalled();
	});
});

/*
 * An id the engine does not hold reads as the missing object and the tool that
 * lists them, never as the engine's JSON or the HTTP path it was asked for
 * (#2778).
 */
describe("an unknown id names the object and its list tool", () => {
	const notFoundBody = (noun: string) => engineErrorBody("not_found", `${noun} not found`);
	const engine404 = (body: string, path = "/runs/run_x/report") =>
		new EngineRequestError(`Engine responded 404 for GET ${path}`, 404, body);

	describe("get_live_metrics 404", () => {
		const LIVE_EXPIRED =
			"The live buffer for this run expired (kept 60 s after it ends); the run still exists - read get_run_report(runId).";
		const liveExpiredBody = JSON.stringify({
			error: "Live metrics for this run are no longer retained",
			code: "live_expired",
			hint: "Use /runs/run_x/report for the stored report",
		});
		const liveCall = async (body: string) =>
			dispatchTool(
				"get_live_metrics",
				{ runId: "run_x" },
				ctxWith(
					fakeClient({
						getLiveMetricsSnapshot: vi
							.fn()
							.mockRejectedValue(engine404(body, "/runs/run_x/live")),
					})
				)
			);

		test("live_expired says the buffer expired and the run still exists, in the not_found class", async () => {
			const res = await liveCall(liveExpiredBody);
			expect(res.isError).toBe(true);
			const text = firstText(res);
			expect(text).toBe(LIVE_EXPIRED);
			expect(text).not.toContain("/runs/");
			expect(text).not.toContain("No run with id");
			expect(res.structuredContent).toEqual({
				error: { class: "not_found", retryable: false, advice: LIVE_EXPIRED },
			});
		});

		test("live_expired is read from the nested error shape too", async () => {
			const res = await liveCall(engineErrorBody("live_expired", "Live metrics are gone"));
			expect(firstText(res)).toBe(LIVE_EXPIRED);
		});

		test("run_not_found keeps the unknown-id text, with no hint path", async () => {
			const res = await liveCall(
				JSON.stringify({
					error: "Run not found or expired",
					code: "run_not_found",
					hint: "Use /runs/run_x/report for the stored report",
				})
			);
			expect(firstText(res)).toBe(
				'No run with id "run_x" (it may have been deleted or the id is mistyped). ' +
					"List runs with list_runs."
			);
			expect(res.structuredContent).toMatchObject({ error: { class: "not_found" } });
		});

		test("a 404 with no code falls back to the engine's words", async () => {
			const res = await liveCall(
				JSON.stringify({ error: "Live metrics for this run are no longer retained" })
			);
			const text = firstText(res);
			expect(text).not.toBe(LIVE_EXPIRED);
			expect(text).toBe(
				'Engine error (404): {"error":"Live metrics for this run are no longer retained"}'
			);
			expect(res.structuredContent).toMatchObject({ error: { class: "not_found" } });
		});

		test("the sentence is the tool's own: another tool's live_expired is not reworded", async () => {
			const client = fakeClient({
				getRunReport: vi.fn().mockRejectedValue(engine404(liveExpiredBody)),
			});
			const res = await dispatchTool("get_run_report", { runId: "run_x" }, ctxWith(client));
			expect(firstText(res)).not.toBe(LIVE_EXPIRED);
		});

		test("the description names the retention window", () => {
			const description = descriptionOf(TOOLS.find((t) => t.name === "get_live_metrics"));
			expect(description).toContain("60 s");
			expect(description).toContain("get_run_report");
		});
	});

	describe("engineCode", () => {
		test.each([
			["flat", '{"error":"x","code":"live_expired"}', "live_expired"],
			["nested", '{"error":{"code":"not_found","message":"x"}}', "not_found"],
			["absent", '{"error":"x"}', undefined],
			["empty", '{"error":"x","code":""}', undefined],
			["not JSON", "plain text", undefined],
			["JSON null", "null", undefined],
		])("%s body", (_shape, body, expected) => {
			expect(engineCode(body)).toBe(expected);
		});
	});

	test("a 404 on get_run_report names the run and list_runs, with no path and no JSON", async () => {
		const client = fakeClient({
			getRunReport: vi.fn().mockRejectedValue(engine404(notFoundBody("Run"))),
		});
		const res = await dispatchTool("get_run_report", { runId: "run_x" }, ctxWith(client));
		expect(res.isError).toBe(true);
		const text = firstText(res);
		expect(text).toBe(
			'No run with id "run_x" (it may have been deleted or the id is mistyped). ' +
				"List runs with list_runs."
		);
		expect(text).not.toContain("/runs/");
		expect(text).not.toContain("{");
		expect(res.structuredContent).toEqual({
			error: { class: "not_found", retryable: false, advice: text },
		});
	});

	test.each([
		["request", "Request not found", 'No request with id "req_1"'],
		["example", "Example not found", 'No example with id "ex_1"'],
	])(
		"a tool taking two ids names the %s the engine's sentence says is missing",
		async (_kind, sentence, expected) => {
			const client = fakeClient({
				updateRequestExample: vi.fn().mockRejectedValue(engine404(notFoundBody(sentence))),
			});
			const res = await dispatchTool(
				"update_request_example",
				{ requestId: "req_1", exampleId: "ex_1", name: "renamed" },
				ctxWith(client, { allowWrites: true })
			);
			expect(firstText(res)).toContain(expected);
		}
	);

	test("two ids of one kind with nothing to say which, name neither", async () => {
		const client = fakeClient({
			getRunReport: vi.fn().mockRejectedValue(engine404(notFoundBody("Run"))),
		});
		const res = await dispatchTool(
			"compare_runs",
			{ baseRunId: "run_a", targetRunId: "run_b" },
			ctxWith(client)
		);
		expect(firstText(res)).toMatch(/^No run matches the id given \(/);
		expect(firstText(res)).not.toContain("run_a");
		expect(firstText(res)).not.toContain("run_b");
	});

	test("two ids of one kind name the one the engine's sentence carries", async () => {
		const client = fakeClient({
			getRunReport: vi.fn().mockRejectedValue(engine404(notFoundBody("Run run_b"))),
		});
		const res = await dispatchTool(
			"compare_runs",
			{ baseRunId: "run_a", targetRunId: "run_b" },
			ctxWith(client)
		);
		expect(firstText(res)).toMatch(/^No run with id "run_b" \(/);
	});

	test("a spec has no list tool, so the sentence stops at the cause", async () => {
		const client = fakeClient({
			getSpecMeta: vi
				.fn()
				.mockRejectedValue(engine404(notFoundBody("Spec"), "/specs/s/meta")),
		});
		const res = await dispatchTool("get_spec", { specId: "spec_1" }, ctxWith(client));
		expect(firstText(res)).toBe(
			'No spec with id "spec_1" (it may have been deleted or the id is mistyped).'
		);
	});

	test("a 404 the declared noun does not describe stays the engine's compact sentence", async () => {
		const client = fakeClient({
			getRun: vi.fn().mockRejectedValue(engine404(engineErrorBody("not_found", "Gone"))),
		});
		const res = await dispatchTool("get_run", { runId: "run_x" }, ctxWith(client));
		expect(firstText(res)).toBe(
			'Engine error (404): {"error":{"code":"not_found","message":"Gone"}}'
		);
	});

	test("a tool that declares nothing keeps a one-line engine error for a 404", async () => {
		const pretty = JSON.stringify({ error: { code: "not_found", message: "Gone" } }, null, 2);
		const client = fakeClient({ listRuns: vi.fn().mockRejectedValue(engine404(pretty)) });
		const res = await dispatchTool("list_runs", { requestId: "req_1" }, ctxWith(client));
		expect(res.isError).toBe(true);
		expect(firstText(res)).toBe(
			'Engine error (404): {"error":{"code":"not_found","message":"Gone"}}'
		);
		expect(res.structuredContent).toMatchObject({ error: { class: "not_found" } });
	});

	test("engine bodies formatted differently come out on one line", async () => {
		const bodies = [
			JSON.stringify({ error: { code: "bad_request", message: "no good" } }, null, 2),
			JSON.stringify({ error: { code: "bad_request", message: "no good" } }),
			"no good\n  at\tsome\n  place",
		];
		const texts: string[] = [];
		for (const body of bodies) {
			const client = fakeClient({
				listRuns: vi.fn().mockRejectedValue(new EngineRequestError("400", 400, body)),
			});
			texts.push(firstText(await dispatchTool("list_runs", {}, ctxWith(client))));
		}
		for (const text of texts) expect(text).not.toMatch(/\n/);
		expect(texts[0]).toBe(texts[1]);
		expect(texts[2]).toBe("Engine error (400): no good at some place");
	});

	test("the retry hint still follows a compacted body", async () => {
		const body = JSON.stringify(
			{ error: { code: "insufficient_storage", message: "full" } },
			null,
			2
		);
		const client = fakeClient({
			listRuns: vi.fn().mockRejectedValue(new EngineRequestError("507", 507, body)),
		});
		const res = await dispatchTool("list_runs", {}, ctxWith(client));
		expect(firstText(res)).toBe(
			'Engine error (507): {"error":{"code":"insufficient_storage","message":"full"}} ' +
				"Retry the call after space is freed."
		);
	});

	/*
	 * A tool with a `<kind>Id` argument either declares what the id names or
	 * says here why an unknown one cannot be worded by the 404 layer.
	 */
	const EXEMPT: Readonly<Record<string, string>> = {
		list_requests: "filters a list: an unknown collection lists nothing, it is not a 404",
		list_runs: "filters a list: an unknown request or collection lists nothing",
		get_graphql_schema: "composes the send; composeViaEngine and selectEnvironment word the id",
		run_request: "composes the send; composeViaEngine and selectEnvironment word the id",
		run_collection_smoke:
			"composes each send; composeViaEngine and selectEnvironment word the id",
		start_load_run: "composes the send; composeViaEngine and selectEnvironment word the id",
		resolve_variables: "gatherVariableScopes and selectEnvironment word the id",
		create_collection: "the engine does not check that parentId exists",
		create_request: "an unknown collectionId is a 400 that names it, not a 404",
		move_item: "reads the collection list first and words an unknown id itself (move.tools.ts)",
		restore_trash_entry: "trashRefusalMessage words the 404 itself (trash.ts)",
		purge_trash_entry: "readTrashEntry words an id the trash does not hold (trash.ts)",
		clear_cookies:
			"environmentId names a jar, which need not exist; clearing an empty one is 0",
	};
	const idKeys = (tool: (typeof TOOLS)[number]) =>
		Object.keys(tool.inputSchema).filter((key) => /[a-z]Id$/.test(key));
	const scanned = TOOLS.filter((tool) => idKeys(tool).length > 0);

	test("every tool with a <kind>Id argument declares notFound or is exempt with a reason", () => {
		expect(scanned.length).toBeGreaterThan(0);
		const unaccounted = scanned
			.filter((tool) => tool.notFound === undefined && !(tool.name in EXEMPT))
			.map((tool) => tool.name);
		expect(unaccounted).toEqual([]);
	});

	test("an exemption is for a tool that exists, has an id, and declares nothing", () => {
		for (const name of Object.keys(EXEMPT)) {
			const tool = TOOLS.find((t) => t.name === name);
			expect(tool, name).toBeDefined();
			expect(idKeys(tool!), name).not.toEqual([]);
			expect(tool!.notFound, name).toBeUndefined();
		}
	});

	test("a declaration names arguments the tool takes and a list tool that is a read", () => {
		const declared = scanned.flatMap((tool) =>
			tool.notFound === undefined ? [] : [{ tool, notFound: tool.notFound }]
		);
		expect(declared.length).toBeGreaterThan(0);
		for (const { tool, notFound } of declared) {
			const entries = "idArg" in notFound ? [notFound] : notFound;
			for (const entry of entries) {
				const args = typeof entry.idArg === "string" ? [entry.idArg] : entry.idArg;
				for (const arg of args)
					expect(tool.inputSchema, `${tool.name}.${arg}`).toHaveProperty(arg);
				if (entry.list === undefined) continue;
				const list = TOOLS.find((t) => t.name === entry.list);
				expect(list, `${tool.name} -> ${entry.list}`).toBeDefined();
				expect(list?.category).toBe("read");
				expect(entry.list).toMatch(/^list_/);
			}
		}
	});
});

/** A tool call that reaches the engine's send routes, and which of the two it calls. */
interface McpSender {
	tool: string;
	args: Record<string, unknown>;
	sentTo: "executeRequest" | "startRun";
}

/** Every path that starts a run, each driven by name below. */
const RUN_STARTERS: McpSender[] = [
	{
		tool: "run_request",
		args: { url: "https://api.example.com/x" },
		sentTo: "executeRequest",
	},
	{
		tool: "run_request",
		args: { url: "https://api.example.com/x", stream: true },
		sentTo: "executeRequest",
	},
	{ tool: "run_collection_smoke", args: { collectionId: "c1" }, sentTo: "executeRequest" },
	{ tool: "run_collection", args: { collectionId: "c1" }, sentTo: "startRun" },
	{
		tool: "start_load_run",
		args: { url: "https://api.example.com/x", confirmed: true },
		sentTo: "startRun",
	},
	{
		tool: "start_load_run",
		args: {
			scenario: { collectionId: "c1" },
			mode: "constant_concurrency",
			concurrency: 5,
			duration: "30s",
			confirmed: true,
		},
		sentTo: "startRun",
	},
];

/**
 * Every tool that starts a run says the run is an agent's, and which client's
 * (#1817): History reads `origin` to tell an MCP run from one the user sent.
 * A tool that forgets the stamp records a run as `other`, which no store-level
 * test notices, so each run-starting path is driven here by name.
 */
describe("every run an MCP tool starts carries an MCP origin", () => {
	const allow = { allowlist: ["api.example.com"] };
	const cases = RUN_STARTERS.map((c) => [`${c.tool} ${JSON.stringify(c.args)}`, c] as const);

	/**
	 * One saved request in `c1`; an inline request composes to itself. `extra`
	 * rides every composed payload, for a composition that names an origin.
	 */
	function runClient(extra: Record<string, unknown> = {}) {
		return fakeClient({
			listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "one" }]),
			composeRequest: vi.fn().mockImplementation((body: { request?: object }) =>
				Promise.resolve({
					...(body.request ?? { method: "GET", url: "https://api.example.com/r1" }),
					...extra,
				})
			),
		});
	}

	async function originSent(
		{ tool, args, sentTo }: McpSender,
		clientName?: () => string | undefined,
		composedExtra?: Record<string, unknown>
	): Promise<unknown> {
		const client = runClient(composedExtra);
		const res = await dispatchTool(tool, args, {
			...ctxWith(client, allow),
			...(clientName ? { clientName } : {}),
		});
		expect(res.isError, firstText(res)).toBeFalsy();
		const send = client[sentTo] as ReturnType<typeof vi.fn>;
		expect(send).toHaveBeenCalledTimes(1);
		return (send.mock.calls[0][0] as Record<string, unknown>).origin;
	}

	test.each(cases)("%s names the handshake's client", async (_, starter) => {
		expect(await originSent(starter, () => "claude-code")).toStrictEqual({
			kind: "mcp",
			client: "claude-code",
		});
	});

	test.each(cases)("%s with no known client sends the kind alone", async (_, starter) => {
		// Strict: a `client: undefined` key would serialize away, but it would
		// also mean the omission is an accident of JSON rather than the rule.
		expect(await originSent(starter)).toStrictEqual({ kind: "mcp" });
		expect(await originSent(starter, () => undefined)).toStrictEqual({ kind: "mcp" });
	});

	// Both ways in: an argument, and a payload that already carries one by the
	// time it is sent (composition hands back what it was given).
	test.each(cases)("%s cannot be given another origin", async (_, starter) => {
		const app = { kind: "app" };
		const spoofed = { ...starter, args: { ...starter.args, origin: app } };
		expect(await originSent(spoofed, () => "cursor", { origin: app })).toStrictEqual({
			kind: "mcp",
			client: "cursor",
		});
	});
});

/**
 * Every send carries the session's allowlist as `targetPolicy` (#2521): the
 * engine holds the URL it is about to send, after any pre-request script, to
 * the same rule. A path that forgot it would send wherever a script steered,
 * and no gate here could see it, so each sending tool is driven by name and the
 * scan below fails on a send that skips `asMcpSend`.
 */
describe("every MCP send carries the session's target policy", () => {
	const senders: McpSender[] = [
		...RUN_STARTERS,
		{
			tool: "get_graphql_schema",
			args: { url: "https://api.example.com/graphql" },
			sentTo: "executeRequest",
		},
	];
	const cases = senders.map((c) => [`${c.tool} ${JSON.stringify(c.args)}`, c] as const);

	/** The payload @p sender's one send carried under @p safety. */
	async function payloadSent(
		{ tool, args, sentTo }: McpSender,
		safety: Partial<McpSafetyConfig>,
		composedExtra: Record<string, unknown> = {}
	): Promise<Record<string, unknown>> {
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "one" }]),
			composeRequest: vi.fn().mockImplementation((body: { request?: object }) =>
				Promise.resolve({
					...(body.request ?? { method: "GET", url: "https://api.example.com/r1" }),
					...composedExtra,
				})
			),
		});
		// The outcome after the send is the tool's own business (the GraphQL
		// tool refuses a fake introspection answer); the payload is the subject.
		await dispatchTool(tool, args, ctxWith(client, safety));
		const send = client[sentTo] as ReturnType<typeof vi.fn>;
		expect(send).toHaveBeenCalledTimes(1);
		return send.mock.calls[0][0] as Record<string, unknown>;
	}

	/** The `targetPolicy` @p sender's one send carried under @p safety. */
	async function policySent(
		sender: McpSender,
		safety: Partial<McpSafetyConfig>,
		composedExtra: Record<string, unknown> = {}
	): Promise<unknown> {
		return (await payloadSent(sender, safety, composedExtra)).targetPolicy;
	}

	// Composition's answer about itself (#2521) is for the agent that composed;
	// the engine would ignore it on these routes, but it is not part of a send.
	test.each(cases)("%s does not forward composition's deferredVariables", async (_, sender) => {
		const sent = await payloadSent(
			sender,
			{ allowlist: ["api.example.com"] },
			{ deferredVariables: ["token"] }
		);
		expect(sent).not.toHaveProperty("deferredVariables");
	});

	// The scope an ad-hoc request was composed in is part of its send (#3461):
	// with no saved row linked, the engine's scripts read their collection from
	// it. Mutation check: strip `collectionId` in `asMcpSend` and these fail.
	const adHocCases = cases.filter(
		([, sender]) =>
			"url" in sender.args &&
			(sender.tool === "run_request" || sender.tool === "start_load_run")
	);
	test.each(adHocCases)("%s forwards composition's collectionId", async (_, sender) => {
		const sent = await payloadSent(
			sender,
			{ allowlist: ["api.example.com"] },
			{ collectionId: "col_scope" }
		);
		expect(sent.collectionId).toBe("col_scope");
	});

	test.each(cases)("%s states the session's allowlist", async (_, sender) => {
		expect(await policySent(sender, { allowlist: ["api.example.com"] })).toStrictEqual({
			allowAll: false,
			allowedHosts: ["api.example.com"],
		});
	});

	test.each(cases)("%s states Allow all hosts", async (_, sender) => {
		expect(await policySent(sender, { allowAll: true })).toStrictEqual({
			allowAll: true,
			allowedHosts: [],
		});
	});

	// Both ways in, as for `origin`: an argument, and a composed payload that
	// already carries one.
	test.each(cases)("%s cannot be given a wider policy", async (_, sender) => {
		const wide = { allowAll: true, allowedHosts: [] };
		const spoofed = { ...sender, args: { ...sender.args, targetPolicy: wide } };
		expect(
			await policySent(spoofed, { allowlist: ["api.example.com"] }, { targetPolicy: wide })
		).toStrictEqual({ allowAll: false, allowedHosts: ["api.example.com"] });
	});

	// The engine judges `monitor.url` against the policy too (#3121) and exempts
	// nothing, so a loopback monitor `checkMonitorHost` passed without an entry
	// travels in it; a host the gate checks is already listed or was refused.
	const monitoredCases = cases.filter(([, sender]) => sender.tool === "start_load_run");
	const monitored = (sender: McpSender, url: string): McpSender => ({
		...sender,
		args: { ...sender.args, monitor: { url, series: ["up"] } },
	});

	test.each(monitoredCases)(
		"%s lists the loopback monitor host it exempted",
		async (_, sender) => {
			expect(
				await policySent(monitored(sender, "http://localhost:9100/metrics"), {
					allowlist: ["api.example.com"],
				})
			).toStrictEqual({ allowAll: false, allowedHosts: ["api.example.com", "localhost"] });
		}
	);

	test.each(monitoredCases)(
		"%s adds nothing for an allowlisted monitor host",
		async (_, sender) => {
			const allowlist = ["api.example.com", "metrics.example.com"];
			expect(
				await policySent(monitored(sender, "https://metrics.example.com/m"), { allowlist })
			).toStrictEqual({ allowAll: false, allowedHosts: allowlist });
		}
	);

	test.each(monitoredCases)("%s adds nothing under Allow all hosts", async (_, sender) => {
		expect(
			await policySent(monitored(sender, "http://localhost:9100/metrics"), { allowAll: true })
		).toStrictEqual({ allowAll: true, allowedHosts: [] });
	});

	test("no executeRequest or startRun call in the server skips asMcpSend", () => {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const sources = readdirSync(here, { recursive: true, encoding: "utf8" }).filter(
			(file) =>
				file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.includes("testkit")
		);
		const calls: string[] = [];
		for (const file of sources) {
			const text = readFileSync(path.join(here, file), "utf8");
			for (const call of text.matchAll(/\.(executeRequest|startRun)\(\s*([\w.]*)/g)) {
				calls.push(`${file}: ${call[1]}(${call[2]}`);
			}
		}
		// Seven sends today; a scan that read nothing would pass vacuously.
		expect(calls.length).toBeGreaterThanOrEqual(7);
		expect(calls.filter((call) => !call.endsWith("(asMcpSend"))).toEqual([]);
	});
});

/**
 * The engine's refusal of the URL a script left (#2521) reads as the allowlist
 * gate's own refusal: the host it names, and the same remedy, on each path
 * whose answer an agent reads at once.
 */
describe("an engine target refusal carries the allowlist remedy", () => {
	const refusalMessage =
		'Host "evil.example.com", which the URL about to be sent names, is not allowed by this request\'s target policy (allowed hosts: api.example.com). Nothing was sent.';
	const remedy = "add the host in Vayu Settings → MCP (Target allowlist)";

	// The early gate cannot know a host a pre-request script chooses, so it
	// sends, policy attached, and the engine judges the host once resolved.
	test("a saved request whose host waits on its script reaches the engine", async () => {
		const client = fakeClient({
			composeRequest: vi.fn().mockResolvedValue({
				method: "GET",
				url: "https://{{host}}/x",
				deferredVariables: ["host"],
			}),
		});
		const res = await dispatchTool(
			"run_request",
			{ requestId: "r1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError, firstText(res)).toBeFalsy();
		const sent = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(sent.targetPolicy).toStrictEqual({
			allowAll: false,
			allowedHosts: ["api.example.com"],
		});
	});

	test("a buffered run_request answers an error naming the host and the remedy", async () => {
		const client = fakeClient({
			executeRequest: vi.fn().mockResolvedValue({
				status: 0,
				errorMessage: refusalMessage,
				refusalCode: "target_not_allowed",
			}),
		});
		const res = await dispatchTool(
			"run_request",
			{ url: "https://api.example.com/x" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain('"evil.example.com"');
		expect(firstText(res)).toContain(remedy);
	});

	test("a streaming run_request's 400 answers the same", async () => {
		const client = fakeClient({
			executeRequest: vi
				.fn()
				.mockRejectedValue(
					new EngineRequestError(
						"Engine responded 400",
						400,
						engineErrorBody("target_not_allowed", refusalMessage)
					)
				),
		});
		const res = await dispatchTool(
			"run_request",
			{ url: "https://api.example.com/x", stream: true },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain('"evil.example.com"');
		expect(firstText(res)).toContain(remedy);
		expect(firstText(res)).not.toContain("Engine error (400)");
	});

	test("a smoke run skips the refused request with the remedy as its reason", async () => {
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "one" }]),
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "https://api.example.com/r1" }),
			executeRequest: vi.fn().mockResolvedValue({
				status: 0,
				errorMessage: refusalMessage,
				refusalCode: "target_not_allowed",
			}),
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
		expect(matrix.results[0].reason).toContain(remedy);
	});

	test("an unknown host asks for a resolved URL rather than an allowlist entry", async () => {
		const client = fakeClient({
			executeRequest: vi.fn().mockResolvedValue({
				status: 0,
				errorMessage: "Could not determine the target host.",
				refusalCode: "target_host_unknown",
			}),
		});
		const res = await dispatchTool(
			"run_request",
			{ url: "https://api.example.com/x" },
			ctxWith(client, { allowAll: true })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain("Resolve the URL before sending.");
		expect(firstText(res)).not.toContain(remedy);
	});
});
