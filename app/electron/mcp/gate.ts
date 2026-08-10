/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file gate.ts
 * @brief Testable core of the headless CI load gate - flag parsing, the poll
 *        loop, the verdict-to-exit-code mapping and the human report. The
 *        process entry point (`gate-cli.ts`) owns only argv, the clock, the
 *        streams and `process.exit`, so everything that can be wrong is
 *        reachable from a unit test.
 *
 *        The gate is **operator-invoked**, not an agent surface: it is a human
 *        putting a target in a pipeline, exactly like a human pointing the app
 *        at one. So it deliberately does NOT apply the MCP allowlist or the
 *        MCP load caps (`safety.ts`) - those exist to bound what an autonomous
 *        agent may do on the user's behalf, and there is no agent here. What it
 *        does reuse is `buildLoadRunPayload`, the one description of what a
 *        load run's payload looks like.
 */

import type { EngineClient } from "./engine-client.js";
import { EngineRequestError } from "./engine-client.js";
import { buildLoadRunPayload } from "./tools.js";
import { engineDefaultDurationSeconds, parseDurationSeconds } from "./safety.js";

/** The run met every budget it declared. */
export const EXIT_PASSED = 0;
/** The run finished and missed at least one budget - the gate's whole point. */
export const EXIT_FAILED = 1;
/**
 * The gate could not reach a verdict: bad usage, engine unreachable, the run
 * failed or was stopped, the wait timed out, or the report carries no verdict.
 * Distinct from {@link EXIT_FAILED} so a pipeline can tell "too slow" from
 * "broken" - the two want different alerts.
 */
export const EXIT_OPERATIONAL = 2;

export const DEFAULT_ENGINE_URL = "http://127.0.0.1:9876";

/** How often the run's status is re-read while waiting. */
export const POLL_INTERVAL_MS = 2_000;

/**
 * Slack on top of the run's own duration before the wait is called a timeout.
 * A run does not end when its clock does: in-flight requests still drain, the
 * summary is computed and written, and the status only then turns terminal.
 */
export const POLL_GRACE_MS = 60_000;

/**
 * The modes a gate can express. `constant_concurrency` and `constant_rps` are
 * duration-bounded and fully described by the flags below, which is what a
 * pipeline needs: the same command twice is the same run twice, and the wait
 * has a deadline derivable before it starts.
 *
 * The exploratory shapes are deliberate non-goals here - `capacity` and
 * `ramp_up` carry parameters (`sloMs`, `stepDuration`, `startConcurrency`,
 * `rampUpDuration`) this CLI does not expose, and `iterations` stops on a
 * request count so no duration bounds it. They are reachable from the app and
 * from `POST /runs`; if a gate ever wants one, it arrives with its own flags
 * rather than through a mode string that silently ignores half the run.
 */
export const GATE_MODES = ["constant_concurrency", "constant_rps"] as const;
export type GateMode = (typeof GATE_MODES)[number];

/** Mode the gate runs when none is named - closed-loop and duration-bounded. */
export const DEFAULT_GATE_MODE: GateMode = "constant_concurrency";

/** A flag the caller got wrong. Reported as usage, exits {@link EXIT_OPERATIONAL}. */
export class GateUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GateUsageError";
	}
}

/** The gate ran but could not reach a verdict. Exits {@link EXIT_OPERATIONAL}. */
export class GateOperationalError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GateOperationalError";
	}
}

/**
 * The threshold flags, and the engine metric key each one sets. The bounds
 * mirror `start_load_run`'s Zod schema, which mirrors the engine's - a value
 * this parser accepts is one `POST /runs` accepts, so a typo fails here by
 * name instead of arriving as a 400.
 */
const THRESHOLD_FLAGS: Readonly<
	Record<string, { key: string; min: number; max: number; minInclusive?: boolean }>
