/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test, vi } from "vitest";
import {
	DEFAULT_ENGINE_URL,
	DEFAULT_GATE_MODE,
	EXIT_FAILED,
	EXIT_OPERATIONAL,
	EXIT_PASSED,
	GateHelpRequested,
	GateOperationalError,
	GateUsageError,
	POLL_GRACE_MS,
	formatGateReport,
	parseGateArgs,
	pollBudgetMs,
	pollUntilTerminal,
	readThresholdValidation,
	runGate,
	verdictExitCode,
	type GateEngineClient,
	type ThresholdValidation,
} from "./gate.js";
import { EngineRequestError } from "./engine-client.js";

/**
 * The engine's identity composition for an inline request - the request echoed
 * back. Composition itself is engine-owned (#226); what this file owns is what
 * the gate builds and what it does with the answer.
 */
function identityCompose() {
	return vi.fn().mockImplementation((body: { request?: object; environmentId?: string }) => {
		const composed: Record<string, unknown> = { ...(body.request ?? {}) };
		if (typeof composed.method === "string") composed.method = composed.method.toUpperCase();
		if (body.environmentId !== undefined) composed.environmentId = body.environmentId;
		return Promise.resolve(composed);
	});
}

function validation(overrides: Partial<ThresholdValidation> = {}) {
	return {
		checks: [{ metric: "latencyP99Ms", limit: 50, actual: 41.021, passed: true }],
		passed: 1,
		failed: 0,
		verdict: "passed",
		...overrides,
	};
}

function report(thresholdValidation: unknown = validation()) {
	return {
		summary: { totalRequests: 6000, errorRate: 0, avgRps: 100, totalDurationSeconds: 60 },
		latency: { p99: 41.021 },
		thresholdValidation,
	};
}

function fakeClient(overrides: Partial<Record<keyof GateEngineClient, unknown>> = {}) {
	return {
		composeRequest: identityCompose(),
		startRun: vi.fn().mockResolvedValue({ runId: "run_1", status: "pending" }),
		getRun: vi.fn().mockResolvedValue({ id: "run_1", status: "completed" }),
		getRunReport: vi.fn().mockResolvedValue(report()),
		...overrides,
	} as unknown as GateEngineClient;
}

/** Collects stdout/stderr so an assertion can read what a pipeline would. */
function collector() {
	const out: string[] = [];
	const err: string[] = [];
	return {
		out,
		err,
		stdout: (line: string) => out.push(line),
		stderr: (line: string) => err.push(line),
	};
}

const ADHOC = ["--url", "https://api.example.com/health"];

describe("parseGateArgs - target and defaults", () => {
	test("an ad-hoc target with one budget is the smallest valid invocation", () => {
		const options = parseGateArgs([...ADHOC, "--p99", "50"]);
		expect(options.engineUrl).toBe(DEFAULT_ENGINE_URL);
		expect(options.json).toBe(false);
		expect(options.toolArgs).toMatchObject({
			url: "https://api.example.com/health",
			mode: DEFAULT_GATE_MODE,
			thresholds: { latencyP99Ms: 50 },
		});
	});

	test("--flag=value is the same as --flag value", () => {
		const spaced = parseGateArgs([...ADHOC, "--p99", "50", "--engine-url", "http://e:1"]);
		const joined = parseGateArgs([
			"--url=https://api.example.com/health",
			"--p99=50",
			"--engine-url=http://e:1",
		]);
		expect(joined).toEqual(spaced);
	});

	test("a saved request is a target on its own, and carries its environment", () => {
		const options = parseGateArgs([
			"--request-id",
			"req_9",
			"--environment-id",
			"env_2",
			"--p95",
			"40",
		]);
		expect(options.toolArgs).toMatchObject({ requestId: "req_9", environmentId: "env_2" });
		expect(options.toolArgs.url).toBeUndefined();
	});

	test("naming no target is a usage error, not a run against nothing", () => {
		expect(() => parseGateArgs(["--p99", "50"])).toThrow(GateUsageError);
	});

	test("--json and --help are recognised without a value", () => {
		expect(parseGateArgs([...ADHOC, "--p99", "50", "--json"]).json).toBe(true);
		expect(() => parseGateArgs(["--help"])).toThrow(GateHelpRequested);
		expect(() => parseGateArgs([...ADHOC, "--p99", "50", "--json=1"])).toThrow(GateUsageError);
	});

	test("an unknown flag is refused by name rather than ignored", () => {
		// The failure this guards: a silently dropped budget flag reports a
		// green build for a budget nobody checked.
		expect(() => parseGateArgs([...ADHOC, "--p98", "50"])).toThrow(/--p98/);
	});

	test("a flag given twice is refused - one of the two values would be ignored", () => {
		expect(() => parseGateArgs([...ADHOC, "--p99", "50", "--p99", "80"])).toThrow(
			/more than once/
		);
	});

	test("a flag with no value left on the line is refused", () => {
		expect(() => parseGateArgs([...ADHOC, "--p99"])).toThrow(/needs a value/);
	});
});

