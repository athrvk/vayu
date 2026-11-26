/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test, vi } from "vitest";
import { dispatchTool, MAX_INLINE_BODY_BYTES, TOOLS } from "../tools.js";
import { RUN_STATUSES } from "./run-housekeeping.js";
import { classifyRunStatus, PARTIAL_REPORT_NOTE } from "./run-status.js";
import {
	DEFAULT_LIST_PAGE_LIMIT,
	EngineRequestError,
	MAX_ENGINE_PAGE_LIMIT,
} from "../engine-client.js";
import { withheldPointer } from "../withhold.js";
import {
	descriptionOf,
	advertisedOutputSchema,
	outputMemberDescription,
	declaredPaths,
	presentPaths,
	page,
	fakeClient,
	ctxWith,
	firstText,
	engineErrorBody,
} from "../tools.testkit.js";

describe("run status reads (#2436)", () => {
	const NOW = 1_755_000_100_000;
	const START = 1_755_000_000_000;

	function runRow(overrides: Record<string, unknown> = {}) {
		return {
			id: "run_1",
			type: "load",
			status: "running",
			startTime: START,
			// What the engine answers for a run that has not finished (#2953).
			endTime: null,
			configSnapshot: {
				url: "https://api.example.com/users",
				mode: "constant_rps",
				duration: "200s",
				concurrency: 10,
				targetRps: 50,
			},
			requestId: "req_1",
			baseline: false,
			...overrides,
		};
	}

	async function getRun(row: unknown) {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
		try {
			const client = fakeClient({ getRun: vi.fn().mockResolvedValue(row) });
			const res = await dispatchTool("get_run", { runId: "run_1" }, ctxWith(client));
			expect(res.isError).toBeFalsy();
			return JSON.parse(firstText(res)) as Record<string, unknown>;
		} finally {
			vi.useRealTimers();
		}
	}

	describe("get_run", () => {
		test.each(["pending", "running"])(
			"a %s run is not terminal and has no end",
			async (status) => {
				const out = await getRun(runRow({ status }));
				expect(out).toMatchObject({
					id: "run_1",
					type: "load",
					status,
					terminal: false,
					startTime: START,
					endTime: null,
					elapsedMs: NOW - START,
					mode: "constant_rps",
					concurrency: 10,
					targetRps: 50,
					duration: "200s",
					requestId: "req_1",
					baseline: false,
				});
				// 200 s planned: a tenth is 20 s, held to the 10 s ceiling.
				expect(out.nextStep).toBe("still running; read again in 10 s, or stop_run");
			}
		);

		test.each(["completed", "failed", "stopped"])(
			"a %s run is terminal and reports its real end",
			async (status) => {
				const out = await getRun(runRow({ status, endTime: START + 60_000 }));
				expect(out.terminal).toBe(true);
				expect(out.endTime).toBe(START + 60_000);
				expect(out.elapsedMs).toBe(60_000);
			}
		);

		test("each terminal status points at the report, and a stopped run says it has no verdict", async () => {
			const done = await getRun(runRow({ status: "completed", endTime: START + 1 }));
			expect(done.nextStep).toBe("read get_run_report(runId)");
			const failed = await getRun(runRow({ status: "failed", endTime: START + 1 }));
			expect(failed.nextStep).toMatch(/what was recorded before the failure/);
			// A failed run's counts may be absent altogether (#2895): the pointer names the flags.
			expect(failed.nextStep).toMatch(/summary\.summaryMissing or summary\.partial/);
			const stopped = await getRun(runRow({ status: "stopped", endTime: START + 1 }));
			expect(stopped.nextStep).toMatch(/partial numbers.*no verdict/);
		});

		// The engine never emits a status outside RUN_STATUSES, so the row is injected.
		test.each([
			["an unlisted string", "archived"],
			["null", null],
			["missing", undefined],
		])(
			"a row whose status is %s is unfinished, flagged unknownStatus and bounded by stop_run (#3339)",
			async (_label, status) => {
				const out = await getRun(runRow({ status, endTime: START + 60_000 }));
				expect(out.terminal).toBe(false);
				expect(out.unknownStatus).toBe(true);
				// Unfinished means no end, however the row spells endTime.
				expect(out.endTime).toBeNull();
				expect(out.nextStep).toMatch(/not one Vayu recognises/);
				expect(out.nextStep).toMatch(
					/treat the run as unfinished: read again in 10 s, or stop_run/
				);
				if (status === "archived") expect(out.nextStep).toContain('"archived"');
			}
		);

		test.each(RUN_STATUSES)(
			"a %s run carries no unknownStatus key at all (#3339)",
			async (status) => {
				const out = await getRun(runRow({ status, endTime: START + 1 }));
				expect(out).not.toHaveProperty("unknownStatus");
			}
		);

		test("an unknown status satisfies the output schema and the schema names unknownStatus (#3339)", async () => {
			const client = fakeClient({
				getRun: vi.fn().mockResolvedValue(runRow({ status: "archived" })),
			});
			const res = await dispatchTool("get_run", { runId: "run_1" }, ctxWith(client));
			const schema = TOOLS.find((t) => t.name === "get_run")!.outputSchema!;
			expect(schema.safeParse(res.structuredContent).success).toBe(true);
			expect(res.structuredContent).toMatchObject({ unknownStatus: true });
			expect(schema.safeParse({ unknownStatus: "yes" }).success).toBe(false);
		});

		// An engine that predates #2953 answers the stored seed (endTime = startTime)
		// for a live run, so the status decides, never `endTime > 0`.
		test.each([
			["null", null],
			["the start time an older engine stored", START],
		])(
			"a running row whose endTime is %s is not terminal and has no end",
			async (_label, endTime) => {
				const out = await getRun(runRow({ status: "running", endTime }));
				expect(out.terminal).toBe(false);
				expect(out.endTime).toBeNull();
			}
		);

		test("a duration-bound run reports its progress, clamped to 0..1", async () => {
			const half = await getRun(runRow());
			expect(half.plannedDurationMs).toBe(200_000);
			expect(half.progress).toBe(0.5);

			const overrun = await getRun(
				runRow({ configSnapshot: { mode: "constant_rps", duration: "10s" } })
			);
			expect(overrun.progress).toBe(1);

			const notStarted = await getRun(runRow({ startTime: NOW + 5_000 }));
			expect(notStarted.progress).toBe(0);
		});

		test("an iterations run, or a duration that does not parse, has no progress and the 5 s poll", async () => {
			const iterations = await getRun(
				runRow({ configSnapshot: { mode: "iterations", duration: "30s", iterations: 100 } })
			);
			expect(iterations.plannedDurationMs).toBeNull();
			expect(iterations.progress).toBeNull();
			expect(iterations.nextStep).toBe("still running; read again in 5 s, or stop_run");

			const unparsed = await getRun(
				runRow({ configSnapshot: { mode: "constant_rps", duration: "soon" } })
			);
			expect(unparsed.plannedDurationMs).toBeNull();
			expect(unparsed.progress).toBeNull();
			expect(unparsed.nextStep).toContain("5 s");

			const design = await getRun(runRow({ type: "design", configSnapshot: { url: "u" } }));
			expect(design.progress).toBeNull();
			expect(design.duration).toBeNull();
		});

		test("the poll interval is a tenth of the duration between 2 and 10 s", async () => {
			const poll = async (duration: string) =>
				(await getRun(runRow({ configSnapshot: { mode: "constant_rps", duration } })))
					.nextStep;
			expect(await poll("5s")).toContain("in 2 s");
			expect(await poll("45s")).toContain("in 5 s");
			expect(await poll("60s")).toContain("in 6 s");
			expect(await poll("5m")).toContain("in 10 s");
		});

		test("the projection never carries the trace, the result or the rest of the snapshot", async () => {
			const out = await getRun(
				runRow({
					configSnapshot: {
						url: "https://api.example.com/users",
						mode: "constant_rps",
						duration: "30s",
						headers: { "X-Tenant": "acme" },
						comment: "nightly",
					},
					result: { statusCode: 200 },
					trace: { response: { body: "<body>" } },
					designResult: { trace: { response: { body: "<body>" } } },
				})
			);
			expect(Object.keys(out).sort()).toEqual(
				[
					"id",
					"type",
					"status",
					"terminal",
					"startTime",
					"endTime",
					"elapsedMs",
					"plannedDurationMs",
					"progress",
					"mode",
					"concurrency",
					"targetRps",
					"duration",
					"requestId",
					"baseline",
					"nextStep",
				].sort()
			);
			expect(JSON.stringify(out)).not.toMatch(/api\.example\.com|acme|nightly|<body>/);
		});

		test("an id that names no run is an error naming the id", async () => {
			const client = fakeClient({
				getRun: vi
					.fn()
					.mockRejectedValue(new EngineRequestError("404", 404, "Run not found")),
			});
			const res = await dispatchTool("get_run", { runId: "run_missing" }, ctxWith(client));
			expect(res.isError).toBe(true);
			expect(firstText(res)).toContain('No run with id "run_missing"');
		});

		test("any other engine failure is reported as the engine's", async () => {
			const client = fakeClient({
				getRun: vi.fn().mockRejectedValue(new EngineRequestError("500", 500, "boom")),
			});
			const res = await dispatchTool("get_run", { runId: "run_1" }, ctxWith(client));
			expect(res.isError).toBe(true);
			expect(firstText(res)).toBe("Engine error (500): boom");
		});

		test("a full disk is reported as retryable once space is freed (#2423)", async () => {
			const body = engineErrorBody(
				"insufficient_storage",
				"The disk holding Vayu's data is full - free up space and try again"
			);
			const client = fakeClient({
				getRun: vi.fn().mockRejectedValue(new EngineRequestError("507", 507, body)),
			});
			const res = await dispatchTool("get_run", { runId: "run_1" }, ctxWith(client));
			expect(res.isError).toBe(true);
			expect(firstText(res)).toBe(
				`Engine error (507): ${body} Retry the call after space is freed.`
			);
		});

		test("a busy database is reported as retryable (#2423)", async () => {
			const body = engineErrorBody(
				"unavailable",
				"The Vayu database is busy - try again in a moment"
			);
			const client = fakeClient({
				getRun: vi.fn().mockRejectedValue(new EngineRequestError("503", 503, body)),
			});
			const res = await dispatchTool("get_run", { runId: "run_1" }, ctxWith(client));
			expect(res.isError).toBe(true);
			expect(firstText(res)).toBe(`Engine error (503): ${body} Retry the call in a moment.`);
		});

		test("a 503 from a shutting-down engine carries no retry hint (#2423)", async () => {
			const body = engineErrorBody("unavailable", "Engine is shutting down");
			const client = fakeClient({
				getRun: vi.fn().mockRejectedValue(new EngineRequestError("503", 503, body)),
			});
			const res = await dispatchTool("get_run", { runId: "run_1" }, ctxWith(client));
			expect(firstText(res)).toBe(`Engine error (503): ${body}`);
		});

		test("an ordinary engine failure carries no retry hint", async () => {
			const client = fakeClient({
				getRun: vi.fn().mockRejectedValue(new EngineRequestError("400", 400, "bad")),
			});
			const res = await dispatchTool("get_run", { runId: "run_1" }, ctxWith(client));
			expect(firstText(res)).toBe("Engine error (400): bad");
		});

		test("requires a runId", async () => {
			const res = await dispatchTool("get_run", {}, ctxWith(fakeClient()));
			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/runId/);
		});

		test("is a read tool and states what it withholds from run output", () => {
			const tool = TOOLS.find((t) => t.name === "get_run");
			expect(tool?.category).toBe("read");
			expect(tool?.annotations.readOnlyHint).toBe(true);
			expect(descriptionOf(tool)).toContain(
				withheldPointer({ revealSecretsToAgents: false }, "recorded")
			);
		});
	});

	describe("get_run_report", () => {
		const report = (status: string, extra: Record<string, unknown> = {}) => ({
			metadata: { runId: "run_1", status },
			summary: { totalRequests: 0 },
			...extra,
		});

		async function readReport(value: unknown) {
			const client = fakeClient({ getRunReport: vi.fn().mockResolvedValue(value) });
			const res = await dispatchTool("get_run_report", { runId: "run_1" }, ctxWith(client));
			expect(res.isError).toBeFalsy();
			return JSON.parse(firstText(res)) as Record<string, unknown>;
		}

		test.each(["pending", "running"])("a %s run's report is marked partial", async (status) => {
			const out = await readReport(report(status));
			expect(out.partial).toBe(true);
			expect(out.note).toMatch(
				/has not finished.*no budget verdict.*get_run\(runId\)\.terminal/
			);
			expect(out.summary).toEqual({ totalRequests: 0 });
		});

		test("a report that took the bounds' early return is marked too", async () => {
			// No `results` array: boundRunReport hands the value back untouched.
			const out = await readReport(report("running"));
			expect(out.partial).toBe(true);
		});

		test("a row-carrying report is marked after its traces are bounded", async () => {
			const out = await readReport(
				report("running", { results: [{ id: 1, trace: { response: { body: "x" } } }] })
			);
			expect(out.partial).toBe(true);
			expect((out.results as unknown[]).length).toBe(1);
		});

		test.each(["completed", "failed", "stopped"])(
			"a %s run's report carries no partial marker at all",
			async (status) => {
				const out = await readReport(report(status));
				expect(out).not.toHaveProperty("partial");
				expect(out).not.toHaveProperty("note");
			}
		);

		// The engine never emits a status outside RUN_STATUSES, so the report is injected.
		test("a report whose status Vayu does not recognise is partial, flagged and names the status (#3339)", async () => {
			const out = await readReport(report("archived"));
			expect(out.partial).toBe(true);
			expect(out.unknownStatus).toBe(true);
			expect(out.note).toMatch(/"archived".*not one Vayu recognises.*unfinished.*stop_run/);
			expect(out.note).not.toBe(PARTIAL_REPORT_NOTE);
			expect(out.summary).toEqual({ totalRequests: 0 });
		});

		test.each([
			["no status", { runId: "run_1" }],
			["a non-string status", { runId: "run_1", status: 3 }],
		])(
			"metadata with %s counts as unknown, like get_run's null status (#3339)",
			async (_label, metadata) => {
				const out = await readReport({ metadata, summary: {} });
				expect(out.partial).toBe(true);
				expect(out.unknownStatus).toBe(true);
				expect(out.note).toMatch(/missing.*not one Vayu recognises/);
			}
		);

		test("an unknown-status report satisfies the output schema and the schema names unknownStatus (#3339)", async () => {
			const client = fakeClient({
				getRunReport: vi.fn().mockResolvedValue(report("archived")),
			});
			const res = await dispatchTool("get_run_report", { runId: "run_1" }, ctxWith(client));
			const schema = TOOLS.find((t) => t.name === "get_run_report")!.outputSchema!;
			expect(schema.safeParse(res.structuredContent).success).toBe(true);
			expect(schema.safeParse({ unknownStatus: "yes" }).success).toBe(false);
		});

		test.each(RUN_STATUSES)(
			"a %s report carries no unknownStatus key at all (#3339)",
			async (status) => {
				const out = await readReport(report(status));
				expect(out).not.toHaveProperty("unknownStatus");
			}
		);

		test("a report with no metadata is handed back as it came", async () => {
			const answer = { latency: {}, summary: {}, statusCodes: {} };
			expect(await readReport(answer)).toEqual(answer);
		});

		test("the description leads with the partial rule and names metadata.status", () => {
			const description = descriptionOf(TOOLS.find((t) => t.name === "get_run_report"));
			expect(description).toMatch(
				/^Get the report for a run; a run still in progress returns a partial report marked `partial: true`/
			);
			expect(description).toContain("metadata.status");
		});

		test("the description keeps the summary flags apart from the top-level partial, and the schema says what each means (#2895)", () => {
			const description = descriptionOf(TOOLS.find((t) => t.name === "get_run_report"));
			expect(description).toContain(
				"Neither `summary.partial` nor `summary.summaryMissing` is the top-level `partial`."
			);
			for (const flag of ["summary.partial", "summary.summaryMissing"]) {
				const meaning = outputMemberDescription("get_run_report", flag);
				expect(meaning).toMatch(/latency, peakConcurrency and avgQueueWaitMs are absent/);
				expect(meaning).toMatch(/Never false/);
			}
		});

		test("a report's summary flags reach the agent and satisfy the output schema", async () => {
			const flagged = {
				metadata: { runId: "run_1", runType: "load", status: "failed" },
				summary: { totalRequests: 0, summaryMissing: true },
				results: [],
			};
			const client = fakeClient({ getRunReport: vi.fn().mockResolvedValue(flagged) });
			const res = await dispatchTool("get_run_report", { runId: "run_1" }, ctxWith(client));
			expect(res.isError).toBeFalsy();
			const schema = TOOLS.find((t) => t.name === "get_run_report")!.outputSchema!;
			expect(schema.safeParse(res.structuredContent).success).toBe(true);
			// Named in the schema, so a non-boolean is a contract break and not a pass-through.
			expect(schema.safeParse({ summary: { partial: "yes" } }).success).toBe(false);
			expect(res.structuredContent).toMatchObject({ summary: { summaryMissing: true } });
			// Not the top-level marker of an unfinished run.
			expect(res.structuredContent).not.toHaveProperty("partial");
		});

		// A body past the per-body cap; two such traces exhaust the report's budget.
		const pastCap = "x".repeat(MAX_INLINE_BODY_BYTES + 1);
		const completedRun = {
			metadata: {
				runId: "run_1",
				runType: "design",
				status: "completed",
				endTime: 1_700_000,
			},
			summary: {
				totalRequests: 5,
				drainCut: { cancelled: 2 },
				errorClasses: { protocol: 1, tool: 2, protocolCodes: { "-32602": 1 } },
			},
			warnings: [
				{ code: "unresolved_tokens", message: "1 request sent {{token}}", count: 1 },
			],
			slowRequests: { count: 3, thresholdMs: 1000, tracesStored: 1, percentage: 60 },
			coverage: { operations: [{ method: "GET", path: "/x", exercised: true }] },
			elements: [{ id: "el_1", kind: "script.post", messages: [], console: [] }],
			testValidation: { samplesTested: 1, console: [{ level: "log", text: "saw 404" }] },
			results: [
				{ id: 1, statusCode: 0, trace: { failures: ["expected 404"], failureCounts: [3] } },
				{
					id: 2,
					statusCode: 500,
					trace: {
						request: { rawRequest: `POST /x HTTP/1.1\r\nHost: a\r\n\r\n${pastCap}` },
						response: { body: pastCap },
					},
				},
				{
					id: 3,
					statusCode: 200,
					trace: { response: { body: "AAEC", bodyEncoding: "base64" } },
				},
				{ id: 4, statusCode: 200, trace: { response: { body: pastCap } } },
				{ id: 5, statusCode: 200, trace: { response: { body: pastCap } } },
			],
			resultsStored: 5,
			resultsCap: 100,
		};
		const failedLoadRun = (summary: Record<string, unknown>) => ({
			metadata: { runId: "run_1", runType: "load", status: "failed" },
			summary: { totalRequests: 10, ...summary },
			results: [],
		});

		// Mutation check (#3749): rename a member in runReportSchema, or have the
		// bounds stop writing one (`traceOmitted`, `bodyTruncated`), and this fails.
		test("every member the output schema declares reaches the agent, and each report satisfies it (#3749)", async () => {
			const schema = TOOLS.find((t) => t.name === "get_run_report")!.outputSchema!;
			const reports = [
				completedRun,
				failedLoadRun({ partial: true }),
				failedLoadRun({ summaryMissing: true }),
				report("running"),
				report("archived"),
			];
			const present = new Set<string>();
			for (const engineReport of reports) {
				const client = fakeClient({
					getRunReport: vi.fn().mockResolvedValue(engineReport),
				});
				const res = await dispatchTool(
					"get_run_report",
					{ runId: "run_1" },
					ctxWith(client)
				);
				expect(res.isError).toBeFalsy();
				expect(schema.safeParse(res.structuredContent).success).toBe(true);
				for (const path of presentPaths(res.structuredContent)) present.add(path);
			}

			const declared = declaredPaths(advertisedOutputSchema("get_run_report"));
			expect(declared.length).toBeGreaterThan(20);
			expect(declared.filter((path) => !present.has(path))).toEqual([]);
		});

		test("a trace the engine could not parse still satisfies the output schema", async () => {
			const schema = TOOLS.find((t) => t.name === "get_run_report")!.outputSchema!;
			const unparsed = { ...completedRun, results: [{ id: 1, trace: "{not json" }] };
			const client = fakeClient({ getRunReport: vi.fn().mockResolvedValue(unparsed) });
			const res = await dispatchTool("get_run_report", { runId: "run_1" }, ctxWith(client));
			expect(schema.safeParse(res.structuredContent).success).toBe(true);
			expect(res.structuredContent).toMatchObject({ results: [{ trace: "{not json" }] });
		});
	});

	describe("the status sets derive from RUN_STATUSES (#3339)", () => {
		test("every engine status is terminal or unfinished, and never unknown", () => {
			const classes = RUN_STATUSES.map((status) => classifyRunStatus(status));
			expect(classes).not.toContain("unknown");
			expect(RUN_STATUSES.filter((s) => classifyRunStatus(s) === "terminal")).toEqual([
				"completed",
				"failed",
				"stopped",
			]);
			expect(RUN_STATUSES.filter((s) => classifyRunStatus(s) === "unfinished")).toEqual([
				"pending",
				"running",
			]);
		});

		test.each([["archived"], [""], [null], [undefined], [3], ["Running"]])(
			"%j is unknown",
			(status) => {
				expect(classifyRunStatus(status)).toBe("unknown");
			}
		);

		test("list_runs' status description lists exactly RUN_STATUSES, in order", () => {
			const description = TOOLS.find((t) => t.name === "list_runs")!.inputSchema.status
				.description!;
			expect([...description.matchAll(/"(\w+)"/g)].map((m) => m[1])).toEqual([
				...RUN_STATUSES,
			]);
		});

		test("list_runs says endTime is null until the run reaches a terminal status", () => {
			expect(descriptionOf(TOOLS.find((t) => t.name === "list_runs"))).toContain(
				"`endTime` is null until the run is completed, failed or stopped."
			);
		});

		test("get_run and get_run_report enumerate the statuses the classifier knows", () => {
			const getRunText = descriptionOf(TOOLS.find((t) => t.name === "get_run"));
			expect(getRunText).toContain(
				"`status` (pending, running, completed, failed or stopped), `terminal` (true once the status is completed, failed or stopped)"
			);
			expect(getRunText).toContain("`unknownStatus: true`");
			expect(getRunText).toMatch(/does not recognise counts as unfinished/);
			// get_run_report states the terminal set in its rule and the field
			// meanings on its output schema (#3749).
			expect(descriptionOf(TOOLS.find((t) => t.name === "get_run_report"))).toContain(
				"Until `metadata.status` is completed, failed or stopped no budget verdict exists"
			);
			expect(outputMemberDescription("get_run_report", "metadata.endTime")).toBe(
				"Null until the run is completed, failed or stopped."
			);
			expect(outputMemberDescription("get_run_report", "unknownStatus")).toMatch(
				/unrecognised `metadata.status`, which counts as unfinished/
			);
		});
	});

	describe("start tools name the status read", () => {
		const allow = { allowlist: ["api.example.com"] };

		function startClient() {
			return fakeClient({
				listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "login" }]),
				composeRequest: vi
					.fn()
					.mockResolvedValue({ method: "GET", url: "https://api.example.com/login" }),
			});
		}

		async function started(tool: string, args: Record<string, unknown>) {
			const res = await dispatchTool(tool, args, ctxWith(startClient(), allow));
			expect(res.isError).toBeFalsy();
			return {
				body: JSON.parse(firstText(res)) as Record<string, unknown>,
				structured: res.structuredContent,
			};
		}

		const NEXT_STEP_MENTIONS = [
			/get_run\(runId\)/,
			/completed, failed or stopped/,
			/get_run_report/,
		];

		test("a single-target load run carries nextStep with the poll interval from its duration", async () => {
			const { body, structured } = await started("start_load_run", {
				url: "https://api.example.com/x",
				duration: "30s",
				confirmed: true,
			});
			expect(body.runId).toBe("run_1");
			const nextStep = body.nextStep as string;
			for (const mention of NEXT_STEP_MENTIONS) expect(nextStep).toMatch(mention);
			expect(nextStep).toContain("every 3 s");
			expect(structured).toEqual(body);
		});

		test("an iterations load run polls at the 5 s fallback", async () => {
			const { body } = await started("start_load_run", {
				url: "https://api.example.com/x",
				mode: "iterations",
				iterations: 10,
				confirmed: true,
			});
			expect(body.nextStep).toContain("every 5 s");
		});

		test("a scenario load run carries the same nextStep and no longer says to follow with the report", async () => {
			const res = await dispatchTool(
				"start_load_run",
				{ scenario: { collectionId: "c1" }, duration: "60s", confirmed: true },
				ctxWith(startClient(), allow)
			);
			expect(res.isError).toBeFalsy();
			const body = JSON.parse(firstText(res)) as Record<string, unknown>;
			for (const mention of NEXT_STEP_MENTIONS)
				expect(body.nextStep as string).toMatch(mention);
			expect(body.nextStep).toContain("every 6 s");
			const everything = res.content
				.map((part) => (part as { text: string }).text)
				.join("\n");
			expect(everything).not.toContain("Follow the run with");
		});

		test("run_collection carries the same nextStep field", async () => {
			const { body } = await started("run_collection", { collectionId: "c1" });
			for (const mention of NEXT_STEP_MENTIONS)
				expect(body.nextStep as string).toMatch(mention);
			expect(body.nextStep).toContain("every 5 s");
			expect(body.plannedSteps).toBe(1);
		});

		test("a start answer that is not an object is handed back as it came", async () => {
			const client = fakeClient({
				composeRequest: vi
					.fn()
					.mockResolvedValue({ method: "GET", url: "https://api.example.com/x" }),
				startRun: vi.fn().mockResolvedValue("accepted"),
			});
			const res = await dispatchTool(
				"start_load_run",
				{ url: "https://api.example.com/x", confirmed: true },
				ctxWith(client, allow)
			);
			expect(JSON.parse(firstText(res))).toBe("accepted");
		});
	});
});