> = {
	"--p50": { key: "latencyP50Ms", min: 0, max: 86_400_000 },
	"--p95": { key: "latencyP95Ms", min: 0, max: 86_400_000 },
	"--p99": { key: "latencyP99Ms", min: 0, max: 86_400_000 },
	"--error-rate": { key: "maxErrorRatePct", min: 0, max: 100, minInclusive: true },
	"--min-rps": { key: "minThroughputRps", min: 0, max: 1_000_000_000 },
};

/** Flags that take a value and land on the run description unchanged. */
const VALUE_FLAGS = new Set([
	"--url",
	"--method",
	"--request-id",
	"--environment-id",
	"--mode",
	"--concurrency",
	"--target-rps",
	"--duration",
	"--engine-url",
	...Object.keys(THRESHOLD_FLAGS),
]);

/** Flags that carry no value. */
const BOOLEAN_FLAGS = new Set(["--json", "--help", "-h"]);

export interface GateOptions {
	engineUrl: string;
	/** Print the raw report instead of the human table. */
	json: boolean;
	/**
	 * The run description in the shape {@link buildLoadRunPayload} reads, so the
	 * gate and `start_load_run` build the same payload from the same code.
	 */
	toolArgs: Record<string, unknown>;
}

export const GATE_USAGE = `vayu gate - run a load test and fail the build when it misses its budget.

Usage:
  gate-cli --url <url> [--method GET] [--mode ${DEFAULT_GATE_MODE}] [--concurrency N]
           [--duration 60s] --p99 <ms> [--p95 <ms>] [--p50 <ms>]
           [--error-rate <pct>] [--min-rps <rps>]
           [--request-id <id>] [--environment-id <id>]
           [--engine-url ${DEFAULT_ENGINE_URL}] [--json]

Target (one is required):
  --url <url>              Ad-hoc target. May contain {{variables}}.
  --request-id <id>        Load-test a saved request, composed engine-side.
                           With --url as well, the saved request is retargeted.
  --method <verb>          HTTP method for an ad-hoc target (default GET).
  --environment-id <id>    Environment whose variables resolve {{templates}}.

Load shape:
  --mode <mode>            ${GATE_MODES.join(" | ")} (default ${DEFAULT_GATE_MODE}).
  --concurrency <n>        In-flight requests to hold (constant_concurrency).
  --target-rps <n>         Request rate to hold (constant_rps).
  --duration <d>           Run length, e.g. 500ms, 30s, 5m, 2h (default 60s).

Budgets (at least one is required - a run with no budget is not a gate):
  --p50 <ms>  --p95 <ms>  --p99 <ms>   Latency percentile ceilings.
  --error-rate <pct>                   Maximum error rate, 0-100.
  --min-rps <rps>                      Minimum sustained throughput.

Other:
  --engine-url <url>       Running engine (default ${DEFAULT_ENGINE_URL}).
                           The gate never starts or stops the engine.
  --json                   Print the raw run report instead of the table.
  -h, --help               Show this help.

Exit codes: ${EXIT_PASSED} every budget met, ${EXIT_FAILED} a budget missed, ${EXIT_OPERATIONAL} the gate could not judge the run.`;

/** Raised by {@link parseGateArgs} when `--help` was asked for. */
export class GateHelpRequested extends Error {
	constructor() {
		super(GATE_USAGE);
		this.name = "GateHelpRequested";
	}
}

function parseNumberFlag(
	flag: string,
	raw: string,
	bounds: { min: number; max: number; minInclusive?: boolean; integer?: boolean }
): number {
	const value = Number(raw);
	if (raw.trim() === "" || !Number.isFinite(value)) {
		throw new GateUsageError(`${flag} ${JSON.stringify(raw)} is not a number.`);
	}
	if (bounds.integer && !Number.isInteger(value)) {
		throw new GateUsageError(`${flag} ${raw} must be a whole number.`);
	}
	const aboveMin = bounds.minInclusive ? value >= bounds.min : value > bounds.min;
	if (!aboveMin || value > bounds.max) {
		throw new GateUsageError(
			`${flag} ${raw} is out of range - it must be ${
				bounds.minInclusive ? `at least ${bounds.min}` : `greater than ${bounds.min}`
			} and at most ${bounds.max}.`
		);
	}
	return value;
}