describe("parseGateArgs - budgets", () => {
	test("each budget flag lands on its own engine metric key", () => {
		const options = parseGateArgs([
			...ADHOC,
			"--p50",
			"10",
			"--p95",
			"40",
			"--p99",
			"50",
			"--error-rate",
			"0.5",
			"--min-rps",
			"1000",
		]);
		expect(options.toolArgs.thresholds).toEqual({
			latencyP50Ms: 10,
			latencyP95Ms: 40,
			latencyP99Ms: 50,
			maxErrorRatePct: 0.5,
			minThroughputRps: 1000,
		});
	});

	test("no budget at all is a usage error - the gate would have nothing to judge", () => {
		expect(() => parseGateArgs([...ADHOC])).toThrow(/at least one budget/);
	});

	test("budget bounds mirror the engine's, so a typo fails here rather than as a 400", () => {
		expect(() => parseGateArgs([...ADHOC, "--error-rate", "101"])).toThrow(/out of range/);
		expect(() => parseGateArgs([...ADHOC, "--p99", "0"])).toThrow(/out of range/);
		expect(() => parseGateArgs([...ADHOC, "--p99", "abc"])).toThrow(/not a number/);
		// Zero errors tolerated is the strictest gate there is, not an invalid one.
		expect(parseGateArgs([...ADHOC, "--error-rate", "0"]).toolArgs.thresholds).toEqual({
			maxErrorRatePct: 0,
		});
	});
});

describe("parseGateArgs - load shape", () => {
	test("constant_concurrency takes --concurrency and refuses --target-rps", () => {
		expect(
			parseGateArgs([...ADHOC, "--p99", "50", "--concurrency", "32"]).toolArgs
		).toMatchObject({ concurrency: 32, mode: "constant_concurrency" });
		expect(() => parseGateArgs([...ADHOC, "--p99", "50", "--target-rps", "500"])).toThrow(
			/not read in constant_concurrency mode/
		);
	});

	test("constant_rps needs --target-rps and refuses --concurrency", () => {
		expect(
			parseGateArgs([
				...ADHOC,
				"--p99",
				"50",
				"--mode",
				"constant_rps",
				"--target-rps",
				"500",
			]).toolArgs
		).toMatchObject({ targetRps: 500, mode: "constant_rps" });
		expect(() => parseGateArgs([...ADHOC, "--p99", "50", "--mode", "constant_rps"])).toThrow(
			/needs --target-rps/
		);
		expect(() =>
			parseGateArgs([
				...ADHOC,
				"--p99",
				"50",
				"--mode",
				"constant_rps",
				"--target-rps",
				"500",
				"--concurrency",
				"32",
			])
		).toThrow(/not read in constant_rps mode/);
	});

	test("the exploratory modes are refused with a message that says where they live", () => {
		for (const mode of ["capacity", "ramp_up", "iterations"]) {
			expect(() => parseGateArgs([...ADHOC, "--p99", "50", "--mode", mode])).toThrow(
				/not a gate mode/
			);
		}
	});

	test("--concurrency must be a positive whole number", () => {
		expect(() => parseGateArgs([...ADHOC, "--p99", "50", "--concurrency", "0"])).toThrow(
			/out of range/
		);
		expect(() => parseGateArgs([...ADHOC, "--p99", "50", "--concurrency", "1.5"])).toThrow(
			/whole number/
		);
	});

	test("--duration must parse as the engine's duration grammar", () => {
		expect(
			parseGateArgs([...ADHOC, "--p99", "50", "--duration", "90s"]).toolArgs.duration
		).toBe("90s");
		expect(() => parseGateArgs([...ADHOC, "--p99", "50", "--duration", "soon"])).toThrow(
			/not a positive duration/
		);
		expect(() => parseGateArgs([...ADHOC, "--p99", "50", "--duration", "0s"])).toThrow(
			/not a positive duration/
		);
	});
});

