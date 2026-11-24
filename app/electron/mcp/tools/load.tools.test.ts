/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { dispatchTool, MAX_IN_FLIGHT_BOUND, TOOLS } from "../tools.js";
import { composeLoadRunRequest } from "./compose.js";
import { EngineRequestError, type EngineClient } from "../engine-client.js";
import { LOAD_TEST_LIMITS } from "@/constants/load-test";
import {
	descriptionOf,
	fakeClient,
	ctxWith,
	firstText,
	parseArgs,
	composedSavedRequest,
	savedRequestClient,
} from "../tools.testkit.js";

describe("start_load_run headers (#2466)", () => {
	const allowed = { allowlist: ["api.example.com"] };
	const composeClient = () =>
		fakeClient({
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "https://api.example.com/x" }),
		});
	const composedRequest = (client: EngineClient) =>
		(client.composeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0].request as Record<
			string,
			unknown
		>;
	const send = (client: EngineClient, headers: unknown) =>
		dispatchTool(
			"start_load_run",
			{
				url: "https://api.example.com/x",
				headers,
				mode: "constant_concurrency",
				concurrency: 1,
				duration: "5s",
				confirmed: true,
			},
			ctxWith(client, allowed)
		);

	test("takes ordered lines and composes them as given", async () => {
		const client = composeClient();
		const lines = [
			{ name: "Link", value: "<a>; rel=next" },
			{ name: "Link", value: "<b>; rel=prev" },
		];
		const res = await send(client, lines);
		expect(res.isError).toBeFalsy();
		expect(composedRequest(client).headers).toEqual(lines);
	});

	test("still takes the string map", async () => {
		const client = composeClient();
		const res = await send(client, { "X-Tenant": "acme" });
		expect(res.isError).toBeFalsy();
		expect(composedRequest(client).headers).toEqual({ "X-Tenant": "acme" });
	});

	test("declares both shapes in the schema the client reads", () => {
		const shape = TOOLS.find((t) => t.name === "start_load_run")!.inputSchema as Record<
			string,
			z.ZodType
		>;
		expect(shape.headers.safeParse([{ name: "A", value: "1" }]).success).toBe(true);
		expect(shape.headers.safeParse({ A: "1" }).success).toBe(true);
		expect(shape.headers.safeParse([{ name: "A" }]).success).toBe(false);
	});
});