/**
 * Turn a CI invocation into a run description, or refuse it by name.
 *
 * Every refusal names the flag and what was wrong with it: a pipeline reads
 * stderr, not a stack trace, and a gate that silently drops an unrecognised
 * `--p99` would report a green build for a budget nobody checked.
 */
export function parseGateArgs(argv: string[]): GateOptions {
	const seen = new Map<string, string>();
	let json = false;

	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		const eq = token.indexOf("=");
		const flag = eq === -1 ? token : token.slice(0, eq);

		if (BOOLEAN_FLAGS.has(flag)) {
			if (eq !== -1) throw new GateUsageError(`${flag} takes no value.`);
			if (flag === "--help" || flag === "-h") throw new GateHelpRequested();
			json = true;
			continue;
		}
		if (!VALUE_FLAGS.has(flag)) {
			throw new GateUsageError(
				`Unknown flag ${JSON.stringify(token)}. Run with --help for the flag list.`
			);
		}
		let value: string;
		if (eq !== -1) {
			value = token.slice(eq + 1);
		} else {
			if (i + 1 >= argv.length) throw new GateUsageError(`${flag} needs a value.`);
			value = argv[++i];
		}
		// A budget stated twice is a budget one of whose values is being
		// ignored, and which one is not something a pipeline should have to
		// know. Same for every other flag.
		if (seen.has(flag)) throw new GateUsageError(`${flag} was given more than once.`);
		seen.set(flag, value);
	}

	const url = seen.get("--url");
	const requestId = seen.get("--request-id");
	if (url === undefined && requestId === undefined) {
		throw new GateUsageError(
			"Name a target: --url for an ad-hoc run, or --request-id for a saved request."
		);
	}
	if (url !== undefined && url.trim() === "") throw new GateUsageError("--url is empty.");
	if (requestId !== undefined && requestId.trim() === "") {
		throw new GateUsageError("--request-id is empty.");
	}

	const mode = (seen.get("--mode") ?? DEFAULT_GATE_MODE) as GateMode;
	if (!(GATE_MODES as readonly string[]).includes(mode)) {
		throw new GateUsageError(
			`--mode ${JSON.stringify(mode)} is not a gate mode. Use ${GATE_MODES.join(" or ")} - ` +
				"capacity, ramp_up and iterations runs take parameters this CLI does not expose, " +
				"so they are started from the app or from POST /runs."
		);
	}

	const toolArgs: Record<string, unknown> = { mode };
	if (url !== undefined) toolArgs.url = url;
	if (requestId !== undefined) toolArgs.requestId = requestId;
	const method = seen.get("--method");
	if (method !== undefined) {
		if (method.trim() === "") throw new GateUsageError("--method is empty.");
		toolArgs.method = method;
	}
	const environmentId = seen.get("--environment-id");
	if (environmentId !== undefined) toolArgs.environmentId = environmentId;

	// `concurrency` is read only by the closed-loop strategy and `targetRps`
	// only by the open-loop one (`LoadStrategy::create`), so accepting the
	// other one would be a flag the run never reads - the defect this repo
	// names most often. Refuse the pairing instead.
	const concurrency = seen.get("--concurrency");
	const targetRps = seen.get("--target-rps");
	if (mode === "constant_rps") {
		if (concurrency !== undefined) {
			throw new GateUsageError(
				"--concurrency is not read in constant_rps mode - that run holds a request rate, not a number of in-flight requests. Use --target-rps, or --mode constant_concurrency."
			);
		}
		if (targetRps === undefined) {
			throw new GateUsageError("--mode constant_rps needs --target-rps: the rate to hold.");
		}
	} else if (targetRps !== undefined) {
		throw new GateUsageError(
			`--target-rps is not read in ${mode} mode - that run holds a concurrency, not a rate. Use --concurrency, or --mode constant_rps.`
		);
	}
	if (concurrency !== undefined) {
		toolArgs.concurrency = parseNumberFlag("--concurrency", concurrency, {
			min: 0,
			max: Number.MAX_SAFE_INTEGER,
			integer: true,
		});
	}
	if (targetRps !== undefined) {
		toolArgs.targetRps = parseNumberFlag("--target-rps", targetRps, {
			min: 0,
			max: Number.MAX_SAFE_INTEGER,
		});
	}

	const duration = seen.get("--duration");
	if (duration !== undefined) {
		if (parseDurationSeconds(duration) === null) {
			throw new GateUsageError(
				`--duration ${JSON.stringify(duration)} is not a positive duration. Use a number with an optional ms/s/m/h unit, e.g. "500ms", "30s", "5m", "2h".`
			);
		}
		toolArgs.duration = duration;
	}

	const thresholds: Record<string, number> = {};
	for (const [flag, spec] of Object.entries(THRESHOLD_FLAGS)) {
		const raw = seen.get(flag);
		if (raw === undefined) continue;
		thresholds[spec.key] = parseNumberFlag(flag, raw, spec);
	}
	if (Object.keys(thresholds).length === 0) {
		throw new GateUsageError(
			`Declare at least one budget (${Object.keys(THRESHOLD_FLAGS).join(", ")}). A run with no budget is a smoke run, and the gate would have nothing to judge.`
		);
	}
	toolArgs.thresholds = thresholds;

	const engineUrl = seen.get("--engine-url") ?? DEFAULT_ENGINE_URL;
	if (engineUrl.trim() === "") throw new GateUsageError("--engine-url is empty.");

	return { engineUrl, json, toolArgs };
}