describe("pollBudgetMs", () => {
	test("the wait is the run's own duration plus the drain grace", () => {
		expect(pollBudgetMs({ mode: "constant_concurrency", duration: "90s" })).toBe(
			90_000 + POLL_GRACE_MS
		);
		expect(pollBudgetMs({ mode: "constant_concurrency", duration: "2m" })).toBe(
			120_000 + POLL_GRACE_MS
		);
	});

	test("an omitted duration takes the engine's default for the mode, not infinity", () => {
		expect(pollBudgetMs({ mode: "constant_concurrency" })).toBe(60_000 + POLL_GRACE_MS);
	});
});

describe("pollUntilTerminal", () => {
	const clock = () => {
		let t = 0;
		return {
			now: () => t,
			sleep: vi.fn().mockImplementation((ms: number) => {
				t += ms;
				return Promise.resolve();
			}),
		};
	};

	test("waits through running ticks and answers with the terminal status", async () => {
		const { now, sleep } = clock();
		const getRun = vi
			.fn()
			.mockResolvedValueOnce({ status: "pending" })
			.mockResolvedValueOnce({ status: "running" })
			.mockResolvedValueOnce({ status: "completed" });
		const status = await pollUntilTerminal({
			client: { getRun } as unknown as Pick<GateEngineClient, "getRun">,
			runId: "run_1",
			budgetMs: 60_000,
			intervalMs: 1_000,
			now,
			sleep,
		});
		expect(status).toBe("completed");
		expect(getRun).toHaveBeenCalledTimes(3);
	});

	test("a run that never leaves running times out on the budget", async () => {
		// Mutation check: widen the budget past the elapsed poll time and this
		// call resolves instead of rejecting.
		const { now, sleep } = clock();
		const getRun = vi.fn().mockResolvedValue({ status: "running" });
		await expect(
			pollUntilTerminal({
				client: { getRun } as unknown as Pick<GateEngineClient, "getRun">,
				runId: "run_1",
				budgetMs: 5_000,
				intervalMs: 1_000,
				now,
				sleep,
			})
		).rejects.toThrow(GateOperationalError);
	});

	test("a row with no status is an operational error, not an assumed finish", async () => {
		const { now, sleep } = clock();
		await expect(
			pollUntilTerminal({
				client: { getRun: vi.fn().mockResolvedValue({ id: "run_1" }) } as unknown as Pick<
					GateEngineClient,
					"getRun"
				>,
				runId: "run_1",
				budgetMs: 5_000,
				now,
				sleep,
			})
		).rejects.toThrow(/no status/);
	});
});

describe("readThresholdValidation", () => {
	test("reads the checks and the verdict the engine wrote", () => {
		const parsed = readThresholdValidation(report(), "run_1");
		expect(parsed.verdict).toBe("passed");
		expect(parsed.checks).toEqual([
			{ metric: "latencyP99Ms", limit: 50, actual: 41.021, passed: true },
		]);
	});

	test("an absent section is refused, never read as a pass", () => {
		// The one failure mode a gate must not have: the gate always sends
		// budgets, so no section means nothing judged them.
		expect(() => readThresholdValidation({ summary: {} }, "run_1")).toThrow(
			/no thresholdValidation/
		);
	});

	test("an unrecognised verdict is refused rather than guessed at", () => {
		expect(() =>
			readThresholdValidation(report({ checks: [], verdict: "maybe" }), "run_1")
		).toThrow(/unrecognised verdict/);
	});
});