describe("dispatchTool", () => {
	test("start_load_run does not offer a pre-request script", () => {
		// POST /runs never runs one - only the deferred `tests` script - so
		// offering the field would promise a hook that silently does nothing.
		// The renderer's load path sends no pre-request script either, so this
		// asymmetry is the app's, not MCP's.
		const loadRun = TOOLS.find((t) => t.name === "start_load_run");
		expect(loadRun).toBeDefined();
		expect(Object.keys(loadRun!.inputSchema)).not.toContain("preRequestScript");
		expect(Object.keys(loadRun!.inputSchema)).toContain("tests");
	});

	test("start_load_run offers scenario runs rather than deferring them", () => {
		// #454 scoped them out and said so in the description; #754 reversed that.
		// The description is where an agent learns a collection can be the target
		// at all, so it has to name the argument and what `concurrency` becomes.
		const loadRun = TOOLS.find((t) => t.name === "start_load_run");
		expect(descriptionOf(loadRun)).toMatch(/scenario/i);
		expect(descriptionOf(loadRun)).toMatch(/virtual users/);
		expect(descriptionOf(loadRun)).not.toMatch(/cannot be started from here/);
		expect(Object.keys(loadRun!.inputSchema)).toContain("scenario");
	});

	test("start_load_run names the simulated-user count 'virtual users', not in-flight or concurrency (#2128)", () => {
		// The app's one word for this number. The parameter names keep
		// `concurrency`; their descriptions are what an agent reads, so they carry
		// the same wording the UI does.
		const shape = TOOLS.find((t) => t.name === "start_load_run")!.inputSchema as Record<
			string,
			z.ZodType
		>;
		for (const field of ["concurrency", "startConcurrency", "stepDuration"]) {
			expect(shape[field].description, field).toMatch(/virtual user/i);
		}
		// `concurrency` is not a rate-paced run's target, and the description says so.
		expect(shape.concurrency.description).toMatch(/constant_rps/);
		expect(shape.concurrency.description).not.toMatch(/^Target in-flight requests/);
	});

	test("both execute-shaped tools name the validation script the same way", () => {
		// One field in the app - the request builder's Tests tab - drives both
		// Send and a load run. It reached the engine under two names
		// (`postRequestScript` on /execute, `tests` on /runs), and MCP exposed
		// whichever name its endpoint used, so a script an agent wrote for
		// run_request could not be handed to start_load_run unchanged.
		for (const name of ["run_request", "start_load_run"]) {
			const shape = TOOLS.find((t) => t.name === name)!.inputSchema as Record<
				string,
				z.ZodType
			>;
			expect(Object.keys(shape)).toContain("postRequestScript");
			// The engine's own spelling stays accepted on both: dropping it from
			// either tool would refuse a script an agent wrote in that spelling.
			expect(Object.keys(shape)).toContain("tests");
		}
	});

	test("start_load_run sends postRequestScript to /runs as a script.post element", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				confirmed: true,
				postRequestScript: "pm.test('ok', function () {});",
			}),
			ctxWith(client, { allowlist: ["api.example.com"], revealSecretsToAgents: true })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.requestElements).toEqual([
			{
				id: "mcp-script-post",
				kind: "script.post",
				enabled: true,
				config: { script: "pm.test('ok', function () {});" },
			},
		]);
		// The retired flat field (issue #1594's cut-over): POST /runs refuses it
		// by name now, so it must never be built for this payload.
		expect(payload.tests).toBeUndefined();
		expect(payload.postRequestScript).toBeUndefined();
	});

	test("start_load_run defers the {{$guid}} family to per-iteration generation", async () => {
		// A load run repeats this composed payload once per iteration, per
		// virtual user, so the generator family must not be resolved at this
		// one-time composition (issue #995).
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				confirmed: true,
			}),
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const composeBody = (client.composeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(composeBody.deferDynamicVariables).toBe(true);
	});

	describe("start_load_run tells /compose which bare names are data columns (issue #2956)", () => {
		// Without `dataColumns` the engine cannot tell a bare `{{email}}` meant
		// for the row from one meant for the environment, and the environment
		// variable of the same name answers at composition.
		const composedWith = async (data: unknown) => {
			const client = fakeClient();
			await composeLoadRunRequest(
				{ url: "https://api.example.com", data },
				ctxWith(client, { allowlist: ["api.example.com"] })
			);
			return (client.composeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		};

		test("sends the union of every row's keys, first seen first", async () => {
			// Ragged rows: the engine binds the union, so the second row's `plan`
			// and the third row's `region` must not be lost to a first-row read.
			const composeBody = await composedWith([
				{ email: "a@example.com", id: 1 },
				{ email: "b@example.com", plan: "pro" },
				{ id: 3, region: "eu" },
			]);

			expect(composeBody.dataColumns).toEqual(["email", "id", "plan", "region"]);
		});

		test("skips a row that is not an object, and an empty key", async () => {
			const composeBody = await composedWith([
				"stray",
				null,
				["array"],
				{ email: "a@example.com", "": "unnamed" },
			]);

			expect(composeBody.dataColumns).toEqual(["email"]);
		});

		test.each([
			["no data", undefined],
			["an empty data array", []],
			["rows with no keys", [{}, {}]],
			["rows that are not objects", ["x", 1]],
		])("sends no dataColumns key for %s", async (_label, data) => {
			const composeBody = await composedWith(data);

			expect("dataColumns" in composeBody).toBe(false);
		});

		test("reaches the engine through the tool, from the parsed data argument", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"start_load_run",
				parseArgs("start_load_run", {
					url: "https://api.example.com",
					confirmed: true,
					data: [{ email: "a@example.com" }],
				}),
				ctxWith(client, { allowlist: ["api.example.com"] })
			);

			expect(res.isError).toBeFalsy();
			const composeBody = (client.composeRequest as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			expect(composeBody.dataColumns).toEqual(["email"]);
		});
	});

	test("start_load_run forwards thresholds under the engine's own metric keys", async () => {
		// The keys travel verbatim to POST /runs and come back in the report's
		// thresholdValidation, so a rename anywhere on this path is a budget
		// the engine rejects - or worse, one it accepts and never judges.
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				confirmed: true,
				thresholds: { latencyP99Ms: 50, maxErrorRatePct: 0.1 },
			}),
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.thresholds).toEqual({ latencyP99Ms: 50, maxErrorRatePct: 0.1 });
	});

	test("start_load_run forwards a custom.<name>.<stat> threshold key (issue #1500)", async () => {
		// A key `thresholdsInput` cannot name, so its object is open by design
		// (`catchall`); the engine's own validate_thresholds is the real gate on
		// the key's shape.
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				confirmed: true,
				thresholds: { "custom.ttfb2.p95": 50 },
			}),
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.thresholds).toEqual({ "custom.ttfb2.p95": 50 });
	});

	test("start_load_run forwards the monitor block to /runs unchanged", async () => {
		// The keys are the engine's own and `validate_run_config` is what judges
		// them, so anything renamed or dropped on this path is a scrape the run
		// silently never performs.
		const client = fakeClient();
		const monitor = {
			url: "http://localhost:9100/metrics",
			intervalMs: 2000,
			format: "prometheus" as const,
			series: ["process_cpu_seconds_total", "go_memstats_heap_inuse_bytes"],
		};
		const res = await dispatchTool(
			"start_load_run",
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				confirmed: true,
				monitor,
			}),
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.monitor).toEqual(monitor);
	});

	test("start_load_run sends no monitor key when none was asked for", () => {
		const parsed = parseArgs("start_load_run", { url: "https://api.example.com" });
		expect(parsed.monitor).toBeUndefined();
	});

	test("start_load_run allows a loopback monitor beside a non-loopback target", async () => {
		// The allowlist decision, in the shape that motivates it: the target is a
		// public host on the list, the vitals endpoint is the machine's own
		// exporter and is on no list at all.
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				confirmed: true,
				monitor: { url: "http://127.0.0.1:9100/metrics", series: ["up"] },
			}),
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		expect((client.startRun as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
	});

	test("start_load_run refuses a public monitor host that is not allowlisted", async () => {
		// The other half of the same decision - and the run must not start, since
		// a refusal that still generated load would be no guard at all.
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				confirmed: true,
				monitor: { url: "https://metrics.evil.test/m", series: ["up"] },
			}),
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/monitor endpoint is a second host/i);
		expect((client.startRun as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
	});

	test.each([
		"http://169.254.169.254/latest/meta-data/",
		"http://[fd00:ec2::254]/latest/meta-data/",
	])(
		"start_load_run refuses the cloud-metadata monitor %s before starting the run",
		async (url) => {
			// A private address, but one that serves credentials rather than the
			// user's exporter, so it needs the allowlist entry a public host does (#2370).
			const client = fakeClient();
			const res = await dispatchTool(
				"start_load_run",
				parseArgs("start_load_run", {
					url: "https://api.example.com",
					confirmed: true,
					monitor: { url, series: ["up"] },
				}),
				ctxWith(client, { allowlist: ["api.example.com"] })
			);

			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/not on the MCP allowlist/i);
			expect((client.startRun as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
		}
	);

	test("start_load_run leaves the monitor block's ranges to the engine", () => {
		// Deliberate: `monitor.series`' ceiling is the `monitorMaxSeries` setting,
		// so a copy of it here would refuse blocks the engine accepts. The schema
		// types the shape only - a wrong *type* is still caught.
		expect(() =>
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				monitor: { url: "http://localhost:9100/m", intervalMs: 1, series: ["a"] },
			})
		).not.toThrow();
		expect(() =>
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				monitor: { url: "http://localhost:9100/m", series: "cpu" },
			})
		).toThrow();
		expect(() =>
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				monitor: { series: ["a"] },
			})
		).toThrow();
	});

	test("start_load_run sends no thresholds key when none were declared", () => {
		// An empty object is a 400 from POST /runs, so "no budgets" has to be
		// an absent key rather than an empty one.
		const parsed = parseArgs("start_load_run", { url: "https://api.example.com" });
		expect(parsed.thresholds).toBeUndefined();
		expect(() =>
			parseArgs("start_load_run", { url: "https://api.example.com", thresholds: {} })
		).toThrow(/at least one budget/i);
	});

	test("start_load_run rejects a budget the engine would reject", () => {
		// The schema's bounds mirror the engine's so the agent is told which
		// field is wrong, rather than meeting an HTTP 400 with no field named.
		expect(() =>
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				thresholds: { maxErrorRatePct: 150 },
			})
		).toThrow();
		expect(() =>
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				thresholds: { latencyP99Ms: 0 },
			})
		).toThrow();
	});

	test("start_load_run holds the stream budgets to the engine's bounds (#3234)", () => {
		// The catchall for `custom.*` keys takes any number, so a stream key the
		// schema did not name would pass at 0 or below and meet the engine's 400
		// with no field named.
		const stream = (thresholds: Record<string, number>) =>
			parseArgs("start_load_run", { url: "https://api.example.com", thresholds });
		expect(stream({ streamTimeToFirstEventP95Ms: 800 }).thresholds).toEqual({
			streamTimeToFirstEventP95Ms: 800,
		});
		expect(stream({ streamEventsPerSecondMin: 200 }).thresholds).toEqual({
			streamEventsPerSecondMin: 200,
		});
		// Mutation check: drop the key from the schema and the catchall takes the
		// 0 below as a number, so the engine's 400 is the only refusal.
		expect(stream({ streamTimeToFirstMatchP95Ms: 900 }).thresholds).toEqual({
			streamTimeToFirstMatchP95Ms: 900,
		});
		const refused: Record<string, number>[] = [
			{ streamTimeToFirstEventP95Ms: 0 },
			{ streamTimeToFirstEventP95Ms: 86_400_001 },
			{ streamTimeToFirstMatchP95Ms: 0 },
			{ streamTimeToFirstMatchP95Ms: 86_400_001 },
			{ streamEventsPerSecondMin: 0 },
			{ streamEventsPerSecondMin: -1 },
			{ streamEventsPerSecondMin: 1_000_000_001 },
		];
		for (const bad of refused) {
			expect(() => stream(bad), JSON.stringify(bad)).toThrow();
		}
	});

	// run_collection states the thresholds argument for both tools (#3747).
	test("thresholds says the stream budgets need a streaming run (#3234)", () => {
		const shape = TOOLS.find((t) => t.name === "run_collection")!.inputSchema as Record<
			string,
			z.ZodType
		>;
		const description = shape.thresholds.description ?? "";
		expect(description).toContain("streamTimeToFirstEventP95Ms");
		expect(description).toContain("streamTimeToFirstMatchP95Ms");
		expect(description).toContain("streamFirstContentMarker");
		expect(description).toContain("streamEventsPerSecondMin");
		expect(description).toContain("not evaluated and count as failed");
	});

	test("start_load_run still accepts the agent argument name `tests` as the same script", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				confirmed: true,
				tests: "pm.test('a', () => {});",
			}),
			ctxWith(client, { allowlist: ["api.example.com"], revealSecretsToAgents: true })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.requestElements).toEqual([
			{
				id: "mcp-script-post",
				kind: "script.post",
				enabled: true,
				config: { script: "pm.test('a', () => {});" },
			},
		]);
		expect(payload.tests).toBeUndefined();
	});

	test("run_request accepts `tests` as the same script as postRequestScript", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"run_request",
			parseArgs("run_request", {
				url: "https://api.example.com/users",
				tests: "pm.test('b', () => {});",
			}),
			ctxWith(client, { allowlist: ["api.example.com"], revealSecretsToAgents: true })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		// The alias resolves to the same `script.post` element the other name
		// builds - one concept, one wire shape.
		expect(payload.elements).toEqual([
			{
				id: "mcp-script-post",
				kind: "script.post",
				enabled: true,
				config: { script: "pm.test('b', () => {});" },
			},
		]);
	});

	test("start_load_run previews (no run) when confirmed is absent", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			{
				url: "https://api.example.com",
				targetRps: 100,
				mode: "constant_rps",
				duration: "30s",
			},
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		expect(firstText(res)).toMatch(/awaiting confirmation/i);
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("start_load_run starts the run when confirmed", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			{
				url: "https://api.example.com",
				targetRps: 100,
				mode: "constant_rps",
				duration: "30s",
				confirmed: true,
			},
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		expect(client.startRun).toHaveBeenCalledTimes(1);
	});

	// --- Load caps reach every field the run is actually built from (#312) ---

	test("start_load_run refuses a startConcurrency over the cap", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				mode: "ramp_up",
				concurrency: 10,
				startConcurrency: 900,
				duration: "30s",
				confirmed: true,
			}),
			ctxWith(client, { allowlist: ["api.example.com"], maxConcurrency: 200 })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/startConcurrency 900 exceeds/);
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("start_load_run refuses an unbounded iterations run", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				mode: "iterations",
				iterations: 1_000_000_000,
				confirmed: true,
			}),
			ctxWith(client, { allowlist: ["api.example.com"], maxIterations: 10000 })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/iterations 1000000000 exceeds the MCP cap of 10000/);
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("the schema refuses load counts the engine reads as enormous", () => {
		// `-1` is the natural "unlimited" guess and casts to ~1.8e19 engine-side,
		// where it is a request count, a ramp seed and an in-flight ceiling, not
		// an error. `maxInFlight` bounds in-flight *downward*, so the enormous
		// value is the one that removes the backpressure it was asked for.
		for (const field of ["startConcurrency", "iterations", "maxInFlight"]) {
			expect(() =>
				parseArgs("start_load_run", { url: "https://api.example.com", [field]: -1 })
			).toThrow();
			expect(() =>
				parseArgs("start_load_run", { url: "https://api.example.com", [field]: 0 })
			).toThrow();
			expect(() =>
				parseArgs("start_load_run", { url: "https://api.example.com", [field]: 2.5 })
			).toThrow();
		}
	});

	test("the schema's maxInFlight ceiling is the engine's, inclusive", () => {
		// The bound exists so an out-of-range value is named here rather than
		// returned as an opaque 400 from POST /runs - which means it has to be
		// the *same* bound, not a stricter guess. 500,000 is what the engine's
		// own default formula reaches at 50k RPS, so refusing it would refuse a
		// run the engine starts on its own.
		for (const value of [1, 500_000, MAX_IN_FLIGHT_BOUND]) {
			expect(() =>
				parseArgs("start_load_run", {
					url: "https://api.example.com",
					maxInFlight: value,
				})
			).not.toThrow();
		}
		expect(() =>
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				maxInFlight: MAX_IN_FLIGHT_BOUND + 1,
			})
		).toThrow();
	});

	test("the maxInFlight ceiling is the one the load dialog advertises", () => {
		// Third copy of the same number: engine header, renderer constant, this
		// schema. `electron/` production code may not import `src/`, so the copy
		// stays - and this is the half of the chain that keeps it honest, the
		// renderer-to-engine half living in
		// `src/constants/load-test.engine-parity.test.ts`. An agent and a human
		// composing the same run must be accepted or refused identically.
		expect(MAX_IN_FLIGHT_BOUND).toBe(LOAD_TEST_LIMITS.MAX_IN_FLIGHT.MAX);
	});

	test("start_load_run sends an explicit duration when the cap is under the engine default", async () => {
		// An omitted duration is 60s engine-side, so a 30s cap that says nothing
		// gets a 60s run.
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				concurrency: 10,
				confirmed: true,
			}),
			ctxWith(client, { allowlist: ["api.example.com"], maxDurationSeconds: 30 })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.duration).toBe("30s");
	});

	test("start_load_run sends the engine default duration when the cap is above it", async () => {
		const client = fakeClient();
		await dispatchTool(
			"start_load_run",
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				concurrency: 10,
				confirmed: true,
			}),
			ctxWith(client, { allowlist: ["api.example.com"], maxDurationSeconds: 300 })
		);
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.duration).toBe("60s");
	});

	test("start_load_run forwards the stream flag and both caps", async () => {
		// Forwarded verbatim, bounded only by the engine's own ranges: the
		// engine validates before the run row exists, so re-deriving the rule
		// here would be a second copy to keep in step (issue #576).
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				targetRps: 10,
				mode: "constant_rps",
				duration: "30s",
				confirmed: true,
				stream: true,
				maxStreamDurationMs: 20_000,
				maxStreamEvents: 50,
			}),
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.stream).toBe(true);
		expect(payload.maxStreamDurationMs).toBe(20_000);
		expect(payload.maxStreamEvents).toBe(50);
	});

	test("start_load_run sends no stream key when the agent named none", async () => {
		// The engine refuses `stream` beside `transient` and refuses a cap
		// without `stream`, so a defaulted `false` would turn "said nothing"
		// into a claim the engine has to judge.
		const client = fakeClient();
		await dispatchTool(
			"start_load_run",
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				concurrency: 10,
				confirmed: true,
			}),
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload).not.toHaveProperty("stream");
		expect(payload).not.toHaveProperty("maxStreamEvents");
	});

	test("the stream cap schema accepts exactly the engine's ranges", () => {
		// Same posture as the maxInFlight ceiling above: a value this schema
		// accepts must be one POST /runs accepts, or the agent gets an opaque
		// 400 instead of a named refusal.
		for (const args of [
			{ maxStreamDurationMs: 1000 },
			{ maxStreamDurationMs: 86_400_000 },
			{ maxStreamEvents: 1 },
			{ maxStreamEvents: 10_000_000 },
		]) {
			expect(() =>
				parseArgs("start_load_run", { url: "https://api.example.com", ...args })
			).not.toThrow();
		}
		for (const args of [
			{ maxStreamDurationMs: 999 },
			{ maxStreamDurationMs: 86_400_001 },
			{ maxStreamEvents: 0 },
			{ maxStreamEvents: 10_000_001 },
			{ maxStreamEvents: 2.5 },
		]) {
			expect(() =>
				parseArgs("start_load_run", { url: "https://api.example.com", ...args })
			).toThrow();
		}
	});

	test("start_load_run forwards an agent-supplied httpVersion", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			{
				url: "https://api.example.com",
				targetRps: 100,
				mode: "constant_rps",
				duration: "30s",
				confirmed: true,
				httpVersion: "http2",
			},
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.httpVersion).toBe("http2");
	});

	// --- Load-testing a saved request (#176) --------------------------------
	//
	// The gap these close: `start_load_run` used to send only an ad-hoc `tests`
	// string, so "load test this saved request" through MCP ran none of the
	// assertions the same request runs in the app. Composition is engine-side
	// (`POST /compose`, #226) - the same path run_collection_smoke uses.
	//
	// Since issue #1514 `/compose` answers with `elements` and nothing else, but
	// a single-target `POST /runs` still reads only `tests` /
	// `postRequestScript(s)` (`read_post_request_script`) and never looks at
	// `elements` - so the tool folds the composed `script.post` entries back
	// into `tests` itself. Without that fold the composed assertions would be
	// sent under a key the load path ignores, which is the bug these pin.

	test("start_load_run by id keeps the saved request's stream flag unless the call states one (#3561)", async () => {
		const sent = async (extra: Record<string, unknown>) => {
			const client = savedRequestClient({ stream: true });
			const res = await dispatchTool(
				"start_load_run",
				{ requestId: "req_1", duration: "30s", confirmed: true, ...extra },
				ctxWith(client, { allowlist: ["api.example.com"] })
			);
			expect(res.isError).toBeFalsy();
			return (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		};
		expect(await sent({})).toMatchObject({ stream: true });
		expect(await sent({ stream: false })).toMatchObject({ stream: false });
	});

	// Mutation check: assign `payload.stream` bare in start_load_run and the
	// stored path rides a buffered run, which POST /runs refuses.
	test("start_load_run keeps a stored stream text path beside stream, and drops it when stream is forced off (#3773)", async () => {
		const sent = async (extra: Record<string, unknown>) => {
			const client = savedRequestClient({ stream: true, streamTextPath: "$.delta.text" });
			const res = await dispatchTool(
				"start_load_run",
				{ requestId: "req_1", duration: "30s", confirmed: true, ...extra },
				ctxWith(client, { allowlist: ["api.example.com"] })
			);
			expect(res.isError).toBeFalsy();
			return (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		};
		expect(await sent({})).toMatchObject({ stream: true, streamTextPath: "$.delta.text" });
		expect(await sent({ stream: true })).toMatchObject({ streamTextPath: "$.delta.text" });
		const buffered = await sent({ stream: false });
		expect(buffered).toMatchObject({ stream: false });
		expect(buffered).not.toHaveProperty("streamTextPath");
	});

	// Mutation check: drop the marker's `delete` from setStreamFlag and it
	// rides a buffered run, which POST /runs refuses.
	test("start_load_run keeps a stored first content marker beside stream, and drops it when stream is forced off (#3774)", async () => {
		const sent = async (extra: Record<string, unknown>) => {
			const client = savedRequestClient({
				stream: true,
				streamFirstContentMarker: "content_block_delta",
			});
			const res = await dispatchTool(
				"start_load_run",
				{ requestId: "req_1", duration: "30s", confirmed: true, ...extra },
				ctxWith(client, { allowlist: ["api.example.com"] })
			);
			expect(res.isError).toBeFalsy();
			return (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		};
		expect(await sent({})).toMatchObject({
			stream: true,
			streamFirstContentMarker: "content_block_delta",
		});
		const buffered = await sent({ stream: false });
		expect(buffered).toMatchObject({ stream: false });
		expect(buffered).not.toHaveProperty("streamFirstContentMarker");
	});

	test("start_load_run composes a saved request; the chain's assertions fold into `requestElements`", async () => {
		const client = savedRequestClient();
		const res = await dispatchTool(
			"start_load_run",
			{ requestId: "req_1", duration: "30s", confirmed: true },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		// The saved request defines the target - no `url` was passed at all.
		expect(payload.url).toBe("https://api.example.com/users");
		expect(payload.method).toBe("POST");
		expect(payload.headers).toMatchObject({ "X-Api": "v1" });
		expect(payload.requestId).toBe("req_1");
		// The whole point: the collection's assertion and the request's own both
		// travel, in chain-then-own order, under the key /runs actually reads for
		// step-level elements (issue #1594) - not the retired flat `tests` string.
		expect(payload.requestElements).toEqual([
			{
				id: "el_chain",
				kind: "script.post",
				enabled: true,
				config: { script: "pm.test('chain', function () {});" },
				origin: { kind: "collection", id: "col_1", name: "API" },
			},
			{
				id: "el_sig",
				kind: "script.pre",
				enabled: true,
				config: { script: "pm.request.headers['X-Sig'] = 'abc';" },
				origin: { kind: "request", id: "req_1" },
			},
			{
				id: "el_own",
				kind: "script.post",
				enabled: true,
				config: { script: "pm.test('own', function () {});" },
				origin: { kind: "request", id: "req_1" },
			},
		]);
		expect(payload.tests).toBeUndefined();
		// `elements` is the run-level `timers`/`scripts` override object, a
		// different key entirely, and none was passed here.
		expect(payload.elements).toBeUndefined();
	});

	// #3070: /compose emits an enabled collection's `script.setup` / `.teardown`
	// stamped with a collection origin, and POST /runs validates `requestElements`
	// as a request's own, which refuses them with a 400 an agent cannot trace.
	describe("start_load_run leaves a collection's run-boundary scripts out", () => {
		const collectionOnly = (kind: string) => ({
			id: `el_${kind}`,
			kind,
			enabled: true,
			config: { script: "pm.environment.set('k', 'v');" },
			origin: { kind: "collection", id: "col_1", name: "API" },
		});
		const collectionAssert = {
			id: "el_col_assert",
			kind: "assert.status",
			enabled: true,
			config: { expected: 200 },
			origin: { kind: "collection", id: "col_1", name: "API" },
		};
		const requestPost = {
			id: "el_own_post",
			kind: "script.post",
			enabled: true,
			config: { script: "pm.test('own', function () {});" },
			origin: { kind: "request", id: "req_1" },
		};
		const requestTeardown = {
			...collectionOnly("script.teardown"),
			origin: requestPost.origin,
		};

		const startPayload = async (elements: unknown[]) => {
			const client = savedRequestClient({ elements });
			const res = await dispatchTool(
				"start_load_run",
				{ requestId: "req_1", duration: "30s", confirmed: true },
				ctxWith(client, { allowlist: ["api.example.com"] })
			);
			expect(res.isError).toBeFalsy();
			return (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		};

		test("drops collection-origin setup and teardown, keeps the rest in order", async () => {
			const payload = await startPayload([
				collectionOnly("script.setup"),
				collectionAssert,
				collectionOnly("script.teardown"),
				requestPost,
			]);

			expect(payload.requestElements).toEqual([collectionAssert, requestPost]);
		});

		test("sends no requestElements when only setup and teardown were composed", async () => {
			const payload = await startPayload([
				collectionOnly("script.setup"),
				collectionOnly("script.teardown"),
			]);

			expect(payload.requestElements).toBeUndefined();
		});

		test("keeps a setup or teardown that is the request's own, for the engine to judge", async () => {
			const payload = await startPayload([requestTeardown]);

			expect(payload.requestElements).toEqual([requestTeardown]);
		});
	});

	test("start_load_run reports the pre-request script it cannot run", async () => {
		const client = savedRequestClient();
		const res = await dispatchTool(
			"start_load_run",
			{ requestId: "req_1", duration: "30s", confirmed: true },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		// The `script.pre` element stays on the payload, under `requestElements`
		// (it does reach the wire now - just not this one, since it carries no
		// `config.inline` mark and no override forces it)...
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		// `preRequestScripts` is refused outright now (issue #1594's cut-over),
		// so the retired name must never be sent regardless...
		expect(payload.preRequestScripts).toBeUndefined();
		// ...and `elements` is the run-level override object, not sent here
		// since no override was passed.
		expect(payload.elements).toBeUndefined();
		// ...and the agent has to be told, or a request that signs itself goes
		// out unsigned with nothing saying so. The count comes off the composed
		// `script.pre` elements now, so a miscounted fold reddens here.
		const text = res.content.map((c) => c.text).join("\n");
		expect(text).toMatch(/1 pre-request script\(s\).*NOT applied/i);
	});

	// The count folds `args.elements.scripts` in, not only each element's own
	// `config.inline` - the run-level override decides every `script.pre`'s
	// fate when it is set, regardless of the mark.
	test("start_load_run suppresses the caveat when elements.scripts forces every script inline", async () => {
		const client = savedRequestClient();
		const res = await dispatchTool(
			"start_load_run",
			{
				requestId: "req_1",
				duration: "30s",
				confirmed: true,
				elements: { scripts: "allInline" },
			},
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.elements).toEqual({ scripts: "allInline" });
		const text = res.content.map((c) => c.text).join("\n");
		expect(text).not.toMatch(/pre-request script\(s\)/i);
	});

	// The gap the count used to miss: a `script.pre` marked `config.inline`
	// individually still does not run once the run's own override forces
	// every script deferred - so it must count as dropped too, not be
	// excluded because its own mark says otherwise.
	test("start_load_run counts even a marked script.pre as dropped when elements.scripts forces every script deferred", async () => {
		const client = fakeClient({
			composeRequest: vi.fn().mockResolvedValue({
				method: "GET",
				url: "https://api.example.com/x",
				requestId: "req_1",
				elements: [
					{
						id: "el_sig",
						kind: "script.pre",
						enabled: true,
						config: { script: "pm.request.headers['X-Sig'] = 'abc';", inline: true },
					},
				],
			}),
		});
		const res = await dispatchTool(
			"start_load_run",
			{
				requestId: "req_1",
				duration: "30s",
				confirmed: true,
				elements: { scripts: "allDeferred" },
			},
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const text = res.content.map((c) => c.text).join("\n");
		expect(text).toMatch(/1 pre-request script\(s\).*NOT applied/i);
	});

	// Under either agent-facing name - `postRequestScript` is the one both
	// execute-shaped tools declare, `tests` the engine spelling kept as an alias.
	test.each(["postRequestScript", "tests"])(
		"start_load_run: an explicit %s becomes the run's validation script",
		async (key) => {
			const client = savedRequestClient();
			const res = await dispatchTool(
				"start_load_run",
				{
					requestId: "req_1",
					[key]: "pm.test('adhoc', function () {});",
					duration: "30s",
					confirmed: true,
				},
				ctxWith(client, { allowlist: ["api.example.com"], revealSecretsToAgents: true })
			);

			expect(res.isError).toBeFalsy();
			const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
			// Replaces rather than joins: with no way to know which the agent
			// meant, running both would add assertions they never asked for. The
			// composed `script.post` elements must not survive alongside it - only
			// the composed `script.pre` (untouched) and the ad-hoc script remain.
			expect(payload.requestElements).toEqual([
				{
					id: "el_sig",
					kind: "script.pre",
					enabled: true,
					config: { script: "pm.request.headers['X-Sig'] = 'abc';" },
					origin: { kind: "request", id: "req_1" },
				},
				{
					id: "mcp-script-post",
					kind: "script.post",
					enabled: true,
					config: { script: "pm.test('adhoc', function () {});" },
				},
			]);
			expect(payload.tests).toBeUndefined();
			expect(payload.postRequestScripts).toBeUndefined();
			expect(payload.elements).toBeUndefined();
		}
	);

	test("start_load_run: an explicit url retargets the saved request", async () => {
		const client = savedRequestClient();
		const res = await dispatchTool(
			"start_load_run",
			{
				requestId: "req_1",
				url: "https://staging.example.com/users",
				duration: "30s",
				confirmed: true,
			},
			ctxWith(client, { allowlist: ["staging.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.url).toBe("https://staging.example.com/users");
		// Only the stated field is overridden; the rest of the request stands -
		// the whole composed element list included, unchanged, under the key
		// /runs reads for step-level elements.
		expect(payload.method).toBe("POST");
		expect(payload.requestElements).toEqual(composedSavedRequest.elements);
	});

	// The saved request stores http1.1 and the agent asks for http2, so a pass
	// cannot come from both sides agreeing on the "auto" default. The override
	// must ride inside the compose body's `request` overlay - /compose always
	// emits a stored request's protocol, so an override left out of the overlay
	// loses to the stored value while the tool advertises the argument.
	test("start_load_run: an explicit httpVersion overrides the saved request's", async () => {
		const client = savedRequestClient({ httpVersion: "http1.1" });
		const res = await dispatchTool(
			"start_load_run",
			{ requestId: "req_1", httpVersion: "http2", duration: "30s", confirmed: true },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const composeBody = (client.composeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(composeBody.request).toMatchObject({ httpVersion: "http2" });
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.httpVersion).toBe("http2");
		// Only the stated field is overridden; the rest of the request stands -
		// the whole composed element list included, unchanged, under the key
		// /runs reads for step-level elements.
		expect(payload.url).toBe("https://api.example.com/users");
		expect(payload.requestElements).toEqual(composedSavedRequest.elements);
	});

	// The other half of the rule: with nothing stated the stored protocol runs,
	// so no overlay may be sent that would write a default over it.
	test("start_load_run keeps the saved request's httpVersion when none is stated", async () => {
		const client = savedRequestClient({ httpVersion: "http1.1" });
		const res = await dispatchTool(
			"start_load_run",
			{ requestId: "req_1", duration: "30s", confirmed: true },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const composeBody = (client.composeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(composeBody.request).toBeUndefined();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.httpVersion).toBe("http1.1");
	});

	test("start_load_run checks the allowlist against the saved request's host", async () => {
		const client = savedRequestClient();
		const res = await dispatchTool(
			"start_load_run",
			{ requestId: "req_1", duration: "30s", confirmed: true },
			ctxWith(client, { allowlist: ["elsewhere.example.com"] })
		);

		expect(res.isError).toBe(true);
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("start_load_run needs a url or a requestId, and says so", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			{ duration: "30s", confirmed: true },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/requestId/);
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("start_load_run reports an unknown requestId instead of running an empty request", async () => {
		const client = fakeClient({
			composeRequest: vi
				.fn()
				.mockRejectedValue(new EngineRequestError("Engine responded 404", 404, "")),
		});
		const res = await dispatchTool(
			"start_load_run",
			{ requestId: "req_missing", duration: "30s", confirmed: true },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/req_missing/);
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("start_load_run enforces caps before any run is started", async () => {
		// Composition (pure, sends nothing) may run first - the caps and the
		// allowlist stand between the composed payload and any actual traffic.
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			{ url: "https://api.example.com", targetRps: 999999, confirmed: true },
			ctxWith(client, { allowlist: ["api.example.com"], maxRps: 1000 })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/exceeds the MCP cap/i);
		expect(client.startRun).not.toHaveBeenCalled();
	});
});

/**
 * The engine reads `concurrency` as an eager per-worker curl-handle
 * pre-allocation, so a negative one becomes ~1.8e19 and allocates until malloc
 * fails. It now returns a 400 instead, but "-1 means unlimited" is exactly the
 * guess an agent makes, and the schema is where that gets a name rather than an
 * HTTP error. Asserted on the schema itself, since `dispatchTool` calls the
 * handler directly - the MCP SDK is what validates args in production.
 */
describe("start_load_run rejects an unusable concurrency at the schema", () => {
	const concurrencySchema = () => {
		const tool = TOOLS.find((t) => t.name === "start_load_run");
		expect(tool).toBeDefined();
		const shape = tool!.inputSchema as Record<string, z.ZodType>;
		expect(shape.concurrency).toBeDefined();
		return shape.concurrency;
	};

	test.each([-1, 0, 1.5])("rejects concurrency %s", (value) => {
		expect(concurrencySchema().safeParse(value).success).toBe(false);
	});

	test("accepts an ordinary concurrency, and its absence", () => {
		expect(concurrencySchema().safeParse(50).success).toBe(true);
		expect(concurrencySchema().safeParse(undefined).success).toBe(true);
	});
});