/**
 * How long to wait for the run before calling it a timeout: what the run was
 * asked to take, plus {@link POLL_GRACE_MS}. An omitted `--duration` is not
 * "unbounded" - the engine has its own default for the mode, and that is the
 * number the deadline has to be built from.
 */
export function pollBudgetMs(toolArgs: Record<string, unknown>): number {
	const mode = typeof toolArgs.mode === "string" ? toolArgs.mode : DEFAULT_GATE_MODE;
	const declared = parseDurationSeconds(toolArgs.duration as string | undefined);
	const seconds = declared ?? engineDefaultDurationSeconds(mode);
	return seconds * 1000 + POLL_GRACE_MS;
}

/** Statuses that mean the run is still going (`RunStatus` in the engine). */
const RUNNING_STATUSES = new Set(["pending", "running"]);

/** The engine surface the gate needs - a subset, so a test can stand one up. */
export type GateEngineClient = Pick<
	EngineClient,
	"composeRequest" | "startRun" | "getRun" | "getRunReport"
>;

function readString(value: unknown, key: string): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const field = (value as Record<string, unknown>)[key];
	return typeof field === "string" ? field : undefined;
}

/**
 * Wait until the run stops running, and answer with the status it stopped at.
 *
 * The clock and the sleep are injected rather than taken from the runtime: the
 * timeout is the branch a gate depends on most and the one hardest to observe,
 * so a test drives it directly instead of racing real timers.
 */
export async function pollUntilTerminal(deps: {
	client: Pick<GateEngineClient, "getRun">;
	runId: string;
	budgetMs: number;
	intervalMs?: number;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	signal?: AbortSignal;
}): Promise<string> {
	const interval = deps.intervalMs ?? POLL_INTERVAL_MS;
	const deadline = deps.now() + deps.budgetMs;

	for (;;) {
		const run = await deps.client.getRun(deps.runId, deps.signal);
		const status = readString(run, "status");
		if (status === undefined) {
			throw new GateOperationalError(
				`Engine returned no status for run ${deps.runId} - cannot tell whether it finished.`
			);
		}
		if (!RUNNING_STATUSES.has(status)) return status;
		if (deps.now() >= deadline) {
			throw new GateOperationalError(
				`Run ${deps.runId} was still "${status}" after ${Math.round(deps.budgetMs / 1000)}s. ` +
					"The gate gave up waiting; the run is still the engine's - stop it there if it is stuck."
			);
		}
		await deps.sleep(interval);
	}
}