describe("verdictExitCode", () => {
	test("passed exits 0 and failed exits 1", () => {
		// Mutation check: swap the two and both assertions fail.
		expect(verdictExitCode(validation() as ThresholdValidation)).toBe(EXIT_PASSED);
		expect(
			verdictExitCode(
				validation({ verdict: "failed", passed: 0, failed: 1 }) as ThresholdValidation
			)
		).toBe(EXIT_FAILED);
	});
});

describe("formatGateReport", () => {
	test("names every failed check with its limit and what the run actually did", () => {
		const text = formatGateReport(
			"run_1",
			validation({
				checks: [
					{ metric: "latencyP99Ms", limit: 50, actual: 91.5, passed: false },
					{ metric: "maxErrorRatePct", limit: 0.5, actual: 0, passed: true },
				],
				passed: 1,
				failed: 1,
				verdict: "failed",
			}) as ThresholdValidation,
			report()
		);
		expect(text).toContain("latencyP99Ms");
		expect(text).toContain("91.5");
		expect(text).toContain("50");
		expect(text).toContain("FAIL");
		expect(text).toContain("VERDICT: FAILED (1/2 budgets missed)");
	});

	test("a passing run says so with the headline numbers", () => {
		const text = formatGateReport("run_1", validation() as ThresholdValidation, report());
		expect(text).toContain("Run run_1");
		expect(text).toContain("6000 requests");
		expect(text).toContain("VERDICT: PASSED (1/1 budgets met)");
	});
});