/**
 * The whole-list reads page through the engine (#2443): `q`, `limit` and
 * `offset` are forwarded, and a row is a summary unless `fields: "full"` asks
 * for the whole one. The summary is cut after the withholding pass, because a
 * request's url is masked by reading its auth.
 */
describe("the paged whole-list reads", () => {
	const REQUEST_ROWS = Array.from({ length: 5 }, (_, i) => ({
		id: `req_${i + 1}`,
		collectionId: "col_1",
		name: `Request ${i + 1}`,
		method: "POST",
		url: `https://api.example.com/items/${i + 1}`,
		order: i,
		params: [],
		headers: [{ key: "Accept", value: "application/json", enabled: true }],
		body: { mode: "raw", raw: "{}" },
		auth: { mode: "inherit" },
		elements: [{ kind: "script.pre", config: { source: "pm.environment.set('a', 1)" } }],
		updatedAt: 1_755_000_000_000,
		createdAt: 1_755_000_000_000,
	}));

	/** The engine's paging over @p rows: the slice the query names, with the total behind it. */
	const pagingEngine = (rows: unknown[]) =>
		vi.fn(async (_collectionId: string | undefined, query: { limit: number; offset: number }) =>
			page(rows.slice(query.offset, query.offset + query.limit), rows.length, query.offset)
		);

	const listRequests = async (args: Record<string, unknown>, rows: unknown[] = REQUEST_ROWS) => {
		const client = fakeClient({ listRequestsPage: pagingEngine(rows) });
		const res = await dispatchTool(
			"list_requests",
			{ collectionId: "col_1", ...args },
			ctxWith(client)
		);
		expect(res.isError).toBeFalsy();
		return { client, text: firstText(res), body: JSON.parse(firstText(res)) };
	};

	test("a summary row carries the request's identity and none of its content", async () => {
		const { body } = await listRequests({});
		expect(body.data).toHaveLength(5);
		expect(body.data[0]).toEqual({
			id: "req_1",
			collectionId: "col_1",
			name: "Request 1",
			method: "POST",
			url: "https://api.example.com/items/1",
			order: 0,
			updatedAt: 1_755_000_000_000,
		});
		for (const row of body.data) {
			for (const key of ["body", "headers", "params", "auth", "elements"]) {
				expect(row, key).not.toHaveProperty(key);
			}
		}
	});

	test('fields: "full" answers each whole stored row', async () => {
		const { body } = await listRequests({ fields: "full" });
		expect(body.data).toEqual(REQUEST_ROWS);
	});

	test("q, limit and offset reach the engine, and nothing else is the unpaged read", async () => {
		const { client } = await listRequests({ q: "request 3", limit: 10, offset: 0 });
		expect(client.listRequestsPage).toHaveBeenCalledWith(
			"col_1",
			{ q: "request 3", limit: 10, offset: 0 },
			undefined
		);
		expect(client.listRequests).not.toHaveBeenCalled();
	});

	test("an unstated page is the engine's default page", async () => {
		const { client } = await listRequests({});
		expect(client.listRequestsPage).toHaveBeenCalledWith(
			"col_1",
			{ limit: DEFAULT_LIST_PAGE_LIMIT, offset: 0 },
			undefined
		);
	});

	test("without a collectionId the page spans collections and none is sent to the engine", async () => {
		const rows = [
			{ ...REQUEST_ROWS[0], id: "req_a", collectionId: "col_1", name: "login" },
			{ ...REQUEST_ROWS[1], id: "req_b", collectionId: "col_2", name: "login again" },
		];
		const client = fakeClient({ listRequestsPage: pagingEngine(rows) });
		const res = await dispatchTool("list_requests", { q: "login" }, ctxWith(client));
		expect(res.isError).toBeFalsy();
		expect(client.listRequestsPage).toHaveBeenCalledWith(
			undefined,
			{ q: "login", limit: DEFAULT_LIST_PAGE_LIMIT, offset: 0 },
			undefined
		);
		const body = JSON.parse(firstText(res));
		expect(body.data.map((row: { collectionId: string }) => row.collectionId)).toEqual([
			"col_1",
			"col_2",
		]);
	});

	test("limit: 2 answers two rows and says where the next page starts", async () => {
		const { body } = await listRequests({ limit: 2 });
		expect(body.data.map((row: { id: string }) => row.id)).toEqual(["req_1", "req_2"]);
		expect(body.pagination).toMatchObject({ total: 5, hasMore: true, nextOffset: 2 });
		expect(body.pagination.note).toMatch(/2 of 5 requests/);
	});

	// Mutation check: project before withholding and the key reaches the summary,
	// because the API-key-in-query rule reads the row's auth, which the summary drops.
	test("a summary row's url is masked as the whole row's is, auth-placed key included", async () => {
		const secretRow = {
			...REQUEST_ROWS[0],
			url: "https://ops:pw-777@api.example.com/v1?tenant-key=tk-999&page=2",
			auth: { mode: "apikey", key: "tenant-key", value: "tk-999", in: "query" },
		};
		const { text, body } = await listRequests({}, [secretRow]);
		expect(text).not.toContain("tk-999");
		expect(text).not.toContain("pw-777");
		expect(body.data[0].url).toBe("https://ops@api.example.com/v1?tenant-key=&page=2");
	});

	test.each([
		[{ limit: MAX_ENGINE_PAGE_LIMIT + 1 }, String(MAX_ENGINE_PAGE_LIMIT)],
		[{ limit: 0 }, "limit"],
		[{ offset: -1 }, "offset"],
		[{ fields: "everything" }, '"fields"'],
	])("%j is refused before the engine is called", async (args, message) => {
		const client = fakeClient();
		const res = await dispatchTool(
			"list_requests",
			{ collectionId: "col_1", ...args },
			ctxWith(client)
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain(message);
		expect(client.listRequestsPage).not.toHaveBeenCalled();
	});

	test("a collection summary row drops its variables, auth and data contract", async () => {
		const collection = {
			id: "col_1",
			name: "API",
			parentId: null,
			order: 0,
			description: "",
			variables: { token: { value: "v-1", enabled: true } },
			auth: { mode: "bearer", token: "{{token}}" },
			dataSchema: { columns: ["id"] },
			createdAt: 1,
			updatedAt: 2,
		};
		const client = fakeClient({
			listCollectionsPage: vi.fn().mockResolvedValue(page([collection])),
		});
		const summary = await dispatchTool("list_collections", { q: "api" }, ctxWith(client));
		expect(JSON.parse(firstText(summary)).data).toEqual([
			{ id: "col_1", name: "API", parentId: null, order: 0 },
		]);
		expect(client.listCollectionsPage).toHaveBeenCalledWith(
			{ q: "api", limit: DEFAULT_LIST_PAGE_LIMIT, offset: 0 },
			undefined
		);
		const full = await dispatchTool("list_collections", { fields: "full" }, ctxWith(client));
		expect(JSON.parse(firstText(full)).data[0]).toMatchObject({
			variables: collection.variables,
			auth: collection.auth,
			dataSchema: { columns: ["id"] },
		});
		expect(client.listCollections).not.toHaveBeenCalled();
	});

	test("get_cookies forwards its page and filter", async () => {
		const client = fakeClient();
		await dispatchTool("get_cookies", { q: "x.test", limit: 5, offset: 10 }, ctxWith(client));
		expect(client.getCookiesPage).toHaveBeenCalledWith(
			{ q: "x.test", limit: 5, offset: 10 },
			undefined
		);
		expect(client.getCookies).not.toHaveBeenCalled();
	});
});