export interface ThresholdCheck {
	metric: string;
	limit: number;
	actual: number;
	passed: boolean;
}

export interface ThresholdValidation {
	checks: ThresholdCheck[];
	passed: number;
	failed: number;
	verdict: "passed" | "failed";
}

/**
 * The run's verdict, or a refusal explaining why there is none.
 *
 * A report with no `thresholdValidation` is not a pass: the gate always sends
 * budgets, so an absent section means the engine did not judge the run - an
 * engine predating that section, or a run that never wrote a summary. Reporting
 * it as green is the one failure mode a gate must not have.
 */
export function readThresholdValidation(report: unknown, runId: string): ThresholdValidation {
	const section =
		report && typeof report === "object" && !Array.isArray(report)
			? (report as Record<string, unknown>).thresholdValidation
			: undefined;
	if (!section || typeof section !== "object" || Array.isArray(section)) {
		throw new GateOperationalError(
			`Run ${runId} came back with no thresholdValidation section, so there is no verdict to gate on. ` +
				"The gate sent budgets, so this means the engine did not judge them - check that the engine is 0.14.0 or newer and that the run recorded a summary."
		);
	}
	const raw = section as Record<string, unknown>;
	const verdict = raw.verdict;
	if (verdict !== "passed" && verdict !== "failed") {
		throw new GateOperationalError(
			`Run ${runId} reported an unrecognised verdict ${JSON.stringify(verdict)}.`
		);
	}
	const checks = Array.isArray(raw.checks)
		? (raw.checks as unknown[]).flatMap((entry) => {
				if (!entry || typeof entry !== "object") return [];
				const c = entry as Record<string, unknown>;
				return [
					{
						metric: String(c.metric ?? "unknown"),
						limit: Number(c.limit),
						actual: Number(c.actual),
						passed: c.passed === true,
					},
				];
			})
		: [];
	return {
		checks,
		passed: typeof raw.passed === "number" ? raw.passed : checks.filter((c) => c.passed).length,
		failed:
			typeof raw.failed === "number" ? raw.failed : checks.filter((c) => !c.passed).length,
		verdict,
	};
}

/** {@link EXIT_PASSED} or {@link EXIT_FAILED} - never the operational code. */
export function verdictExitCode(validation: ThresholdValidation): number {
	return validation.verdict === "passed" ? EXIT_PASSED : EXIT_FAILED;
}

/** At most three decimals, without the trailing zeroes a table does not need. */
function fmt(value: number): string {
	if (!Number.isFinite(value)) return String(value);
	return String(Math.round(value * 1000) / 1000);
}

