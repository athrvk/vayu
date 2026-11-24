/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import {
	dispatchTool,
	MAX_REDIRECTS_BOUND,
	MAX_RESPONSE_SAMPLE_PERIOD,
	MAX_RESPONSE_SAMPLES_BOUND,
	MAX_RETRY_AFTER_MAX_MS,
	MAX_SLOW_THRESHOLD_MS,
	MAX_SUCCESS_SAMPLE_PERIOD,
	resolveDescription,
	TOOLS,
} from "../tools.js";
import { argumentsSchema } from "./kit.js";
import { MCP_CAP_CEILINGS, resolveSafetyConfig, type McpSafetyConfig } from "../config.js";
import { ENGINE_LOAD_DEFAULTS, LOAD_MODES } from "../safety.js";
import { EngineRequestError, type EngineClient } from "../engine-client.js";
import { LOAD_TEST_LIMITS, RESPONSE_SAMPLES_CEILING } from "@/constants/load-test";
import { listingEnv1, fakeClient, ctxWith, firstText, ctxAsking } from "../tools.testkit.js";

describe("start_load_run scenario runs", () => {
	function scenarioLoadClient(overrides: Partial<Record<keyof EngineClient, unknown>> = {}) {
		return fakeClient({
			listEnvironments: listingEnv1(),
			listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "login" }]),
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "https://api.example.com/login" }),
			...overrides,
		});
	}

	const allowed = { allowlist: ["api.example.com"] };

	test("posts the scenario block beside the load shape", async () => {
		const client = scenarioLoadClient();
		const rows = [{ id: "1" }];
		const res = await dispatchTool(
			"start_load_run",
			{
				scenario: { collectionId: "c1", recursive: true, data: rows },
				mode: "constant_concurrency",
				concurrency: 5,
				duration: "30s",
				environmentId: "env_1",
				confirmed: true,
			},
			ctxWith(client, allowed)
		);
		expect(res.isError).toBeFalsy();
		expect((client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({
			mode: "constant_concurrency",
			scenario: { source: "collection", collectionId: "c1", recursive: true, data: rows },
			environmentId: "env_1",
			concurrency: 5,
			duration: "30s",
			origin: { kind: "mcp" },
			targetPolicy: { allowAll: false, allowedHosts: ["api.example.com"] },
		});
	});

	test("forwards scenario.dataFileName, dataFileHash and dataFileCastNumbers inside the block (#2051)", async () => {
		const client = scenarioLoadClient();
		const rows = [{ id: "1" }];
		const hash = "c".repeat(64);
		const res = await dispatchTool(
			"start_load_run",
			{
				scenario: {
					collectionId: "c1",
					data: rows,
					dataFileName: "users.csv",
					dataFileHash: hash,
					dataFileCastNumbers: true,
				},
				confirmed: true,
			},
			ctxWith(client, allowed)
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.scenario).toMatchObject({
			data: rows,
			dataFileName: "users.csv",
			dataFileHash: hash,
			dataFileCastNumbers: true,
		});
		expect(payload).not.toHaveProperty("dataFileName");
	});

	test("an un-allowlisted step's refusal names the host and withholds the resolved URL (#1892)", async () => {
		const client = scenarioLoadClient({
			getGlobals: vi.fn().mockResolvedValue({
				id: "globals",
				variables: { api_key: { value: "SECRETVALUE", secret: true, enabled: true } },
			}),
			listRequests: vi.fn().mockResolvedValue([
				{ id: "r1", name: "login" },
				{ id: "r2", name: "offsite" },
			]),
			composeRequest: vi.fn().mockImplementation(({ requestId }: { requestId: string }) =>
				Promise.resolve({
					method: "GET",
					url:
						requestId === "r2"
							? "https://evil.test/x?api_key=SECRETVALUE"
							: "https://api.example.com/login",
				})
			),
		});
		const res = await dispatchTool(
			"start_load_run",
			{ scenario: { collectionId: "c1" }, confirmed: true },
			ctxWith(client, allowed)
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/step 1 \(request 'offsite', id 'r2'\)/);
		expect(firstText(res)).toMatch(/evil\.test/);
		expect(firstText(res)).not.toMatch(/SECRETVALUE/);
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("refuses the single-target arguments by name instead of ignoring them", async () => {
		const client = scenarioLoadClient();
		for (const [key, value] of [
			["url", "https://api.example.com/x"],
			["requestId", "req_1"],
			["method", "POST"],
			["auth", { mode: "bearer", token: "t" }],
			["postRequestScript", "pm.test('ok', () => {})"],
			["collectionId", "c1"],
			["maxInFlight", 10],
			["stream", true],
			["sloMs", 500],
			// The single-target row set (issue #993): a sequence states its rows
			// as `scenario.data`, and they bind per iteration there rather than
			// per request sent, so a payload carrying both would have one of the
			// two silently dropped.
			["data", [{ id: "1" }]],
			// And the single-target file name and hash beside it (issue #2051):
			// a sequence names its rows' file inside the block.
			["dataFileName", "users.csv"],
			["dataFileHash", "c".repeat(64)],
			["dataFileCastNumbers", true],
			// The send's default-header refusals (issue #1337): the engine reads
			// them off one request's payload, and a scenario's steps are each
			// composed from their own saved request, so a run-level list would be
			// an argument written and never read.
			["disabledDefaultHeaders", ["User-Agent"]],
		] as Array<[string, unknown]>) {
			const res = await dispatchTool(
				"start_load_run",
				{ scenario: { collectionId: "c1" }, [key]: value, confirmed: true },
				ctxWith(client, allowed)
			);
			expect(res.isError, key).toBe(true);
			expect(firstText(res), key).toContain(`"${key}"`);
			expect(firstText(res), key).toMatch(/do not apply to a scenario load run/);
		}
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("forwards the timers/scripts override on a scenario run", async () => {
		// The engine's validator owns the shape and the value ranges
		// (issue #1495) - this layer only has to get the keys to it unchanged.
		const client = scenarioLoadClient();
		const res = await dispatchTool(
			"start_load_run",
			{
				scenario: { collectionId: "c1" },
				elements: { timers: "off", scripts: "allInline" },
				confirmed: true,
			},
			ctxWith(client, allowed)
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.elements).toEqual({ timers: "off", scripts: "allInline" });
	});

	test("forwards the stream caps on a scenario run, which bound its streaming steps", async () => {
		// Accepted without `stream` here (#3235): whether a step streams is its
		// saved request's own setting, and only the bounds belong to the run.
		const client = scenarioLoadClient();
		const res = await dispatchTool(
			"start_load_run",
			{
				scenario: { collectionId: "c1" },
				maxStreamDurationMs: 20_000,
				maxStreamEvents: 50,
				confirmed: true,
			},
			ctxWith(client, allowed)
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.maxStreamDurationMs).toBe(20_000);
		expect(payload.maxStreamEvents).toBe(50);
		expect(payload).not.toHaveProperty("stream");
	});

	test("sends no stream cap on a scenario run when the agent named none", async () => {
		const client = scenarioLoadClient();
		await dispatchTool(
			"start_load_run",
			{ scenario: { collectionId: "c1" }, confirmed: true },
			ctxWith(client, allowed)
		);
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload).not.toHaveProperty("maxStreamDurationMs");
		expect(payload).not.toHaveProperty("maxStreamEvents");
	});

	test("still refuses `stream` on a scenario run, and says where it is set", async () => {
		const client = scenarioLoadClient();
		const res = await dispatchTool(
			"start_load_run",
			{ scenario: { collectionId: "c1" }, stream: true, maxStreamEvents: 5, confirmed: true },
			ctxWith(client, allowed)
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain('"stream"');
		expect(firstText(res)).toMatch(/saved request's Event stream setting/);
		// The cap beside it is accepted, so the refusal does not name it.
		expect(firstText(res)).not.toContain('"maxStreamEvents"');
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("sends no elements key when none was declared", () => {
		const shape = TOOLS.find((t) => t.name === "start_load_run")!.inputSchema as Record<
			string,
			z.ZodType
		>;
		const parsed = argumentsSchema(shape).parse({ scenario: { collectionId: "c1" } });
		expect(parsed.elements).toBeUndefined();
	});

	test("rejects an elements value the engine does not accept", () => {
		// The engine's set is closed (asConfigured|off, asMarked|allInline|
		// allDeferred); a typo should be caught here rather than reaching
		// POST /runs as an unrecognised value.
		const shape = TOOLS.find((t) => t.name === "start_load_run")!.inputSchema as Record<
			string,
			z.ZodType
		>;
		const schema = argumentsSchema(shape);
		expect(() =>
			schema.parse({ scenario: { collectionId: "c1" }, elements: { timers: "disabled" } })
		).toThrow();
		expect(() =>
			schema.parse({ scenario: { collectionId: "c1" }, elements: { scripts: "inline" } })
		).toThrow();
	});

	// Issue #1594: a single target's own `requestElements` now has a pipeline
	// for the run-level override to reach, so `elements` is accepted here too,
	// not only beside `scenario`.
	test("accepts an elements override on a single-target run", async () => {
		const client = scenarioLoadClient();
		const res = await dispatchTool(
			"start_load_run",
			{ url: "https://api.example.com/x", elements: { timers: "off" }, confirmed: true },
			ctxWith(client, allowed)
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
			string,
			unknown
		>;
		expect(payload.elements).toEqual({ timers: "off" });
	});

	test("declares elements as usable on both a scenario and a single target", () => {
		const shape = TOOLS.find((t) => t.name === "start_load_run")!.inputSchema as Record<
			string,
			z.ZodType
		>;
		expect(shape.elements).toBeDefined();
		expect(shape.elements.description).not.toMatch(/Scenario runs only/);
		// The positive half: not merely "doesn't say scenario-only" (which an
		// empty or unrelated description would also pass), but actually says
		// the single-target case works.
		expect(shape.elements.description).toMatch(/single target/i);
	});

	/**
	 * The schema gate is the design-mode runner's (issue #766): no load path
	 * reads `failOnSchemaError`, so both of this tool's paths refuse it rather
	 * than starting a run whose flag nothing applies. It is *declared* on the
	 * tool so the refusal can name the executor; an undeclared key gets only the
	 * schema's `Unrecognized key`.
	 */
	test.each([
		["a scenario", { scenario: { collectionId: "c1" } }],
		["a single target", { url: "https://api.example.com/x" }],
	])("refuses failOnSchemaError beside %s, naming the executor", async (_label, target) => {
		const client = scenarioLoadClient();
		for (const value of [true, false]) {
			const res = await dispatchTool(
				"start_load_run",
				{ ...target, failOnSchemaError: value, confirmed: true },
				ctxWith(client, allowed)
			);
			expect(res.isError, String(value)).toBe(true);
			expect(firstText(res), String(value)).toContain('"failOnSchemaError"');
			expect(firstText(res), String(value)).toMatch(/once the run has drained/);
			// The surface that does honour it, so the refusal is a redirection.
			expect(firstText(res), String(value)).toMatch(/run_collection/);
		}
		expect(client.startRun).not.toHaveBeenCalled();
		expect(client.composeRequest).not.toHaveBeenCalled();
	});

	test("declares failOnSchemaError so the refusal survives schema validation", () => {
		// An argument the schema does not declare is refused by the schema
		// before the handler runs, with no word on the surface that honours it.
		const shape = TOOLS.find((t) => t.name === "start_load_run")!.inputSchema as Record<
			string,
			z.ZodType
		>;
		expect(shape.failOnSchemaError).toBeDefined();
		expect(shape.failOnSchemaError.description).toMatch(/Not available on a load run/);
	});

	/**
	 * `stopOnError` is the design-mode runner's too (issue #2526), refused on the
	 * same terms and for the same reason: declared so the handler's refusal,
	 * which names run_collection, is what the agent reads.
	 */
	test.each([
		["a scenario", { scenario: { collectionId: "c1" } }],
		["a single target", { url: "https://api.example.com/x" }],
	])("refuses stopOnError beside %s, pointing at run_collection", async (_label, target) => {
		const client = scenarioLoadClient();
		for (const value of [true, false]) {
			const res = await dispatchTool(
				"start_load_run",
				{ ...target, stopOnError: value, confirmed: true },
				ctxWith(client, allowed)
			);
			expect(res.isError, String(value)).toBe(true);
			expect(firstText(res), String(value)).toContain('"stopOnError"');
			expect(firstText(res), String(value)).toMatch(/run_collection/);
		}
		expect(client.startRun).not.toHaveBeenCalled();
		expect(client.composeRequest).not.toHaveBeenCalled();
	});

	test("declares stopOnError so the refusal survives schema validation", () => {
		const shape = TOOLS.find((t) => t.name === "start_load_run")!.inputSchema as Record<
			string,
			z.ZodType
		>;
		expect(shape.stopOnError).toBeDefined();
		expect(shape.stopOnError.description).toMatch(/Not available on a load run/);
	});

	test("refuses the two modes the engine cannot drive, with its reasoning", async () => {
		const client = scenarioLoadClient();
		const capacity = await dispatchTool(
			"start_load_run",
			{ scenario: { collectionId: "c1" }, mode: "capacity", confirmed: true },
			ctxWith(client, allowed)
		);
		expect(capacity.isError).toBe(true);
		expect(firstText(capacity)).toMatch(/one p99 per level/);
		expect(firstText(capacity)).toMatch(/constant_concurrency, ramp_up, iterations/);

		const rps = await dispatchTool(
			"start_load_run",
			{ scenario: { collectionId: "c1" }, mode: "constant_rps", confirmed: true },
			ctxWith(client, allowed)
		);
		expect(rps.isError).toBe(true);
		expect(firstText(rps)).toMatch(/arrival-rate executor/);

		// The rate itself is what selects that path, whatever mode is declared.
		const rate = await dispatchTool(
			"start_load_run",
			{
				scenario: { collectionId: "c1" },
				mode: "constant_concurrency",
				targetRps: 50,
				confirmed: true,
			},
			ctxWith(client, allowed)
		);
		expect(rate.isError).toBe(true);
		expect(firstText(rate)).toMatch(/closed-loop by design/);
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("refuses a cloud-metadata monitor URL before anything is started", async () => {
		const client = scenarioLoadClient();
		const res = await dispatchTool(
			"start_load_run",
			{
				scenario: { collectionId: "c1" },
				monitor: { url: "http://169.254.169.254/latest/meta-data/", series: ["up"] },
				confirmed: true,
			},
			ctxWith(client, allowed)
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/not on the MCP allowlist/i);
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("applies the load caps to virtual users, duration and iterations", async () => {
		const client = scenarioLoadClient();
		const vus = await dispatchTool(
			"start_load_run",
			{ scenario: { collectionId: "c1" }, concurrency: 5000, confirmed: true },
			ctxWith(client, { ...allowed, maxConcurrency: 50 })
		);
		expect(vus.isError).toBe(true);
		expect(firstText(vus)).toMatch(/concurrency 5000 exceeds the MCP cap of 50/);

		const duration = await dispatchTool(
			"start_load_run",
			{ scenario: { collectionId: "c1" }, duration: "2h", confirmed: true },
			ctxWith(client, { ...allowed, maxDurationSeconds: 300 })
		);
		expect(duration.isError).toBe(true);
		expect(firstText(duration)).toMatch(/exceeds the MCP cap of 300s/);

		const iterations = await dispatchTool(
			"start_load_run",
			{
				scenario: { collectionId: "c1" },
				mode: "iterations",
				iterations: 999_999,
				confirmed: true,
			},
			ctxWith(client, { ...allowed, maxIterations: 1000 })
		);
		expect(iterations.isError).toBe(true);
		expect(firstText(iterations)).toMatch(/exceeds the MCP cap of 1000/);
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("injects the capped duration when the caller omitted one", async () => {
		const client = scenarioLoadClient();
		await dispatchTool(
			"start_load_run",
			{ scenario: { collectionId: "c1" }, confirmed: true },
			ctxWith(client, { ...allowed, maxDurationSeconds: 20 })
		);
		// The engine's own default is 60s, so a 20s cap only binds if it is sent.
		expect((client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
			duration: "20s",
		});
	});

	test("gates every step on the allowlist before anything is started", async () => {
		const client = scenarioLoadClient({
			listRequests: vi.fn().mockResolvedValue([
				{ id: "r1", name: "login" },
				{ id: "r2", name: "offsite" },
			]),
			composeRequest: vi.fn().mockImplementation(({ requestId }: { requestId: string }) =>
				Promise.resolve({
					method: "GET",
					url:
						requestId === "r2"
							? "https://evil.test/x"
							: "https://api.example.com/login",
				})
			),
		});
		const res = await dispatchTool(
			"start_load_run",
			{ scenario: { collectionId: "c1" }, confirmed: true },
			ctxWith(client, allowed)
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/step 1 \(request 'offsite', id 'r2'\)/);
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("previews the planned run and starts nothing until confirmed", async () => {
		const client = scenarioLoadClient();
		const preview = await dispatchTool(
			"start_load_run",
			{ scenario: { collectionId: "c1" }, concurrency: 4 },
			ctxWith(client, allowed)
		);
		expect(preview.isError).toBeFalsy();
		expect(firstText(preview)).toMatch(/AWAITING CONFIRMATION/);
		expect(firstText(preview)).toMatch(/1 step\(s\) per iteration/);
		expect(client.startRun).not.toHaveBeenCalled();

		const started = await dispatchTool(
			"start_load_run",
			{ scenario: { collectionId: "c1" }, concurrency: 4, confirmed: true },
			ctxWith(client, allowed)
		);
		expect(started.isError).toBeFalsy();
		expect(client.startRun).toHaveBeenCalledTimes(1);
	});

	test("a declined question starts nothing", async () => {
		const client = scenarioLoadClient();
		const ctx = ctxAsking(client, allowed, { confirm: { action: "decline" } });
		const res = await dispatchTool("start_load_run", { scenario: { collectionId: "c1" } }, ctx);
		expect(firstText(res)).toMatch(/declined/);
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("the scenario block offers no iterations of its own", () => {
		// A load run reads the top-level `iterations`; `scenario.iterations` is the
		// design runner's pass count and the load executor never looks at it, so
		// offering it here would be an argument written and never read.
		const tool = TOOLS.find((t) => t.name === "start_load_run");
		const shape = (
			tool!.inputSchema.scenario as z.ZodOptional<z.ZodObject<Record<string, z.ZodType>>>
		)._def.innerType.shape;
		expect(Object.keys(shape).sort()).toEqual([
			"collectionId",
			"data",
			"dataFileCastNumbers",
			"dataFileHash",
			"dataFileName",
			"recursive",
		]);
	});
});

/**
 * A field the agent leaves out is the engine's default for the mode, and the
 * tool sends it explicitly (#2437): the caps judge the run that will start, the
 * preview and the result say what it is, and the stored run records it.
 */
describe("start_load_run resolves and states the load shape", () => {
	const allowed = { allowlist: ["api.example.com"] };
	const SHAPE_FIELDS = [
		"mode",
		"concurrency",
		"startConcurrency",
		"duration",
		"rampUpDuration",
		"iterations",
		"targetRps",
	];

	const parseArgs = (args: Record<string, unknown>) =>
		argumentsSchema(
			TOOLS.find((t) => t.name === "start_load_run")!.inputSchema as Record<string, z.ZodType>
		).parse(args);

	/** The `POST /runs` payload's load-shape fields, and nothing else. */
	async function sentShape(
		args: Record<string, unknown>,
		safety: Partial<McpSafetyConfig> = allowed,
		client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "login" }]),
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "https://api.example.com/login" }),
		})
	) {
		const res = await dispatchTool(
			"start_load_run",
			{ ...args, confirmed: true },
			ctxWith(client, safety)
		);
		expect(res.isError, firstText(res)).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
			string,
			unknown
		>;
		return Object.fromEntries(
			SHAPE_FIELDS.filter((k) => k in payload).map((k) => [k, payload[k]])
		);
	}

	test("an unconfigured run sends concurrency: 100 and duration: 60s", async () => {
		expect(await sentShape(parseArgs({ url: "https://api.example.com" }))).toEqual({
			mode: "constant_concurrency",
			concurrency: 100,
			duration: "60s",
		});
	});

	test.each([
		["constant_concurrency", {}, { concurrency: 100, duration: "60s" }],
		["constant_rps", { targetRps: 50 }, { targetRps: 50, duration: "60s" }],
		[
			"ramp_up",
			{},
			{ concurrency: 100, startConcurrency: 1, duration: "60s", rampUpDuration: "10s" },
		],
		["iterations", {}, { iterations: 1000, concurrency: 10 }],
		["capacity", {}, { concurrency: 100, duration: "300s" }],
	])("a %s run sends its row of defaults", async (mode, extra, row) => {
		const sent = await sentShape({ url: "https://api.example.com", mode, ...extra });
		expect(sent).toEqual({ mode, ...row });
	});

	test.each([
		["constant_concurrency", { concurrency: 10, duration: "60s" }],
		[
			"ramp_up",
			{ concurrency: 10, startConcurrency: 1, duration: "60s", rampUpDuration: "10s" },
		],
		["iterations", { iterations: 1000, concurrency: 10 }],
	])("a scenario %s run sends the scenario executor's row", async (mode, row) => {
		const sent = await sentShape({ scenario: { collectionId: "c1" }, mode });
		expect(sent).toEqual({ mode, ...row });
	});

	test("a stated value is never overridden", async () => {
		const ramp = {
			mode: "ramp_up",
			concurrency: 7,
			startConcurrency: 3,
			duration: "45s",
			rampUpDuration: "5s",
		};
		expect(await sentShape({ url: "https://api.example.com", ...ramp })).toEqual(ramp);
		const iterations = { mode: "iterations", iterations: 20, concurrency: 2 };
		expect(await sentShape({ url: "https://api.example.com", ...iterations })).toEqual(
			iterations
		);
	});

	test("a targetRps with no mode is a constant_rps run and sends no concurrency", async () => {
		const sent = await sentShape({ url: "https://api.example.com", targetRps: 100 });
		expect(sent).toEqual({ mode: "constant_rps", targetRps: 100, duration: "60s" });
	});

	test("no mode and no rate stays constant_concurrency, and a zero rate is no rate", async () => {
		expect(await sentShape({ url: "https://api.example.com" })).toMatchObject({
			mode: "constant_concurrency",
		});
		expect(await sentShape({ url: "https://api.example.com", targetRps: 0 })).toEqual({
			mode: "constant_concurrency",
			concurrency: 100,
			targetRps: 0,
			duration: "60s",
		});
	});

	test("a stated mode is never replaced by the rate, and the engine's refusal reaches the agent", async () => {
		// One rule in one place (#2396): the tool forwards the rate and the engine
		// answers it, rather than a second copy of the rule resolving it away.
		const refusal =
			"'targetRps' selects an open-loop arrival rate and is only available for mode 'constant_rps'; for 'constant_concurrency' set 'concurrency' instead, or send a rate of 0.";
		const client = fakeClient({
			startRun: vi
				.fn()
				.mockRejectedValue(
					new EngineRequestError(
						"Engine responded 400",
						400,
						JSON.stringify({ error: refusal })
					)
				),
		});
		const res = await dispatchTool(
			"start_load_run",
			{
				url: "https://api.example.com",
				mode: "constant_concurrency",
				targetRps: 100,
				confirmed: true,
			},
			ctxWith(client, allowed)
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain("Engine error (400)");
		expect(firstText(res)).toContain("only available for mode 'constant_rps'");
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload).toMatchObject({ mode: "constant_concurrency", targetRps: 100 });
	});

	test("the rate cap judges a rate on any mode, the inferred constant_rps included", async () => {
		const tight = { ...allowed, maxRps: 1000 };
		for (const mode of [undefined, "constant_rps", "constant_concurrency"]) {
			const client = fakeClient();
			const res = await dispatchTool(
				"start_load_run",
				{
					url: "https://api.example.com",
					...(mode ? { mode } : {}),
					targetRps: 5000,
					confirmed: true,
				},
				ctxWith(client, tight)
			);
			expect(res.isError, String(mode)).toBe(true);
			expect(firstText(res), String(mode)).toMatch(
				/targetRps 5000 exceeds the MCP cap of 1000/
			);
			expect(client.startRun).not.toHaveBeenCalled();
		}
	});

	test("the preview states the shape in words and plans the resolved fields", async () => {
		const client = fakeClient();
		const preview = firstText(
			await dispatchTool(
				"start_load_run",
				{ url: "https://api.example.com" },
				ctxWith(client, allowed)
			)
		);
		expect(preview).toContain("(constant_concurrency, 100 virtual users, closed loop, 60 s)?");
		expect(preview).toContain('"concurrency":100');
		expect(preview).toContain('"duration":"60s"');
		expect(client.startRun).not.toHaveBeenCalled();

		const paced = firstText(
			await dispatchTool(
				"start_load_run",
				{ url: "https://api.example.com", targetRps: 25, duration: "2m" },
				ctxWith(client, allowed)
			)
		);
		expect(paced).toContain("(constant_rps, 25 requests/s, open loop, 120 s)?");

		// A stated mode keeps its own wording: only constant_rps is open loop.
		const closed = firstText(
			await dispatchTool(
				"start_load_run",
				{
					url: "https://api.example.com",
					mode: "constant_concurrency",
					targetRps: 25,
					duration: "2m",
				},
				ctxWith(client, allowed)
			)
		);
		expect(closed).toContain("(constant_concurrency, 100 virtual users, closed loop, 120 s)?");
		expect(closed).not.toContain("open loop");
	});

	test("the started result carries the shape beside nextStep", async () => {
		const res = await dispatchTool(
			"start_load_run",
			{ url: "https://api.example.com", confirmed: true },
			ctxWith(fakeClient(), allowed)
		);
		const structured = res.structuredContent as Record<string, unknown>;
		expect(structured.shape).toEqual({
			mode: "constant_concurrency",
			concurrency: 100,
			duration: "60s",
			closedLoop: true,
		});
		expect(structured.nextStep).toContain("every 6 s");
	});

	test("an omitted concurrency is judged on the default it resolves to", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			{ url: "https://api.example.com", confirmed: true },
			ctxWith(client, { ...allowed, maxConcurrency: 50 })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/concurrency 100 exceeds the MCP cap of 50 virtual users/);
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("an omitted capacity concurrency is judged on the engine's search ceiling", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			{ url: "https://api.example.com", mode: "capacity", confirmed: true },
			ctxWith(client, { ...allowed, maxConcurrency: 50 })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/concurrency 100 exceeds the MCP cap of 50 virtual users/);
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("a duration cap under the default is sent in its place", async () => {
		const sent = await sentShape(
			{ url: "https://api.example.com" },
			{
				...allowed,
				maxDurationSeconds: 30,
			}
		);
		expect(sent.duration).toBe("30s");
	});

	test("a misspelt mode is a schema refusal naming the five modes", () => {
		const result = argumentsSchema(
			TOOLS.find((t) => t.name === "start_load_run")!.inputSchema as Record<string, z.ZodType>
		).safeParse({ url: "https://api.example.com", mode: "constant-rps" });
		expect(result.success).toBe(false);
		const message = result.error!.issues.map((issue) => issue.message).join("\n");
		expect(LOAD_MODES).toHaveLength(5);
		for (const mode of LOAD_MODES) expect(message).toContain(`"${mode}"`);
	});

	test("every input with an engine default states it in its description", () => {
		const shape = TOOLS.find((t) => t.name === "start_load_run")!.inputSchema as Record<
			string,
			z.ZodType
		>;
		// Table field -> the input it fills, and how the value is written there.
		const inputs: Record<string, [string, (value: number) => string]> = {
			concurrency: ["concurrency", String],
			startConcurrency: ["startConcurrency", String],
			iterations: ["iterations", String],
			durationSeconds: ["duration", (value) => `${value}s`],
			rampUpDurationSeconds: ["rampUpDuration", (value) => `${value}s`],
		};
		let checked = 0;
		for (const mode of LOAD_MODES) {
			for (const [field, value] of Object.entries(ENGINE_LOAD_DEFAULTS[mode])) {
				if (typeof value !== "number") continue;
				const [input, written] = inputs[field];
				expect(shape[input].description, `${input} for ${mode}`).toMatch(
					new RegExp(`\\b${written(value)} \\([^)]*\\b${mode}\\b`)
				);
				checked++;
			}
		}
		expect(checked).toBeGreaterThan(0);
		expect(shape.mode.description).toMatch(/default constant_concurrency/);
		expect(shape.mode.description).toMatch(/or constant_rps given `targetRps`/);
		expect(shape.targetRps.description).toMatch(
			/constant_rps only; the engine refuses it on other modes/
		);
	});
});

/**
 * The run-recording knobs the app's load dialog has always sent, reachable over
 * MCP for the first time (issue #760).
 *
 * The load-bearing assertions are the payload *keys*: these three are the only
 * snake_case fields on `POST /runs`, and a camelCase spelling reaches the engine
 * as an unread key rather than an error - a knob an agent believes it set and no
 * run ever reads.
 */
describe("start_load_run recording knobs", () => {
	const allow = { allowlist: ["api.example.com"] };
	const started = (client: EngineClient) =>
		(client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;

	async function start(args: Record<string, unknown>, client = fakeClient()) {
		const res = await dispatchTool(
			"start_load_run",
			{ url: "https://api.example.com/users", confirmed: true, ...args },
			ctxWith(client, allow)
		);
		return { res, client };
	}

	test("each knob travels under the engine's own key", async () => {
		const { res, client } = await start({
			successSamplePeriod: 5,
			slowRequestThresholdMs: 750,
			saveTimingBreakdown: true,
			comment: "nightly baseline",
		});

		expect(res.isError).toBeFalsy();
		expect(started(client)).toMatchObject({
			success_sample_rate: 5,
			slow_threshold_ms: 750,
			save_timing_breakdown: true,
			comment: "nightly baseline",
		});
		// The camelCase argument names must not also reach the engine: it reads
		// the snake_case ones and would ignore these in silence.
		for (const camel of [
			"successSamplePeriod",
			"slowRequestThresholdMs",
			"saveTimingBreakdown",
		]) {
			expect(started(client)).not.toHaveProperty(camel);
		}
	});

	// Retry-After back-off (#3782) is camelCase on the wire, unlike the knobs
	// above. Mutation check: drop the two pairs from LOAD_RECORDING_FIELDS in
	// `compose.ts` and this fails, which is the accepted-and-dropped argument.
	test("forwards Retry-After back-off and its cap under the engine's own keys", async () => {
		const { res, client } = await start({ retryAfterBackoff: true, retryAfterMaxMs: 5000 });

		expect(res.isError).toBeFalsy();
		expect(started(client)).toMatchObject({ retryAfterBackoff: true, retryAfterMaxMs: 5000 });
	});

	test("sends no Retry-After keys when the caller named none", async () => {
		const { client } = await start({ comment: "just a note" });
		expect(started(client)).not.toHaveProperty("retryAfterBackoff");
		expect(started(client)).not.toHaveProperty("retryAfterMaxMs");
	});

	test("bounds the Retry-After cap at the engine's range", () => {
		const schema = argumentsSchema(
			TOOLS.find((t) => t.name === "start_load_run")!.inputSchema as Record<string, z.ZodType>
		);
		// The dialog's range is the engine's, which `load-test.engine-parity.test.ts` pins.
		expect(MAX_RETRY_AFTER_MAX_MS).toBe(LOAD_TEST_LIMITS.RETRY_AFTER_MAX_MS.MAX);
		expect(schema.safeParse({ retryAfterMaxMs: 0 }).success).toBe(false);
		expect(schema.safeParse({ retryAfterMaxMs: 1 }).success).toBe(true);
		expect(schema.safeParse({ retryAfterMaxMs: MAX_RETRY_AFTER_MAX_MS }).success).toBe(true);
		expect(schema.safeParse({ retryAfterMaxMs: MAX_RETRY_AFTER_MAX_MS + 1 }).success).toBe(
			false
		);
		expect(schema.safeParse({ retryAfterBackoff: "yes" }).success).toBe(false);
	});

	// The rows go through untouched (issue #993): every rule about what a set may
	// be lives engine-side, so a second copy of them here could only drift - and
	// a set the schema quietly dropped would be a run of literal `{{data.*}}`
	// tokens that reads as the feature working.
	test("forwards a data set verbatim, under the engine's own key", async () => {
		const rows = [{ id: "1" }, { id: "2" }];
		const { res, client } = await start({ data: rows });

		expect(res.isError).toBeFalsy();
		expect(started(client)).toMatchObject({ data: rows });
	});

	test("sends no `data` key when the caller named no rows", async () => {
		const { client } = await start({ comment: "just a note" });
		expect(started(client)).not.toHaveProperty("data");
		expect(started(client)).not.toHaveProperty("dataFileName");
		expect(started(client)).not.toHaveProperty("dataFileHash");
		expect(started(client)).not.toHaveProperty("dataFileCastNumbers");
	});

	// Mutation check: drop the `dataFileCastNumbers` forward in start_load_run's
	// handler and the reading is lost (#2540).
	test("forwards the rows' file name, hash and reading at the top level (#2051)", async () => {
		const rows = [{ id: "1" }];
		const hash = "c".repeat(64);
		const { res, client } = await start({
			data: rows,
			dataFileName: "users.csv",
			dataFileHash: hash,
			dataFileCastNumbers: true,
		});

		expect(res.isError).toBeFalsy();
		expect(started(client)).toMatchObject({
			data: rows,
			dataFileName: "users.csv",
			dataFileHash: hash,
			dataFileCastNumbers: true,
		});
	});

	test("a knob the caller did not name is absent, not defaulted", async () => {
		const { client } = await start({ comment: "just a note" });
		const payload = started(client);

		// Each has an engine-side default a stated value would overwrite; a
		// defaulted `save_timing_breakdown: false` here would switch off tracing
		// for a caller that never mentioned it.
		for (const key of ["success_sample_rate", "slow_threshold_ms", "save_timing_breakdown"]) {
			expect(payload).not.toHaveProperty(key);
		}
	});

	test("a sampling period of 0 is refused at the schema, not sent as a divide by zero", () => {
		const schema = argumentsSchema(
			TOOLS.find((t) => t.name === "start_load_run")!.inputSchema as Record<string, z.ZodType>
		);
		expect(schema.safeParse({ successSamplePeriod: 0 }).success).toBe(false);
		expect(schema.safeParse({ successSamplePeriod: 1 }).success).toBe(true);
		expect(
			schema.safeParse({ successSamplePeriod: MAX_SUCCESS_SAMPLE_PERIOD + 1 }).success
		).toBe(false);
		// 0 disables outlier capture and is legal; a negative would mark every
		// completion an outlier.
		expect(schema.safeParse({ slowRequestThresholdMs: 0 }).success).toBe(true);
		expect(schema.safeParse({ slowRequestThresholdMs: -1 }).success).toBe(false);
		expect(
			schema.safeParse({ slowRequestThresholdMs: MAX_SLOW_THRESHOLD_MS + 1 }).success
		).toBe(false);
	});

	/**
	 * The two response-sample keys (#2447). They are the engine's own
	 * snake_case spellings and a camelCase one would reach it as an unread key,
	 * so the assertion is on the payload, for both load paths.
	 */
	test("the response-sample knobs travel under the engine's own keys", async () => {
		const { res, client } = await start({ responseSamplePeriod: 10, maxResponseSamples: 50 });

		expect(res.isError).toBeFalsy();
		expect(started(client)).toMatchObject({
			response_sample_rate: 10,
			max_response_samples: 50,
		});
		expect(started(client)).not.toHaveProperty("responseSamplePeriod");
		expect(started(client)).not.toHaveProperty("maxResponseSamples");
	});

	test("zero samples is a legal request and is sent, not dropped", async () => {
		const { client } = await start({ maxResponseSamples: 0 });
		expect(started(client)).toMatchObject({ max_response_samples: 0 });
	});

	test("the response-sample knobs are absent when not named", async () => {
		const { client } = await start({ comment: "just a note" });
		expect(started(client)).not.toHaveProperty("response_sample_rate");
		expect(started(client)).not.toHaveProperty("max_response_samples");
	});

	test("the confirmation preview shows both knobs", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			{
				url: "https://api.example.com/users",
				responseSamplePeriod: 10,
				maxResponseSamples: 50,
			},
			ctxWith(client, allow)
		);

		expect(client.startRun).not.toHaveBeenCalled();
		expect(firstText(res)).toMatch(/"response_sample_rate":10/);
		expect(firstText(res)).toMatch(/"max_response_samples":50/);
	});

	test("a scenario load run carries the response-sample knobs", async () => {
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([{ id: "req_1", name: "Step", order: 0 }]),
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "https://api.example.com/step" }),
		});
		const res = await dispatchTool(
			"start_load_run",
			{
				scenario: { collectionId: "col_1" },
				confirmed: true,
				responseSamplePeriod: 10,
				maxResponseSamples: 50,
			},
			ctxWith(client, allow)
		);

		expect(res.isError).toBeFalsy();
		expect(started(client)).toMatchObject({
			response_sample_rate: 10,
			max_response_samples: 50,
		});
	});

	test("the schema holds the response-sample knobs to the engine's bounds", () => {
		const schema = argumentsSchema(
			TOOLS.find((t) => t.name === "start_load_run")!.inputSchema as Record<string, z.ZodType>
		);
		// A period of 0 is a division by zero engine-side.
		expect(schema.safeParse({ responseSamplePeriod: 0 }).success).toBe(false);
		expect(schema.safeParse({ responseSamplePeriod: 1 }).success).toBe(true);
		expect(schema.safeParse({ responseSamplePeriod: MAX_RESPONSE_SAMPLE_PERIOD }).success).toBe(
			true
		);
		expect(
			schema.safeParse({ responseSamplePeriod: MAX_RESPONSE_SAMPLE_PERIOD + 1 }).success
		).toBe(false);
		expect(schema.safeParse({ maxResponseSamples: -1 }).success).toBe(false);
		expect(schema.safeParse({ maxResponseSamples: 0 }).success).toBe(true);
		expect(schema.safeParse({ maxResponseSamples: MAX_RESPONSE_SAMPLES_BOUND }).success).toBe(
			true
		);
		expect(
			schema.safeParse({ maxResponseSamples: MAX_RESPONSE_SAMPLES_BOUND + 1 }).success
		).toBe(false);
	});

	/**
	 * The chain `load-test.engine-parity.test.ts` starts: that file ties the
	 * renderer's ceiling to the engine header and route, this ties the MCP
	 * schema bound and the cap's ceiling to the renderer's.
	 */
	test("the schema bound and the cap's ceiling are the engine's maximum", () => {
		expect(MAX_RESPONSE_SAMPLES_BOUND).toBe(RESPONSE_SAMPLES_CEILING);
		expect(MCP_CAP_CEILINGS.maxResponseSamples).toBe(RESPONSE_SAMPLES_CEILING);
		expect(MAX_RESPONSE_SAMPLE_PERIOD).toBe(100_000);
	});

	test("a sample count above the MCP cap is refused before anything starts", async () => {
		const tight = { ...allow, maxResponseSamples: 100 };
		const client = fakeClient();
		const single = await dispatchTool(
			"start_load_run",
			{ url: "https://api.example.com/users", confirmed: true, maxResponseSamples: 101 },
			ctxWith(client, tight)
		);
		const scenario = await dispatchTool(
			"start_load_run",
			{ scenario: { collectionId: "col_1" }, confirmed: true, maxResponseSamples: 101 },
			ctxWith(client, tight)
		);

		for (const res of [single, scenario]) {
			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/maxResponseSamples 101 exceeds the MCP cap of 100/);
		}
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("a cap below the engine default refuses a run that states no count", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			{ url: "https://api.example.com/users", confirmed: true },
			ctxWith(client, { ...allow, maxResponseSamples: 100 })
		);

		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/maxResponseSamples 1000 \(the engine's default/);
		expect(client.startRun).not.toHaveBeenCalled();
	});

	/**
	 * The "written but never read" guard for descriptions, in both directions
	 * (#3555). A switch the sample reader says `start_load_run` sets has to be an
	 * argument an agent can pass, and it has to be one that changes what the
	 * reader returns: `get_run_samples` reads the engine's error, slow-outlier and
	 * first-per-status captures, which only `slowRequestThresholdMs` widens. The
	 * two response-sample arguments size the script and schema replay's
	 * population, so neither tool may attribute the other's reader to them.
	 * Scoped to the sentence naming `start_load_run`, because the same description
	 * also names the *output* fields (`resultId`, `bodyTruncated`) of a sample.
	 */
	test("get_run_samples names only the start_load_run arguments that change its capture", () => {
		const CHANGES_CAPTURE = ["slowRequestThresholdMs"];
		const samples = TOOLS.find((t) => t.name === "get_run_samples")!;
		const load = TOOLS.find((t) => t.name === "start_load_run")!;
		const description = resolveDescription(samples, resolveSafetyConfig());
		const sentences = description.split(". ").filter((s) => s.includes("start_load_run"));
		const named = [
			...new Set(sentences.flatMap((s) => s.match(/\b[a-z]+(?:[A-Z][a-z]+)+\b/g) ?? [])),
		];

		// A scan that found nothing would pass forever.
		expect(named).toEqual(CHANGES_CAPTURE);
		expect(description).toMatch(/about three per status code/);
		for (const name of named) {
			expect(Object.keys(load.inputSchema), `${name} is named by get_run_samples`).toContain(
				name
			);
		}
	});

	test("responseSamplePeriod and maxResponseSamples describe the replay, not get_run_samples", () => {
		const load = TOOLS.find((t) => t.name === "start_load_run")!;
		const loadSentences = resolveDescription(load, resolveSafetyConfig())
			.split(". ")
			.filter((x) => /responseSamplePeriod|maxResponseSamples/.test(x));
		expect(loadSentences.length).toBeGreaterThan(0);
		for (const sentence of loadSentences) expect(sentence).not.toContain("get_run_samples");
		for (const name of ["responseSamplePeriod", "maxResponseSamples"]) {
			const description = (load.inputSchema[name] as z.ZodType).description ?? "";
			expect(description, name).not.toBe("");
			expect(description, name).not.toContain("get_run_samples");
			expect(description, name).toMatch(/replay/);
		}
	});

	/**
	 * `POST /runs` has no guard on `maxRedirects` - it reaches
	 * the engine's redirect chain, where a negative means *unlimited*
	 * (`redirect_limit_reached`) - so this schema is the only thing between `-1`
	 * and a run that follows chains forever.
	 */
	test("the redirect policy reaches composition, and a negative ceiling is refused", async () => {
		const { client } = await start({ followRedirects: false, maxRedirects: 3 });
		const composed = (client.composeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
			request: Record<string, unknown>;
		};

		expect(composed.request).toMatchObject({ followRedirects: false, maxRedirects: 3 });

		const schema = argumentsSchema(
			TOOLS.find((t) => t.name === "start_load_run")!.inputSchema as Record<string, z.ZodType>
		);
		expect(schema.safeParse({ maxRedirects: -1 }).success).toBe(false);
		expect(schema.safeParse({ maxRedirects: 0 }).success).toBe(true);
		expect(schema.safeParse({ maxRedirects: MAX_REDIRECTS_BOUND + 1 }).success).toBe(false);
	});

	/**
	 * Both executors read them off the same `RunContext`, so forwarding on one
	 * path only would be a knob that silently does nothing on the other.
	 */
	test("a scenario load run carries the same knobs", async () => {
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([{ id: "req_1", name: "Step", order: 0 }]),
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "https://api.example.com/step" }),
		});
		const res = await dispatchTool(
			"start_load_run",
			{
				scenario: { collectionId: "col_1" },
				confirmed: true,
				successSamplePeriod: 2,
				slowRequestThresholdMs: 900,
				saveTimingBreakdown: true,
				retryAfterBackoff: true,
				retryAfterMaxMs: 1500,
				comment: "scenario soak",
			},
			ctxWith(client, allow)
		);

		expect(res.isError).toBeFalsy();
		expect(started(client)).toMatchObject({
			success_sample_rate: 2,
			slow_threshold_ms: 900,
			save_timing_breakdown: true,
			retryAfterBackoff: true,
			retryAfterMaxMs: 1500,
			comment: "scenario soak",
		});
	});

	test("a scenario run refuses the redirect policy by name - each step keeps its own", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			{ scenario: { collectionId: "col_1" }, confirmed: true, followRedirects: true },
			ctxWith(client, allow)
		);

		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/followRedirects/);
		expect(firstText(res)).toMatch(/stored redirect policy/i);
		expect(client.startRun).not.toHaveBeenCalled();
	});
});
