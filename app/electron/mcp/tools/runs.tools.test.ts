/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import {
	DEFAULT_RUN_SAMPLE_LIMIT,
	DEFAULT_RUN_SERIES_LIMIT,
	dispatchTool,
	MAX_RUN_SERIES_LIMIT,
	TOOLS,
} from "../tools.js";
import {
	DEFAULT_RUN_PAGE_LIMIT,
	EngineRequestError,
	MAX_ENGINE_PAGE_LIMIT,
	type EngineClient,
} from "../engine-client.js";
import { defaultMcpExportFormat } from "../run-export-formats.js";
import { descriptionOf, page, pageOf, fakeClient, ctxWith, firstText } from "../tools.testkit.js";

describe("get_live_metrics limit", () => {
	function metricsClient() {
		return fakeClient({
			getLiveMetricsSnapshot: vi.fn().mockResolvedValue({ ticks: [], completed: false }),
		});
	}

	/**
	 * `limit` reaches `ticks.slice(-limit)`. A non-positive value does not
	 * narrow that window, it widens it: `0` returns every collected tick and
	 * `-3` returns all but the three oldest - the opposite of a limit. So these
	 * must fail loudly rather than be repaired into a plausible answer.
	 */
	test.each([0, -3, 2.5])("rejects limit %s without calling the engine", async (limit) => {
		const client = metricsClient();
		const res = await dispatchTool(
			"get_live_metrics",
			{ runId: "run_1", limit },
			ctxWith(client)
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/"limit" must be a whole number greater than 0/);
		expect(client.getLiveMetricsSnapshot).not.toHaveBeenCalled();
	});

	test("forwards a positive limit, and defaults to 10 when omitted", async () => {
		const client = metricsClient();
		await dispatchTool("get_live_metrics", { runId: "run_1", limit: 5 }, ctxWith(client));
		expect(client.getLiveMetricsSnapshot).toHaveBeenCalledWith(
			"run_1",
			5,
			undefined,
			undefined
		);

		const bare = metricsClient();
		await dispatchTool("get_live_metrics", { runId: "run_1" }, ctxWith(bare));
		expect(bare.getLiveMetricsSnapshot).toHaveBeenCalledWith("run_1", 10, undefined, undefined);
	});

	/**
	 * The reader's `complete` event is the only thing that tells a finished run
	 * from a read that ran out of budget, so the tool must carry it and may
	 * caveat the final tick only when the run ended.
	 */
	test("carries completed:false with no note while the run is still going", async () => {
		const client = fakeClient({
			getLiveMetricsSnapshot: vi
				.fn()
				.mockResolvedValue({ ticks: [{ currentRps: 5 }], completed: false }),
		});
		const res = await dispatchTool("get_live_metrics", { runId: "run_1" }, ctxWith(client));
		expect(res.structuredContent).toEqual({ ticks: [{ currentRps: 5 }], completed: false });
	});

	test("carries completed:true and the empty-window note once the run ended", async () => {
		const client = fakeClient({
			getLiveMetricsSnapshot: vi.fn().mockResolvedValue({
				ticks: [{ currentRps: 5, latencyP50Ms: 0 }],
				completed: true,
			}),
		});
		const res = await dispatchTool("get_live_metrics", { runId: "run_1" }, ctxWith(client));
		expect(res.structuredContent).toMatchObject({
			ticks: [{ currentRps: 5, latencyP50Ms: 0 }],
			completed: true,
		});
		const note = (res.structuredContent as { note: string }).note;
		expect(note).toMatch(/latency window may be empty/);
		expect(note).toMatch(/get_run_report/);
		expect(firstText(res)).toContain(note);
		expect(() =>
			TOOLS.find((t) => t.name === "get_live_metrics")!.outputSchema!.parse(
				res.structuredContent
			)
		).not.toThrow();
	});

	test("rejects a limit above the live buffer without calling the engine", async () => {
		const client = metricsClient();
		const res = await dispatchTool(
			"get_live_metrics",
			{ runId: "run_1", limit: 3001 },
			ctxWith(client)
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/"limit" must be 3000 or less/);
		expect(client.getLiveMetricsSnapshot).not.toHaveBeenCalled();
	});

	test("accepts a limit of exactly the live buffer", async () => {
		const client = metricsClient();
		const res = await dispatchTool(
			"get_live_metrics",
			{ runId: "run_1", limit: 3000 },
			ctxWith(client)
		);
		expect(res.isError).toBeFalsy();
		expect(client.getLiveMetricsSnapshot).toHaveBeenCalledWith(
			"run_1",
			3000,
			undefined,
			undefined
		);
	});

	test("the input schema rejects a non-positive limit too", () => {
		const shape = TOOLS.find((t) => t.name === "get_live_metrics")!.inputSchema as Record<
			string,
			z.ZodType
		>;
		expect(shape.limit.safeParse(0).success).toBe(false);
		expect(shape.limit.safeParse(-3).success).toBe(false);
		expect(shape.limit.safeParse(2.5).success).toBe(false);
		expect(shape.limit.safeParse(10).success).toBe(true);
		expect(shape.limit.safeParse(3000).success).toBe(true);
		expect(shape.limit.safeParse(3001).success).toBe(false);
		expect(shape.limit.safeParse(undefined).success).toBe(true);
	});
});