function column(text: string, width: number): string {
	return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/**
 * The human output: the run's headline numbers, then one row per budget with
 * its limit and what the run actually did. Every failed check is named with
 * both numbers - "it was slow" is not something a pipeline log can act on.
 */
export function formatGateReport(
	runId: string,
	validation: ThresholdValidation,
	report: unknown
): string {
	const lines: string[] = [];
	const summary =
		report && typeof report === "object" && !Array.isArray(report)
			? ((report as Record<string, unknown>).summary as Record<string, unknown> | undefined)
			: undefined;

	lines.push(`Run ${runId}`);
	if (summary && typeof summary === "object") {
		const headline = [
			typeof summary.totalRequests === "number"
				? `${summary.totalRequests} requests`
				: undefined,
			typeof summary.errorRate === "number" ? `${fmt(summary.errorRate)}% errors` : undefined,
			typeof summary.avgRps === "number" ? `${fmt(summary.avgRps)} rps` : undefined,
			typeof summary.totalDurationSeconds === "number"
				? `${fmt(summary.totalDurationSeconds)}s`
				: undefined,
		].filter((part): part is string => part !== undefined);
		if (headline.length > 0) lines.push(`  ${headline.join("   ")}`);
	}
	lines.push("");

	const rows = validation.checks.map((check) => ({
		metric: check.metric,
		limit: fmt(check.limit),
		actual: fmt(check.actual),
		result: check.passed ? "PASS" : "FAIL",
	}));
	const metricWidth = Math.max(6, ...rows.map((r) => r.metric.length));
	const limitWidth = Math.max(5, ...rows.map((r) => r.limit.length));
	const actualWidth = Math.max(6, ...rows.map((r) => r.actual.length));
	lines.push(
		`  ${column("METRIC", metricWidth)}  ${column("LIMIT", limitWidth)}  ${column("ACTUAL", actualWidth)}  RESULT`
	);
	for (const row of rows) {
		lines.push(
			`  ${column(row.metric, metricWidth)}  ${column(row.limit, limitWidth)}  ${column(row.actual, actualWidth)}  ${row.result}`
		);
	}
	lines.push("");
	const total = validation.passed + validation.failed;
	lines.push(
		validation.verdict === "passed"
			? `VERDICT: PASSED (${validation.passed}/${total} budgets met)`
			: `VERDICT: FAILED (${validation.failed}/${total} budgets missed)`
	);
	return lines.join("\n");
}

export interface GateDeps {
	client: GateEngineClient;
	options: GateOptions;
	stdout: (line: string) => void;
	stderr: (line: string) => void;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	intervalMs?: number;
	signal?: AbortSignal;
}

/**
 * Start the run, wait for it, print the verdict, and answer with the exit code
 * the process should carry. Never throws for an expected outcome - a missed
 * budget and an unreachable engine are both results here, and both have a code.
 */
export async function runGate(deps: GateDeps): Promise<number> {
	const { client, options } = deps;
	try {
		const built = await buildLoadRunPayload(options.toolArgs, client, deps.signal);
		const payload = built.payload;
		if (!String(payload.url ?? "")) {
			throw new GateOperationalError(
				`Saved request "${String(options.toolArgs.requestId)}" has no URL to load-test.`
			);
		}
		if (built.droppedPreRequestScripts > 0) {
			// The same caveat `start_load_run` reports, for the same reason: the
			// engine has no pre-request hook on POST /runs, so anything the saved
			// request signs there is missing from every request this run sends.
			deps.stderr(
				`warning: ${built.droppedPreRequestScripts} pre-request script(s) on this saved request were not applied - POST /runs has no pre-request hook.`
			);
		}

		const started = await client.startRun(payload, deps.signal);
		const runId = readString(started, "runId");
		if (!runId) {
			throw new GateOperationalError("Engine accepted the run but returned no run id.");
		}
		deps.stderr(
			`Started run ${runId} against ${String(payload.url)} (${String(payload.mode)}).`
		);

		const status = await pollUntilTerminal({
			client,
			runId,
			budgetMs: pollBudgetMs(options.toolArgs),
			intervalMs: deps.intervalMs,
			now: deps.now,
			sleep: deps.sleep,
			signal: deps.signal,
		});
		if (status !== "completed") {
			throw new GateOperationalError(
				`Run ${runId} ended as "${status}", so it produced no verdict to gate on.`
			);
		}

		const report = await client.getRunReport(runId, deps.signal);
		const validation = readThresholdValidation(report, runId);
		deps.stdout(
			options.json
				? JSON.stringify(report, null, 2)
				: formatGateReport(runId, validation, report)
		);
		return verdictExitCode(validation);
	} catch (err) {
		deps.stderr(gateErrorMessage(err));
		return EXIT_OPERATIONAL;
	}
}

/** What a pipeline should read on stderr for a failure the gate cannot judge. */
export function gateErrorMessage(err: unknown): string {
	if (err instanceof GateUsageError) return `usage: ${err.message}`;
	if (err instanceof GateOperationalError) return `error: ${err.message}`;
	if (err instanceof EngineRequestError) {
		return `error: engine responded ${err.status}: ${err.body || err.message}`;
	}
	if (err instanceof Error) return `error: ${err.message}`;
	return `error: ${String(err)}`;
}