describe("runGate", () => {
	const clock = { now: () => 0, sleep: vi.fn().mockResolvedValue(undefined) };

	function gateDeps(client: GateEngineClient, argv: string[]) {
		const io = collector();
		return {
			io,
			deps: {
				client,
				options: parseGateArgs(argv),
				stdout: io.stdout,
				stderr: io.stderr,
				now: clock.now,
				sleep: clock.sleep,
			},
		};
	}

	test("a run that meets its budgets exits 0 and prints the table", async () => {
		const client = fakeClient();
		const { io, deps } = gateDeps(client, [...ADHOC, "--p99", "50", "--concurrency", "32"]);
		expect(await runGate(deps)).toBe(EXIT_PASSED);
		expect(io.out.join("\n")).toContain("VERDICT: PASSED");
	});

	test("the budgets and load shape reach POST /runs unchanged", async () => {
		const startRun = vi.fn().mockResolvedValue({ runId: "run_7" });
		const client = fakeClient({ startRun });
		const { deps } = gateDeps(client, [
			...ADHOC,
			"--method",
			"post",
			"--concurrency",
			"32",
			"--duration",
			"90s",
			"--p99",
			"50",
			"--min-rps",
			"1000",
		]);
		await runGate(deps);
		expect(startRun).toHaveBeenCalledTimes(1);
		expect(startRun.mock.calls[0][0]).toMatchObject({
			url: "https://api.example.com/health",
			method: "POST",
			mode: "constant_concurrency",
			concurrency: 32,
			duration: "90s",
			thresholds: { latencyP99Ms: 50, minThroughputRps: 1000 },
		});
	});

	test("a missed budget exits 1 - the whole point of the gate", async () => {
		const client = fakeClient({
			getRunReport: vi.fn().mockResolvedValue(
				report(
					validation({
						checks: [
							{ metric: "latencyP99Ms", limit: 50, actual: 91.5, passed: false },
						],
						passed: 0,
						failed: 1,
						verdict: "failed",
					})
				)
			),
		});
		const { io, deps } = gateDeps(client, [...ADHOC, "--p99", "50"]);
		expect(await runGate(deps)).toBe(EXIT_FAILED);
		expect(io.out.join("\n")).toContain("VERDICT: FAILED");
	});

	test("--json prints the raw report instead of the table", async () => {
		const client = fakeClient();
		const { io, deps } = gateDeps(client, [...ADHOC, "--p99", "50", "--json"]);
		expect(await runGate(deps)).toBe(EXIT_PASSED);
		expect(JSON.parse(io.out.join("\n"))).toEqual(report());
	});

	test("a report with no verdict exits 2, naming the absence rather than crashing", async () => {
		const client = fakeClient({
			getRunReport: vi.fn().mockResolvedValue({ summary: {}, latency: {} }),
		});
		const { io, deps } = gateDeps(client, [...ADHOC, "--p99", "50"]);
		expect(await runGate(deps)).toBe(EXIT_OPERATIONAL);
		expect(io.err.join("\n")).toContain("no thresholdValidation");
	});

	test("a run that failed or was stopped exits 2, not 1", async () => {
		for (const status of ["failed", "stopped"]) {
			const client = fakeClient({ getRun: vi.fn().mockResolvedValue({ status }) });
			const { io, deps } = gateDeps(client, [...ADHOC, "--p99", "50"]);
			expect(await runGate(deps)).toBe(EXIT_OPERATIONAL);
			expect(io.err.join("\n")).toContain(`ended as "${status}"`);
		}
	});

	test("an unreachable engine exits 2 with the transport error", async () => {
		const client = fakeClient({
			startRun: vi.fn().mockRejectedValue(new Error("fetch failed")),
		});
		const { io, deps } = gateDeps(client, [...ADHOC, "--p99", "50"]);
		expect(await runGate(deps)).toBe(EXIT_OPERATIONAL);
		expect(io.err.join("\n")).toContain("fetch failed");
	});

	test("an engine rejection surfaces its status and body", async () => {
		const client = fakeClient({
			startRun: vi
				.fn()
				.mockRejectedValue(new EngineRequestError("bad", 400, "duration invalid")),
		});
		const { io, deps } = gateDeps(client, [...ADHOC, "--p99", "50"]);
		expect(await runGate(deps)).toBe(EXIT_OPERATIONAL);
		expect(io.err.join("\n")).toContain("400");
		expect(io.err.join("\n")).toContain("duration invalid");
	});

	test("an accepted run with no id exits 2 rather than polling nothing", async () => {
		const client = fakeClient({ startRun: vi.fn().mockResolvedValue({ status: "pending" }) });
		const { io, deps } = gateDeps(client, [...ADHOC, "--p99", "50"]);
		expect(await runGate(deps)).toBe(EXIT_OPERATIONAL);
		expect(io.err.join("\n")).toContain("no run id");
	});

	test("the MCP allowlist and caps do not apply - this is an operator, not an agent", async () => {
		// Mutation check: route the gate through `checkAllowlist` / `checkLoadCaps`
		// with a default (empty-allowlist, 200-concurrency) config and this run is
		// refused twice over - a non-allowlisted host at 5000 in flight.
		const startRun = vi.fn().mockResolvedValue({ runId: "run_1" });
		const client = fakeClient({ startRun });
		const { deps } = gateDeps(client, [
			"--url",
			"https://not-on-any-allowlist.example.net/health",
			"--concurrency",
			"5000",
			"--duration",
			"30m",
			"--p99",
			"50",
		]);
		expect(await runGate(deps)).toBe(EXIT_PASSED);
		expect(startRun.mock.calls[0][0]).toMatchObject({ concurrency: 5000, duration: "30m" });
	});

	test("a saved request whose composition has no URL exits 2", async () => {
		const client = fakeClient({ composeRequest: vi.fn().mockResolvedValue({ method: "GET" }) });
		const { io, deps } = gateDeps(client, ["--request-id", "req_9", "--p99", "50"]);
		expect(await runGate(deps)).toBe(EXIT_OPERATIONAL);
		expect(io.err.join("\n")).toContain("no URL to load-test");
	});

	test("dropped pre-request scripts are reported, not swallowed", async () => {
		const client = fakeClient({
			composeRequest: vi.fn().mockResolvedValue({
				method: "GET",
				url: "https://api.example.com/health",
				preRequestScripts: ["sign()"],
			}),
		});
		const { io, deps } = gateDeps(client, ["--request-id", "req_9", "--p99", "50"]);
		expect(await runGate(deps)).toBe(EXIT_PASSED);
		expect(io.err.join("\n")).toContain("pre-request script");
	});
});