describe("dispatchTool", () => {
	test("compare_runs fetches both reports", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"compare_runs",
			{ baseRunId: "run_a", targetRunId: "run_b" },
			ctxWith(client)
		);
		expect(res.isError).toBeFalsy();
		expect(client.getRunReport).toHaveBeenCalledTimes(2);
		expect(firstText(res)).toContain("run_a");
		// An explicit base is used as given - no baseline lookup happens.
		expect(client.listBaselineRuns).not.toHaveBeenCalled();
	});

	/*
	 * The reports this tool reads come straight off `GET /runs/:id/report` -
	 * nothing transforms them on the way in, the way the renderer's query layer
	 * does - so the status mix arrives in the engine's own serialization: an
	 * array of `[code, count]` pairs, because `std::map<int, size_t>` cannot be
	 * a JSON object. Read as a record it yielded index keys with tuple values,
	 * every count was skipped, and the tool reported an empty mix as if the run
	 * had recorded no responses at all.
	 */
	test("compare_runs reads the engine's raw [code, count] status mix", async () => {
		const reports: Record<string, unknown> = {
			run_a: {
				latency: { p99: 40 },
				summary: { avgRps: 100 },
				statusCodes: [
					[200, 5970],
					[500, 30],
				],
			},
			run_b: {
				latency: { p99: 80 },
				summary: { avgRps: 90 },
				statusCodes: [
					[200, 5292],
					[500, 108],
				],
			},
		};
		const client = fakeClient({
			getRunReport: vi.fn().mockImplementation((id: string) => Promise.resolve(reports[id])),
		});

		const res = await dispatchTool(
			"compare_runs",
			{ baseRunId: "run_a", targetRunId: "run_b" },
			ctxWith(client)
		);

		expect(res.isError).toBeFalsy();
		expect(res.structuredContent).toMatchObject({
			statusCodes: {
				"200": { base: 5970, target: 5292 },
				"500": { base: 30, target: 108 },
			},
		});
	});

	/*
	 * Issue #2162: the stopped short run against the long one reads as a
	 * regression in every delta, so the tool returns the reasons it is not one
	 * and its description tells the agent to read them first.
	 */
	test("compare_runs returns comparability and tells the agent to read it first", async () => {
		const reports: Record<string, unknown> = {
			run_a: {
				metadata: { status: "completed", configuration: { concurrency: 10 } },
				summary: { avgRps: 100, testDuration: 20 },
			},
			run_b: {
				metadata: { status: "stopped", configuration: { concurrency: 50 } },
				summary: { avgRps: 40, testDuration: 3 },
			},
		};
		const client = fakeClient({
			getRunReport: vi.fn().mockImplementation((id: string) => Promise.resolve(reports[id])),
		});

		const res = await dispatchTool(
			"compare_runs",
			{ baseRunId: "run_a", targetRunId: "run_b" },
			ctxWith(client)
		);

		expect(res.isError).toBeFalsy();
		expect(res.structuredContent).toMatchObject({
			comparability: [
				{ code: "concurrency", base: "10", target: "50" },
				{ code: "duration", base: "20 s", target: "3 s, stopped" },
				{ code: "status", base: "Completed", target: "Stopped" },
			],
		});
		expect(descriptionOf(TOOLS.find((t) => t.name === "compare_runs"))).toMatch(
			/Read comparability before the deltas/
		);
	});

	// #2438: a mismatched pair is refused before any delta leaves.
	describe("compare_runs and the run type", () => {
		const report = (runType: string | undefined, avgRps: number) => ({
			metadata: { status: "completed", ...(runType ? { runType } : {}) },
			summary: { avgRps, testDuration: 15 },
		});
		const compare = (reports: Record<string, unknown>) =>
			dispatchTool(
				"compare_runs",
				{ baseRunId: "run_a", targetRunId: "run_b" },
				ctxWith(
					fakeClient({
						getRunReport: vi
							.fn()
							.mockImplementation((id: string) => Promise.resolve(reports[id])),
					})
				)
			);

		test("a load run against a collection run is refused, naming both runs and types", async () => {
			const res = await compare({
				run_a: report("load", 99.88),
				run_b: report("scenario", 340.6),
			});

			expect(res.isError).toBe(true);
			// The refusal's class and nothing of the comparison.
			expect(Object.keys(res.structuredContent ?? {})).toEqual(["error"]);
			const text = firstText(res);
			expect(text).toContain("run_a (Load test)");
			expect(text).toContain("run_b (Collection run)");
			expect(text).toMatch(/list_runs takes a "type" filter/);
			expect(text).not.toContain("avgRps");
			expect(text).not.toContain("340.6");
		});

		test("two collection runs compare", async () => {
			const res = await compare({
				run_a: report("scenario", 10),
				run_b: report("scenario", 12),
			});

			expect(res.isError).toBeFalsy();
			expect(res.structuredContent).toMatchObject({ comparability: [] });
		});

		test("reports without a run type compare as they always did", async () => {
			const res = await compare({
				run_a: report(undefined, 10),
				run_b: report(undefined, 12),
			});

			expect(res.isError).toBeFalsy();
			expect(res.structuredContent).toMatchObject({ comparability: [] });
		});

		test("the description says a mismatched pair is refused", () => {
			const description = descriptionOf(TOOLS.find((t) => t.name === "compare_runs"));
			expect(description).toMatch(/different types[^.]*refused/);
		});
	});

	/*
	 * Omitting the base is the "did my change regress?" shape: the agent knows
	 * the run it just started and not which older run is the reference. It
	 * resolves through the same endpoint the history view's strip uses, so the
	 * two cannot answer the question about different pairs of runs.
	 */
	test("compare_runs falls back to the target's pinned baseline", async () => {
		const client = fakeClient();
		const res = await dispatchTool("compare_runs", { targetRunId: "run_b" }, ctxWith(client));

		expect(res.isError).toBeFalsy();
		expect(client.getRun).toHaveBeenCalledWith("run_b", undefined);
		expect(client.listBaselineRuns).toHaveBeenCalledWith({ requestId: "req_1" }, undefined);
		expect(client.getRunReport).toHaveBeenCalledWith("run_pinned", undefined);
		expect(firstText(res)).toContain("run_pinned");
	});

	test("compare_runs says so when the request has no baseline pinned", async () => {
		const client = fakeClient({ listBaselineRuns: vi.fn().mockResolvedValue({ data: [] }) });
		const res = await dispatchTool("compare_runs", { targetRunId: "run_b" }, ctxWith(client));

		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/No run is pinned as the baseline/i);
		// And nothing was compared against a run nobody chose.
		expect(client.getRunReport).not.toHaveBeenCalled();
	});

	// A load run over a collection stores no requestId; its snapshot names the
	// collection it drove (#3544).
	const collectionRun = (collectionId = "col_1") =>
		vi.fn().mockResolvedValue({
			id: "run_b",
			requestId: null,
			configSnapshot: { scenario: { collectionId } },
		});

	test("compare_runs resolves a collection load run's baseline through the collection", async () => {
		const client = fakeClient({ getRun: collectionRun() });
		const res = await dispatchTool("compare_runs", { targetRunId: "run_b" }, ctxWith(client));

		expect(res.isError).toBeFalsy();
		expect(client.listBaselineRuns).toHaveBeenCalledWith({ collectionId: "col_1" }, undefined);
		expect(client.getRunReport).toHaveBeenCalledWith("run_pinned", undefined);
	});

	test("compare_runs prefers the saved request when a run names both", async () => {
		const client = fakeClient({
			getRun: vi.fn().mockResolvedValue({
				id: "run_b",
				requestId: "req_9",
				configSnapshot: { scenario: { collectionId: "col_1" } },
			}),
		});
		await dispatchTool("compare_runs", { targetRunId: "run_b" }, ctxWith(client));

		expect(client.listBaselineRuns).toHaveBeenCalledWith({ requestId: "req_9" }, undefined);
	});

	test("compare_runs names the collection when it has no baseline pinned", async () => {
		const client = fakeClient({
			getRun: collectionRun(),
			listBaselineRuns: vi.fn().mockResolvedValue({ data: [] }),
		});
		const res = await dispatchTool("compare_runs", { targetRunId: "run_b" }, ctxWith(client));

		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/No run is pinned as the baseline for collection col_1/);
		expect(client.getRunReport).not.toHaveBeenCalled();
	});

	test("compare_runs names the collection when the target is its own baseline", async () => {
		const client = fakeClient({
			getRun: collectionRun(),
			listBaselineRuns: vi.fn().mockResolvedValue({ data: [{ id: "run_b" }] }),
		});
		const res = await dispatchTool("compare_runs", { targetRunId: "run_b" }, ctxWith(client));

		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/is itself the baseline for collection col_1/);
	});

	test.each([
		["no requestId and no snapshot scenario", { id: "run_b", requestId: null }],
		[
			"a scenario that names no collection",
			{ id: "run_b", requestId: null, configSnapshot: { scenario: {} } },
		],
		[
			"a blank collection id",
			{ id: "run_b", requestId: null, configSnapshot: { scenario: { collectionId: "" } } },
		],
	])(
		"compare_runs says so when the target ran neither a request nor a collection: %s",
		async (_name, run) => {
			const client = fakeClient({ getRun: vi.fn().mockResolvedValue(run) });
			const res = await dispatchTool(
				"compare_runs",
				{ targetRunId: "run_b" },
				ctxWith(client)
			);

			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/did not run a saved request or a collection/i);
			expect(firstText(res)).toContain('"baseRunId"');
			expect(client.listBaselineRuns).not.toHaveBeenCalled();
		}
	);

	test("compare_runs refuses to compare the baseline with itself", async () => {
		const client = fakeClient({
			listBaselineRuns: vi
				.fn()
				.mockResolvedValue({ data: [{ id: "run_b", baseline: true }] }),
		});
		const res = await dispatchTool("compare_runs", { targetRunId: "run_b" }, ctxWith(client));

		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/is itself the baseline/i);
		expect(client.getRunReport).not.toHaveBeenCalled();
	});

	/*
	 * The direction label is the half of a delta a number cannot carry, and an
	 * agent reading `delta: -12` has no other way to know whether that is good.
	 */
	test("compare_runs labels which direction is an improvement", async () => {
		const client = fakeClient({
			getRunReport: vi.fn().mockResolvedValue({
				latency: { p99: 40 },
				summary: { avgRps: 100, totalRequests: 10 },
				statusCodes: {},
			}),
		});
		const res = await dispatchTool(
			"compare_runs",
			{ baseRunId: "run_a", targetRunId: "run_b" },
			ctxWith(client)
		);

		const parsed = JSON.parse(firstText(res)) as {
			latency: Array<{ metric: string; direction: string }>;
			throughput: Array<{ metric: string; direction: string }>;
			reliability: Array<{ metric: string; direction: string }>;
		};
		expect(parsed.latency.find((m) => m.metric === "latency.p99")?.direction).toBe(
			"lower-is-better"
		);
		expect(parsed.throughput.find((m) => m.metric === "summary.avgRps")?.direction).toBe(
			"higher-is-better"
		);
		expect(
			parsed.reliability.find((m) => m.metric === "summary.totalRequests")?.direction
		).toBe("neutral");
	});

	describe("export_run_report", () => {
		const exportWith = (client: EngineClient, args: Record<string, unknown>) =>
			dispatchTool("export_run_report", { runId: "run_b", ...args }, ctxWith(client));

		const lastOptions = (client: EngineClient) =>
			vi.mocked(client.exportRunReport).mock.calls[0][1];

		test("asks for Markdown, the format an agent reads best, without a series", async () => {
			const client = fakeClient();
			const res = await exportWith(client, {});
			expect(res.isError).toBeFalsy();
			expect(client.exportRunReport).toHaveBeenCalledTimes(1);
			expect(vi.mocked(client.exportRunReport).mock.calls[0][0]).toBe("run_b");
			expect(defaultMcpExportFormat).toBe("markdown");
			expect(lastOptions(client)).toEqual({
				format: "markdown",
				series: "none",
				baseRunId: undefined,
			});
			expect(client.listBaselineRuns).not.toHaveBeenCalled();
		});

		test("passes an explicit base run through without a baseline lookup", async () => {
			const client = fakeClient();
			await exportWith(client, { baseRunId: "run_a", format: "json" });
			expect(lastOptions(client)).toEqual({
				format: "json",
				series: "none",
				baseRunId: "run_a",
			});
			expect(client.listBaselineRuns).not.toHaveBeenCalled();
		});

		test("offers JSON on request, for a program that parses the document", async () => {
			const client = fakeClient();
			await exportWith(client, { format: "json" });
			expect(lastOptions(client)).toMatchObject({ format: "json", series: "none" });
		});

		test("baseline: true compares against the run pinned for the request", async () => {
			const client = fakeClient();
			const res = await exportWith(client, { baseline: true });
			expect(res.isError).toBeFalsy();
			expect(lastOptions(client)).toMatchObject({ baseRunId: "run_pinned" });
		});

		test("baseline: true compares a collection load run against the collection's pin", async () => {
			const client = fakeClient({
				getRun: vi.fn().mockResolvedValue({
					id: "run_b",
					requestId: null,
					configSnapshot: { scenario: { collectionId: "col_1" } },
				}),
			});
			const res = await exportWith(client, { baseline: true });
			expect(res.isError).toBeFalsy();
			expect(client.listBaselineRuns).toHaveBeenCalledWith(
				{ collectionId: "col_1" },
				undefined
			);
			expect(lastOptions(client)).toMatchObject({ baseRunId: "run_pinned" });
		});

		test("baseline: true with nothing pinned says so and exports nothing", async () => {
			const client = fakeClient({
				listBaselineRuns: vi.fn().mockResolvedValue({ data: [] }),
			});
			const res = await exportWith(client, { baseline: true });
			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/No run is pinned as the baseline/);
			expect(client.exportRunReport).not.toHaveBeenCalled();
		});

		test("refuses a base run and baseline: true together", async () => {
			const client = fakeClient();
			const res = await exportWith(client, { baseRunId: "run_a", baseline: true });
			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/not both/);
			expect(client.exportRunReport).not.toHaveBeenCalled();
		});

		test("refuses html, naming the Export menu, without asking the engine", async () => {
			const client = fakeClient();
			const res = await exportWith(client, { format: "html" });
			expect(res.isError).toBe(true);
			expect(firstText(res)).toContain("Export menu");
			expect(client.exportRunReport).not.toHaveBeenCalled();
		});

		test("refuses a format that is neither offered nor html", async () => {
			const client = fakeClient();
			const res = await exportWith(client, { format: "yaml" });
			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/"format" must be one of/);
			expect(client.exportRunReport).not.toHaveBeenCalled();
		});

		test("returns the document itself, not the envelope or a JSON-wrapped string", async () => {
			const document = "# Orders\n\n| p99 | 40 ms |\n";
			const client = fakeClient({
				exportRunReport: vi.fn().mockResolvedValue({
					text: document,
					fileName: "Orders.run.md",
					mimeType: "text/markdown",
					notes: {},
				}),
			});
			const res = await exportWith(client, {});
			expect(res.content).toEqual([{ type: "text", text: document }]);
			expect(res.structuredContent).toBeUndefined();
		});

		test("an engine refusal is an error result carrying its sentence", async () => {
			const client = fakeClient({
				exportRunReport: vi
					.fn()
					.mockRejectedValue(
						new EngineRequestError(
							"Engine responded 400",
							400,
							'{"error":{"code":"unsupported_run_type"}}'
						)
					),
			});
			const res = await exportWith(client, {});
			expect(res.isError).toBe(true);
			expect(firstText(res)).toContain("unsupported_run_type");
		});

		test("an answer with no document text is an error, not an empty result", async () => {
			const client = fakeClient({ exportRunReport: vi.fn().mockResolvedValue({}) });
			const res = await exportWith(client, {});
			expect(res.isError).toBe(true);
		});

		test("points at the tools that hold what the document leaves out", () => {
			const description = descriptionOf(TOOLS.find((t) => t.name === "export_run_report"));
			expect(description).toContain("get_run_samples");
			expect(description).toContain("get_run_report");
		});
	});
});

/*
 * Run housekeeping (#755): the History surface an agent could not reach - find a
 * run, page its stored series, pin a baseline, delete one.
 */
describe("run housekeeping tools", () => {
	const forwarded = (client: EngineClient, method: keyof EngineClient) =>
		(client[method] as unknown as ReturnType<typeof vi.fn>).mock.calls[0];

	describe("list_runs", () => {
		test("with no arguments it asks for the documented default page", async () => {
			const client = fakeClient();
			const res = await dispatchTool("list_runs", {}, ctxWith(client));
			expect(res.isError).toBeFalsy();
			expect(forwarded(client, "listRuns")[0]).toEqual({
				limit: DEFAULT_RUN_PAGE_LIMIT,
				offset: 0,
			});
		});

		test("every stated filter reaches the engine verbatim", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"list_runs",
				{
					limit: 10,
					offset: 20,
					type: "scenario",
					status: "failed",
					outcome: "not_judged",
					requestId: "req_1",
					collectionId: "col_1",
					q: "checkout",
					baseline: true,
				},
				ctxWith(client)
			);
			expect(res.isError).toBeFalsy();
			expect(forwarded(client, "listRuns")[0]).toEqual({
				limit: 10,
				offset: 20,
				type: "scenario",
				status: "failed",
				outcome: "not_judged",
				requestId: "req_1",
				collectionId: "col_1",
				q: "checkout",
				baseline: true,
			});
		});

		// #3547: "failed" here is the verdict the app draws, which a `completed`
		// run that missed a budget wears and `status` cannot ask for.
		test.each(["passed", "failed", "not_judged"] as const)(
			"outcome %s is forwarded to the engine as stated",
			async (outcome) => {
				const client = fakeClient();
				const res = await dispatchTool("list_runs", { outcome }, ctxWith(client));
				expect(res.isError).toBeFalsy();
				expect(forwarded(client, "listRuns")[0]).toEqual({
					limit: DEFAULT_RUN_PAGE_LIMIT,
					offset: 0,
					outcome,
				});
			}
		);

		test("baseline: false is forwarded, not dropped as falsy", async () => {
			// "only unpinned runs" is a filter the engine offers; reading `false`
			// as "unset" would silently answer with the pinned ones included.
			const client = fakeClient();
			await dispatchTool("list_runs", { baseline: false }, ctxWith(client));
			expect(forwarded(client, "listRuns")[0]).toMatchObject({ baseline: false });
		});

		test("a filter the caller did not state is absent, not undefined", async () => {
			const client = fakeClient();
			await dispatchTool("list_runs", { type: "design" }, ctxWith(client));
			const query = forwarded(client, "listRuns")[0] as Record<string, unknown>;
			expect("status" in query).toBe(false);
			expect("outcome" in query).toBe(false);
			expect("q" in query).toBe(false);
		});

		test("a limit past the engine's cap is refused, not clamped", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"list_runs",
				{ limit: MAX_ENGINE_PAGE_LIMIT + 1 },
				ctxWith(client)
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toContain(String(MAX_ENGINE_PAGE_LIMIT));
			expect(client.listRuns).not.toHaveBeenCalled();
		});

		test("a negative offset is refused", async () => {
			const client = fakeClient();
			const res = await dispatchTool("list_runs", { offset: -1 }, ctxWith(client));
			expect(res.isError).toBe(true);
			expect(client.listRuns).not.toHaveBeenCalled();
		});

		// #2445: the bound used to ride as a second text block, so page one of
		// 17 runs stopped parsing as JSON exactly when there was a page two.
		test("a page with more behind it is one JSON document carrying the next offset", async () => {
			const client = fakeClient({
				listRuns: vi.fn().mockResolvedValue(page([{ id: "run_1" }], 17)),
			});
			const res = await dispatchTool("list_runs", { limit: 1 }, ctxWith(client));
			expect(res.content).toHaveLength(1);
			const pagination = pageOf(res);
			expect(pagination.hasMore).toBe(true);
			expect(pagination.nextOffset).toBe(1);
			expect(pagination.note).toMatch(/1 of 17 runs, starting at offset 0/);
		});

		// #2820: a guard on the pass-through. The handler adds no shaping that
		// touches resultSummary, so no mutation of today's code reddens it; it
		// fails if row shaping ever starts allow-listing the summary's keys.
		test("a scenario load row's assertion counts reach the agent beside errorRate", async () => {
			const resultSummary = {
				rps: 485,
				p95Ms: 42,
				errorRate: 0,
				assertionsPassed: 10,
				assertionsFailed: 4580,
			};
			const client = fakeClient({
				listRuns: vi.fn().mockResolvedValue(page([{ id: "run_1", resultSummary }])),
			});
			const res = await dispatchTool("list_runs", {}, ctxWith(client));
			const rows = (JSON.parse(firstText(res)) as { data: Array<Record<string, unknown>> })
				.data;
			expect(rows[0].resultSummary).toEqual(resultSummary);
		});

		// #2954: the same pass-through guard for a collection row, whose summary
		// is the step outcomes rather than the load figures.
		test("a collection row's step counts reach the agent unshaped", async () => {
			const resultSummary = {
				passed: 5,
				failed: 2,
				skipped: 1,
				errored: 3,
				verdict: "failed",
			};
			const client = fakeClient({
				listRuns: vi
					.fn()
					.mockResolvedValue(page([{ id: "run_1", type: "scenario", resultSummary }])),
			});
			const res = await dispatchTool("list_runs", {}, ctxWith(client));
			const rows = (JSON.parse(firstText(res)) as { data: Array<Record<string, unknown>> })
				.data;
			expect(rows[0].resultSummary).toEqual(resultSummary);
		});

		test("the last page has a null next offset and no note", async () => {
			const client = fakeClient({
				listRuns: vi.fn().mockResolvedValue(page([{ id: "run_17" }], 17, 16)),
			});
			const res = await dispatchTool("list_runs", { limit: 1, offset: 16 }, ctxWith(client));
			expect(res.content).toHaveLength(1);
			const pagination = pageOf(res);
			expect(pagination.hasMore).toBe(false);
			expect(pagination.nextOffset).toBeNull();
			expect(pagination).not.toHaveProperty("note");
		});
	});

	describe("the stored-series reads", () => {
		test("each defaults to a page a context window can hold", async () => {
			const client = fakeClient();
			await dispatchTool("get_run_samples", { runId: "run_1" }, ctxWith(client));
			await dispatchTool("get_run_timeseries", { runId: "run_1" }, ctxWith(client));
			await dispatchTool("get_run_monitor", { runId: "run_1" }, ctxWith(client));
			expect(forwarded(client, "getRunSamples")).toEqual([
				"run_1",
				DEFAULT_RUN_SAMPLE_LIMIT,
				0,
				undefined,
			]);
			expect(forwarded(client, "getRunTimeSeries")).toEqual([
				"run_1",
				{ limit: DEFAULT_RUN_SERIES_LIMIT, offset: 0 },
				undefined,
			]);
			expect(forwarded(client, "getRunMonitorSeries")).toEqual([
				"run_1",
				{ limit: DEFAULT_RUN_SERIES_LIMIT, offset: 0 },
				undefined,
			]);
		});

		test("get_run_samples tells the agent a base64 body is to be decoded", () => {
			const description = descriptionOf(TOOLS.find((t) => t.name === "get_run_samples"));
			expect(description).toContain('bodyEncoding: "base64"');
			expect(description).toMatch(/base64 in `body`: decode it/);
		});

		test("stated pagination is forwarded", async () => {
			const client = fakeClient();
			await dispatchTool(
				"get_run_timeseries",
				{ runId: "run_1", limit: 250, offset: 500 },
				ctxWith(client)
			);
			expect(forwarded(client, "getRunTimeSeries")).toEqual([
				"run_1",
				{ limit: 250, offset: 500 },
				undefined,
			]);
		});

		describe("maxPoints folds the whole run (#3560)", () => {
			const SERIES_TOOLS = [
				["get_run_timeseries", "getRunTimeSeries"],
				["get_run_monitor", "getRunMonitorSeries"],
			] as const;

			test.each(SERIES_TOOLS)("%s forwards maxPoints and no page", async (tool, method) => {
				const client = fakeClient();
				const res = await dispatchTool(
					tool,
					{ runId: "run_1", maxPoints: 30 },
					ctxWith(client)
				);
				expect(res.isError).toBeFalsy();
				expect(forwarded(client, method)).toEqual(["run_1", { maxPoints: 30 }, undefined]);
			});

			test.each(SERIES_TOOLS)(
				"%s refuses maxPoints beside limit or offset",
				async (tool, method) => {
					const client = fakeClient();
					for (const paging of [{ offset: 100 }, { limit: 50 }, { offset: 0 }]) {
						const res = await dispatchTool(
							tool,
							{ runId: "run_1", maxPoints: 30, ...paging },
							ctxWith(client)
						);
						expect(res.isError, JSON.stringify(paging)).toBe(true);
						expect(res.structuredContent).toMatchObject({ error: { class: "input" } });
						expect(firstText(res)).toContain(`"${Object.keys(paging)[0]}"`);
					}
					expect(client[method]).not.toHaveBeenCalled();
				}
			);

			test.each(SERIES_TOOLS)(
				"%s holds maxPoints to a positive whole number within the page ceiling",
				async (tool, method) => {
					const client = fakeClient();
					for (const maxPoints of [0, -1, 2.5, MAX_RUN_SERIES_LIMIT + 1]) {
						const res = await dispatchTool(
							tool,
							{ runId: "run_1", maxPoints },
							ctxWith(client)
						);
						expect(res.isError, String(maxPoints)).toBe(true);
					}
					expect(client[method]).not.toHaveBeenCalled();
				}
			);

			test("a folded answer keeps bucketed and ticksPerBucket, with no next page", async () => {
				const folded = {
					data: [{ elapsed_seconds: 10 }],
					pagination: { total: 300, limit: 30, offset: 0, hasMore: false, returned: 1 },
					bucketed: true,
					ticksPerBucket: 10,
				};
				const client = fakeClient({ getRunTimeSeries: vi.fn().mockResolvedValue(folded) });
				const res = await dispatchTool(
					"get_run_timeseries",
					{ runId: "run_1", maxPoints: 30 },
					ctxWith(client)
				);
				expect(res.structuredContent).toMatchObject({ bucketed: true, ticksPerBucket: 10 });
				expect(res.structuredContent).not.toHaveProperty("pagination.note");
			});

			test("the descriptions state the fold's semantics", () => {
				const timeseries = descriptionOf(
					TOOLS.find((t) => t.name === "get_run_timeseries")
				);
				expect(timeseries).toMatch(/maxPoints/);
				expect(timeseries).toMatch(/bucketed/);
				expect(timeseries).toMatch(/ticksPerBucket/);
				expect(timeseries).toMatch(/MAX over its ticks/);
				expect(timeseries).toMatch(/current_rps the mean/);
				expect(descriptionOf(TOOLS.find((t) => t.name === "get_run_monitor"))).toMatch(
					/maxPoints[\s\S]*MAX over them/
				);
			});
		});

		describe("get_run_timeseries fields", () => {
			const TICK = {
				timestamp: 1_700_000_000_000,
				elapsed_seconds: 12.5,
				requests_completed: 1500,
				requests_failed: 5,
				http_errors: 3,
				no_response: 2,
				current_rps: 150.5,
				current_concurrency: 100,
				throughput: 149.5,
				error_rate: 0.33,
				status_codes: { "200": 1495, "500": 5 },
				status_seconds: [{ second: 12, span: 1, counts: [149, 0, 0, 1, 0] }],
				latency_p50_ms: 38.5,
				latency_p95_ms: 95.1,
				latency_p99_ms: 120,
			};
			const withTick = () =>
				fakeClient({
					getRunTimeSeries: vi
						.fn()
						.mockResolvedValue(page([TICK, { ...TICK, elapsed_seconds: 13.5 }])),
				});
			const rowsOf = (res: { content: Array<{ text: string }> }) =>
				(JSON.parse(firstText(res)) as { data: Array<Record<string, unknown>> }).data;

			test("summary keeps only the trend keys, on every tick", async () => {
				const res = await dispatchTool(
					"get_run_timeseries",
					{ runId: "run_1", fields: "summary" },
					ctxWith(withTick())
				);
				const rows = rowsOf(res);
				expect(rows).toHaveLength(2);
				for (const row of rows) {
					expect(Object.keys(row).sort()).toEqual(
						[
							"current_rps",
							"elapsed_seconds",
							"error_rate",
							"latency_p95_ms",
							"requests_completed",
							"requests_failed",
						].sort()
					);
				}
				expect(rows[1].elapsed_seconds).toBe(13.5);
			});

			test("a tick with no latency (a second nothing completed) simply lacks the key", async () => {
				const { latency_p95_ms: _dropped, ...quiet } = TICK;
				const client = fakeClient({
					getRunTimeSeries: vi.fn().mockResolvedValue(page([quiet])),
				});
				const res = await dispatchTool(
					"get_run_timeseries",
					{ runId: "run_1", fields: "summary" },
					ctxWith(client)
				);
				expect(rowsOf(res)[0]).not.toHaveProperty("latency_p95_ms");
			});

			test.each([[undefined], ["full"]])(
				"fields %s returns the whole tick",
				async (fields) => {
					const res = await dispatchTool(
						"get_run_timeseries",
						{ runId: "run_1", ...(fields ? { fields } : {}) },
						ctxWith(withTick())
					);
					expect(rowsOf(res)[0]).toEqual(TICK);
				}
			);

			test("summary also trims a folded answer and keeps its envelope", async () => {
				const folded = { ...page([TICK], 300), bucketed: true, ticksPerBucket: 10 };
				const client = fakeClient({ getRunTimeSeries: vi.fn().mockResolvedValue(folded) });
				const res = await dispatchTool(
					"get_run_timeseries",
					{ runId: "run_1", maxPoints: 30, fields: "summary" },
					ctxWith(client)
				);
				expect(res.structuredContent).toMatchObject({ bucketed: true, ticksPerBucket: 10 });
				expect(rowsOf(res)[0]).not.toHaveProperty("status_codes");
			});

			test("an unknown fields value is an input error and reaches no engine", async () => {
				const client = withTick();
				const res = await dispatchTool(
					"get_run_timeseries",
					{ runId: "run_1", fields: "tiny" },
					ctxWith(client)
				);
				expect(res.isError).toBe(true);
				expect(res.structuredContent).toMatchObject({ error: { class: "input" } });
				expect(client.getRunTimeSeries).not.toHaveBeenCalled();
			});

			test("get_run_monitor takes no fields: its samples have no fixed keys", () => {
				const monitor = TOOLS.find((t) => t.name === "get_run_monitor");
				expect(Object.keys(monitor!.inputSchema)).not.toContain("fields");
			});
		});

		test("the series cap is the tool's, well below the engine's 50000", async () => {
			const client = fakeClient();
			for (const tool of ["get_run_timeseries", "get_run_monitor"]) {
				const res = await dispatchTool(
					tool,
					{ runId: "run_1", limit: MAX_RUN_SERIES_LIMIT + 1 },
					ctxWith(client)
				);
				expect(res.isError, tool).toBe(true);
				expect(firstText(res)).toContain(String(MAX_RUN_SERIES_LIMIT));
			}
			expect(client.getRunTimeSeries).not.toHaveBeenCalled();
			expect(client.getRunMonitorSeries).not.toHaveBeenCalled();
		});

		test("samples stop at the engine's own cap", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"get_run_samples",
				{ runId: "run_1", limit: MAX_ENGINE_PAGE_LIMIT + 1 },
				ctxWith(client)
			);
			expect(res.isError).toBe(true);
			expect(client.getRunSamples).not.toHaveBeenCalled();
		});

		test("non-positive pagination is refused on every read", async () => {
			const client = fakeClient();
			for (const [tool, args] of [
				["get_run_samples", { runId: "run_1", limit: 0 }],
				["get_run_timeseries", { runId: "run_1", offset: -5 }],
				["get_run_monitor", { runId: "run_1", limit: 2.5 }],
			] as const) {
				const res = await dispatchTool(tool, args, ctxWith(client));
				expect(res.isError, tool).toBe(true);
			}
			expect(client.getRunSamples).not.toHaveBeenCalled();
			expect(client.getRunTimeSeries).not.toHaveBeenCalled();
			expect(client.getRunMonitorSeries).not.toHaveBeenCalled();
		});

		test("a truncated page discloses what it left behind", async () => {
			const client = fakeClient({
				getRunSamples: vi.fn().mockResolvedValue(page([{ resultId: 1 }], 900, 25)),
			});
			const res = await dispatchTool(
				"get_run_samples",
				{ runId: "run_1", offset: 25 },
				ctxWith(client)
			);
			const text = res.content.map((c) => c.text).join("\n");
			expect(text).toMatch(/1 of 900 captured samples/);
			expect(text).toMatch(/offset: 26/);
		});

		test("a run the engine does not know is an engine error, not an empty page", async () => {
			const client = fakeClient({
				getRunTimeSeries: vi
					.fn()
					.mockRejectedValue(
						new EngineRequestError("Engine responded 404", 404, "Run not found")
					),
			});
			const res = await dispatchTool(
				"get_run_timeseries",
				{ runId: "gone" },
				ctxWith(client)
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toContain('No run with id "gone"');
		});
	});

	describe("every paged read answers one JSON document its outputSchema accepts", () => {
		const PAGED_READS = [
			{ tool: "list_runs", args: {}, method: "listRuns", row: { id: "run_1" } },
			{
				tool: "get_run_samples",
				args: { runId: "run_1" },
				method: "getRunSamples",
				row: { resultId: 1 },
			},
			{
				tool: "get_run_timeseries",
				args: { runId: "run_1" },
				method: "getRunTimeSeries",
				row: { rps: 10 },
			},
			{
				tool: "get_run_monitor",
				args: { runId: "run_1" },
				method: "getRunMonitorSeries",
				row: { cpu: 0.5 },
			},
			{
				tool: "get_inbox_captures",
				args: { inboxId: "inbox_1" },
				method: "getInboxCaptures",
				row: { id: 9 },
			},
			{
				tool: "list_collections",
				args: {},
				method: "listCollectionsPage",
				row: { id: "col_1", name: "API", parentId: null },
			},
			{
				tool: "list_requests",
				args: { collectionId: "col_1" },
				method: "listRequestsPage",
				row: { id: "req_1", name: "Get", method: "GET", url: "https://a.test" },
			},
			{
				tool: "list_requests",
				args: {},
				method: "listRequestsPage",
				row: { id: "req_1", name: "Get", method: "GET", url: "https://a.test" },
			},
			{
				tool: "get_cookies",
				args: {},
				method: "getCookiesPage",
				row: { environmentId: null, name: "sid", domain: "a.test" },
			},
			{
				tool: "list_trash",
				args: {},
				method: "listTrashPage",
				row: { id: "col_9", kind: "collection" },
			},
		] as const;

		/** @p tool's declared outputSchema; its absence fails the case rather than skipping it. */
		function outputSchemaOf(tool: string) {
			const schema = TOOLS.find((t) => t.name === tool)?.outputSchema;
			expect(schema, tool).toBeDefined();
			return schema!;
		}

		test.each(PAGED_READS)(
			"$tool: a page with more behind it",
			async ({ tool, args, method, row }) => {
				const client = fakeClient({ [method]: vi.fn().mockResolvedValue(page([row], 17)) });
				const res = await dispatchTool(tool, { ...args, limit: 1 }, ctxWith(client));
				expect(res.content).toHaveLength(1);
				const pagination = pageOf(res);
				expect(pagination.hasMore).toBe(true);
				expect(pagination.nextOffset).toBe(1);
				expect(pagination.note).toEqual(expect.any(String));
				expect(() => outputSchemaOf(tool).parse(res.structuredContent)).not.toThrow();
			}
		);

		test.each(PAGED_READS)("$tool: the last page", async ({ tool, args, method, row }) => {
			const client = fakeClient({ [method]: vi.fn().mockResolvedValue(page([row], 17, 16)) });
			const res = await dispatchTool(tool, { ...args, offset: 16 }, ctxWith(client));
			expect(res.content).toHaveLength(1);
			const pagination = pageOf(res);
			expect(pagination.nextOffset).toBeNull();
			expect(pagination).not.toHaveProperty("note");
			expect(() => outputSchemaOf(tool).parse(res.structuredContent)).not.toThrow();
		});

		// The schema would reject a bare non-object, and the SDK reports that as
		// a broken tool while hiding the engine's body.
		test.each(PAGED_READS)(
			"$tool: a non-object answer is wrapped, not refused",
			async ({ tool, args, method }) => {
				const client = fakeClient({ [method]: vi.fn().mockResolvedValue(null) });
				const res = await dispatchTool(tool, args, ctxWith(client));
				expect(res.isError).toBeFalsy();
				expect(res.structuredContent).toEqual({ raw: null });
				expect(() => outputSchemaOf(tool).parse(res.structuredContent)).not.toThrow();
			}
		);
	});

	describe("set_run_baseline", () => {
		test("is refused while writes are off", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"set_run_baseline",
				{ runId: "run_1", baseline: true },
				ctxWith(client, { allowWrites: false })
			);
			expect(res.isError).toBe(true);
			expect(client.setRunBaseline).not.toHaveBeenCalled();
		});

		test("pins and unpins through the one tool", async () => {
			for (const baseline of [true, false]) {
				const client = fakeClient();
				const res = await dispatchTool(
					"set_run_baseline",
					{ runId: "run_1", baseline },
					ctxWith(client, { allowWrites: true })
				);
				expect(res.isError).toBeFalsy();
				expect(client.setRunBaseline).toHaveBeenCalledWith("run_1", baseline, undefined);
			}
		});

		test("a missing or non-boolean baseline is an argument error", async () => {
			const client = fakeClient();
			for (const args of [{ runId: "run_1" }, { runId: "run_1", baseline: "true" }]) {
				const res = await dispatchTool(
					"set_run_baseline",
					args,
					ctxWith(client, { allowWrites: true })
				);
				expect(res.isError).toBe(true);
				expect(firstText(res)).toMatch(/baseline/);
			}
			expect(client.setRunBaseline).not.toHaveBeenCalled();
		});

		test("a pin is what compare_runs then resolves with no baseRunId", async () => {
			// The pair the issue is about: #472 built the resolution and never the
			// write, so the only way to pin was the app's own sidebar.
			let pinned: string | null = null;
			const client = fakeClient({
				setRunBaseline: vi.fn(async (runId: string, baseline: boolean) => {
					pinned = baseline ? runId : null;
					return { id: runId, baseline };
				}),
				listBaselineRuns: vi.fn(async () => ({ data: pinned ? [{ id: pinned }] : [] })),
			});
			const ctx = ctxWith(client, { allowWrites: true });

			const unpinned = await dispatchTool("compare_runs", { targetRunId: "run_b" }, ctx);
			expect(unpinned.isError).toBe(true);

			await dispatchTool("set_run_baseline", { runId: "run_a", baseline: true }, ctx);
			const compared = await dispatchTool("compare_runs", { targetRunId: "run_b" }, ctx);
			expect(compared.isError).toBeFalsy();
			expect(compared.structuredContent).toMatchObject({
				baseRunId: "run_a",
				targetRunId: "run_b",
			});
		});

		test("says a collection load run is pinned for its collection", () => {
			const description = descriptionOf(TOOLS.find((t) => t.name === "set_run_baseline"));
			expect(description).toMatch(/saved request or collection/);
			// The "reads nothing" claim holds only for a run with neither.
			expect(description).toMatch(/A run of neither[^.]*changes what nothing reads/);
		});

		test("is not hinted destructive - it is undone by calling it again", () => {
			const tool = TOOLS.find((t) => t.name === "set_run_baseline");
			expect(tool?.category).toBe("write");
			expect(tool?.annotations.destructiveHint).toBe(false);
			expect(tool?.annotations.idempotentHint).toBe(true);
		});
	});

	describe("delete_run", () => {
		test("is refused while writes are off, without even reading the run", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"delete_run",
				{ runId: "run_1", confirmed: true },
				ctxWith(client, { allowWrites: false })
			);
			expect(res.isError).toBe(true);
			expect(client.getRun).not.toHaveBeenCalled();
			expect(client.deleteRun).not.toHaveBeenCalled();
		});

		test("names the run in its preview and deletes nothing", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"delete_run",
				{ runId: "run_b" },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			expect(firstText(res)).toMatch(/awaiting confirmation/i);
			expect(firstText(res)).toContain("load run run_b");
			expect(firstText(res)).toContain("https://api.example.com/users");
			// Epoch milliseconds are rendered, not printed at a human.
			expect(firstText(res)).toContain("2025-08-12T");
			expect(client.deleteRun).not.toHaveBeenCalled();
		});

		describe("a credential typed into the run's url (#1909)", () => {
			const runWith = (url: string) =>
				vi.fn().mockResolvedValue({
					id: "run_b",
					type: "load",
					status: "completed",
					startTime: 1_755_000_000_000,
					configSnapshot: { url },
				});

			test("is masked in the preview by its name, with the rest of the url kept", async () => {
				const client = fakeClient({
					getRun: runWith("https://api.example.com/users?api_key=LITERAL-KEY&page=2"),
				});
				const res = await dispatchTool(
					"delete_run",
					{ runId: "run_b" },
					ctxWith(client, { allowWrites: true })
				);
				expect(firstText(res)).not.toContain("LITERAL-KEY");
				expect(firstText(res)).toContain("api_key=<redacted>&page=2");
				expect(client.deleteRun).not.toHaveBeenCalled();
			});

			test("is shown as written with reveal on, and no secret is read to know it", async () => {
				const client = fakeClient({
					getRun: runWith("https://api.example.com/users?api_key=LITERAL-KEY&page=2"),
				});
				const res = await dispatchTool(
					"delete_run",
					{ runId: "run_b" },
					ctxWith(client, { allowWrites: true, revealSecretsToAgents: true })
				);
				expect(firstText(res)).toContain("api_key=LITERAL-KEY&page=2");
				expect(client.getGlobals).not.toHaveBeenCalled();
			});

			test("withholds the whole call when the masking cannot be built, deleting nothing", async () => {
				const client = fakeClient({
					getRun: runWith("https://api.example.com/users?api_key=LITERAL-KEY"),
					getGlobals: vi.fn().mockRejectedValue(new Error("engine hiccup")),
				});
				const res = await dispatchTool(
					"delete_run",
					{ runId: "run_b", confirmed: true },
					ctxWith(client, { allowWrites: true })
				);
				expect(res.isError).toBe(true);
				expect(firstText(res)).not.toContain("LITERAL-KEY");
				expect(client.deleteRun).not.toHaveBeenCalled();
			});
		});

		test("deletes once confirmed", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"delete_run",
				{ runId: "run_b", confirmed: true },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			expect(client.deleteRun).toHaveBeenCalledWith("run_b", undefined);
		});

		test("answers a missing id as such, not as a transport failure", async () => {
			const client = fakeClient({
				getRun: vi
					.fn()
					.mockRejectedValue(
						new EngineRequestError("Engine responded 404", 404, "Run not found")
					),
			});
			const res = await dispatchTool(
				"delete_run",
				{ runId: "run_gone", confirmed: true },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toContain("run_gone");
			expect(client.deleteRun).not.toHaveBeenCalled();
		});

		test("a run still stopping is reported as not deleted, with the retry", async () => {
			// The engine refuses rather than half-deletes a run whose worker is
			// still writing. Reported as a generic engine error, an agent would
			// read "409" and could not tell whether the run survived.
			const client = fakeClient({
				deleteRun: vi
					.fn()
					.mockRejectedValue(
						new EngineRequestError("Engine responded 409", 409, "still stopping")
					),
			});
			const res = await dispatchTool(
				"delete_run",
				{ runId: "run_b", confirmed: true },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/NOT deleted/);
			expect(firstText(res)).toMatch(/again/i);
		});
	});
});
