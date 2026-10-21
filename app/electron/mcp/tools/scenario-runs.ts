/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file scenario-runs.ts
 * @brief A collection as the unit of work: the pre-flight walk over a
 *        scenario's steps and the scenario load run.
 */

import type { EngineClient } from "../engine-client.js";
import {
	checkAllowlist,
	checkLoadCaps,
	checkMonitorHost,
	checkSampleCap,
	type EngineLoadDefaults,
} from "../safety.js";
import type { ToolContext, ToolResult } from "./contract.js";
import {
	confirmDestructive,
	engineErrorResult,
	errorResult,
	num,
	str,
	ToolArgError,
	watchedRun,
	withCaveat,
} from "./kit.js";
import { startedRunResult } from "./run-status.js";
import {
	applyRecordingKnobs,
	composeViaEngine,
	DEFAULT_LOAD_MODE,
	describeLoadShape,
	loadShapePayload,
	readLoadParams,
	resolveEnvironmentId,
	resolveLoadShape,
	withMcpOrigin,
} from "./compose.js";
import { collectionParent, type CollectionRow, readCollectionRows } from "./cascade.js";
import { mergeSiblings, readRequestRows } from "./sibling-order.js";

/** A step of a scenario plan, as much of it as the pre-flight walk needs. */
interface ScenarioStepRow {
	id: string;
	name: string;
}

/**
 * The saved requests a scenario run will execute, in the order the engine will
 * execute them (issue #754).
 *
 * Mirrors `collect_requests` (`engine/src/core/scenario_plan.cpp`): without
 * `recursive` a collection's direct requests are the whole plan; with it, each
 * collection's sub-collections and requests are walked as one sibling list
 * (#2535), a request emitted where it sits and a sub-collection's whole subtree
 * where the sub-collection sits - the order the sidebar renders. The order
 * matters here for one reason - the pre-flight refusal names the first step
 * that fails - so a walk in some other order would name a different step than
 * the run would have reached first. `recursive-run-order-conformance.json`
 * pins this walk to the engine's (`sibling-order.conformance.test.ts`).
 *
 * The `visited` set is the same guard the engine's walk carries: a corrupted
 * `parentId` (a self-parent, an A -> B -> A loop) must terminate rather than
 * enumerate forever.
 */
export async function scenarioStepRows(
	client: Pick<EngineClient, "listCollections" | "listRequests">,
	collectionId: string,
	recursive: boolean,
	signal?: AbortSignal
): Promise<ScenarioStepRow[]> {
	const requestsIn = async (id: string) => readRequestRows(await client.listRequests(id, signal));
	if (!recursive) return (await requestsIn(collectionId)).map(toStepRow);

	// One read, grouped by parent; each parent's folders are merged with its
	// requests below, so their order here does not matter.
	const foldersOf = new Map<string, CollectionRow[]>();
	for (const row of readCollectionRows(await client.listCollections(signal))) {
		const parent = collectionParent(row);
		if (parent === null) continue;
		foldersOf.set(parent, [...(foldersOf.get(parent) ?? []), row]);
	}

	const ordered: ScenarioStepRow[] = [];
	const visited = new Set<string>();
	const walk = async (id: string): Promise<void> => {
		if (visited.has(id)) return;
		visited.add(id);
		for (const child of mergeSiblings(foldersOf.get(id) ?? [], await requestsIn(id))) {
			if (child.kind === "request") ordered.push(toStepRow(child));
			else await walk(child.id);
		}
	};
	await walk(collectionId);
	return ordered;
}

/** A `GET /requests` row as a plan step, named the way the engine's refusal names it. */
function toStepRow(row: { id: string; name?: unknown }): ScenarioStepRow {
	return { id: row.id, name: typeof row.name === "string" ? row.name : row.id };
}

/**
 * How a step is named in a refusal: the engine's own `describe_step` wording
 * (`scenario_plan.cpp`), including its zero-based index, so a pre-flight refusal
 * and the engine's own refusal for the same step read identically.
 */
function describeScenarioStep(index: number, row: ScenarioStepRow): string {
	return `step ${index} (request '${row.name}', id '${row.id}')`;
}

/**
 * Gate every step of a scenario against the allowlist *before* the run exists,
 * and return how many steps the plan has.
 *
 * A scenario is one run: there is no per-step skip the way `run_collection_smoke`
 * has one, because the engine starts the whole sequence or none of it. So a
 * single un-allowlisted step refuses the run and **nothing is started** - the
 * alternative would be an agent generating traffic against a host it was never
 * pointed at, in the middle of a sequence it cannot stop selectively.
 *
 * Composition is the engine's, by id, with the caller's environment - the same
 * call `resolve_scenario` makes for each step, which is what makes the URL this
 * gate reads the URL the run would send to. A step that will not compose refuses
 * here too: the engine resolves the identical plan before it creates the run row
 * and would refuse it for the same reason, so failing early costs nothing and
 * says so in the same words.
 *
 * A refusal names the host (`gate.error` does) and never the composed URL: the
 * URL is secret-resolved, so its query string or userinfo can carry a secret
 * variable's value or a literal credential, and this error is not passed through
 * the reveal-off withholding (#1892).
 *
 * Throws {@link ToolArgError} for a refusal; engine transport failures propagate
 * to the caller's `engineErrorResult`.
 */
export async function preflightScenarioSteps(
	target: { collectionId: string; recursive: boolean; environmentId?: string },
	ctx: ToolContext,
	signal?: AbortSignal
): Promise<number> {
	const rows = await scenarioStepRows(ctx.client, target.collectionId, target.recursive, signal);
	for (let index = 0; index < rows.length; index++) {
		const row = rows[index];
		const step = describeScenarioStep(index, row);
		let composed: Record<string, unknown>;
		try {
			composed = await composeViaEngine(
				ctx.client,
				{ requestId: row.id, environmentId: target.environmentId },
				signal
			);
		} catch (err) {
			// Invariant: engine compose errors name fields, never resolved values, so
			// the message is safe to relay with reveal off.
			throw new ToolArgError(
				`Cannot compose ${step}: ${err instanceof Error ? err.message : String(err)}. ` +
					`Nothing was started - the engine resolves this same plan before it creates the ` +
					`run, and would refuse it for this reason too.`
			);
		}
		const url = String(composed.url ?? "");
		const gate = checkAllowlist(url, ctx.config, ctx.host);
		if (!gate.ok) {
			throw new ToolArgError(
				`Refusing to run this collection: ${step} is not allowed. ${gate.error} ` +
					`Nothing was started - a scenario runs as one sequence, so a single step the ` +
					`allowlist does not cover refuses all ${rows.length} of them.`
			);
		}
	}
	return rows.length;
}

/** The scenario block's fields an agent states, as both scenario tools read them. */
export interface ScenarioArg {
	collectionId: string;
	recursive?: boolean;
	data?: unknown[];
	/** The rows' file by name and content hash (issue #2051); never a path. */
	dataFileName?: string;
	dataFileHash?: string;
}

/** The scenario block an agent passed to `start_load_run`, if it passed one. */
export function readScenarioArg(args: Record<string, unknown>): ScenarioArg | undefined {
	const block = args.scenario;
	if (!block || typeof block !== "object" || Array.isArray(block)) return undefined;
	return block as ScenarioArg;
}

/**
 * `start_load_run`'s arguments that describe a *single* target, which a scenario
 * replaces wholesale, mapped to what an agent should do instead.
 *
 * Refused rather than ignored: each of these would otherwise be an argument an
 * agent believes shaped the run and that nothing on the scenario path ever reads
 * - the codebase's most-repeated defect, arriving through the front door. The
 * steps are saved requests, so their method, body, auth, protocol and scripts
 * are the stored ones, composed per step.
 */
const SINGLE_TARGET_LOAD_FIELDS: ReadonlyArray<[string, string]> = [
	["url", "a scenario's targets are the collection's saved requests"],
	["requestId", "a scenario runs a collection, not one saved request"],
	["method", "each step keeps its own stored method"],
	["headers", "each step keeps its own stored headers"],
	["body", "each step keeps its own stored body"],
	["bodyType", "each step keeps its own stored body"],
	["auth", "each step's auth is resolved from the request and its collection chain"],
	["httpVersion", "each step keeps its own stored protocol"],
	[
		"followRedirects",
		"each step keeps its own stored redirect policy - set it on the saved request",
	],
	[
		"maxRedirects",
		"each step keeps its own stored redirect policy - set it on the saved request",
	],
	[
		"data",
		"a collection run states its rows as `scenario.data`, where one row is bound per iteration and shared by every step",
	],
	["dataFileName", "a collection run names its rows' file as `scenario.dataFileName`"],
	["dataFileHash", "a collection run states its rows' file hash as `scenario.dataFileHash`"],
	[
		"disabledDefaultHeaders",
		"the engine reads a send's default-header refusals off one request's payload, and a scenario's steps are each composed from their own saved request",
	],
	["postRequestScript", "each step runs the scripts stored on it and its collection chain"],
	["tests", "each step runs the scripts stored on it and its collection chain"],
	[
		"collectionId",
		"the collection to run is `scenario.collectionId`; this argument only scopes variable resolution for a single ad-hoc target",
	],
	["maxInFlight", "in-flight requests are bounded by the virtual-user count (`concurrency`)"],
	["sloMs", "that is `capacity` mode's field, and a scenario cannot run in capacity mode"],
	["stepDuration", "that is `capacity` mode's field, and a scenario cannot run in capacity mode"],
	["stream", "run-level stream bounds are applied to a single-target run's request only"],
	[
		"maxStreamDurationMs",
		"run-level stream bounds are applied to a single-target run's request only",
	],
	[
		"maxStreamEvents",
		"run-level stream bounds are applied to a single-target run's request only",
	],
];

/** The modes the engine will drive a scenario with (`validate_scenario_load_config`). */
const SCENARIO_LOAD_MODES = ["constant_concurrency", "ramp_up", "iterations"] as const;

/**
 * The scenario executor's defaults (`execute_scenario_load`, `scenario_load.cpp`),
 * which are not the single-target strategies': every mode drives 10 virtual
 * users when `concurrency` is absent. `safety.test.ts` reads that file to keep
 * these in step.
 */
export const SCENARIO_LOAD_DEFAULTS = {
	constant_concurrency: { concurrency: 10, durationSeconds: 60 },
	ramp_up: {
		concurrency: 10,
		startConcurrency: 1,
		durationSeconds: 60,
		rampUpDurationSeconds: 10,
	},
	iterations: { concurrency: 10, iterations: 1000 },
} as const satisfies Record<(typeof SCENARIO_LOAD_MODES)[number], EngineLoadDefaults>;

/**
 * Why the engine refuses the other two modes, in its own reasoning rather than a
 * bare "unsupported": an agent told *why* `constant_rps` cannot drive a sequence
 * picks `constant_concurrency`, and one told only "no" tries again.
 */
function scenarioModeRefusal(mode: string): string | null {
	if ((SCENARIO_LOAD_MODES as readonly string[]).includes(mode)) return null;
	const shared = `Scenario load runs accept ${SCENARIO_LOAD_MODES.join(", ")}.`;
	if (mode === "capacity") {
		return (
			`"capacity" is not available for scenario runs: the search judges one p99 per level, ` +
			`and a sequence has one per step - which of them is "the" latency the knee is measured ` +
			`against is a question the mode does not answer. ${shared}`
		);
	}
	if (mode === "constant_rps") {
		return (
			`"constant_rps" is not available for scenario runs: an open-loop arrival rate over a ` +
			`multi-step sequence is an arrival-rate executor, which Vayu does not implement. ` +
			`${shared} For a scenario, "concurrency" is the number of virtual users.`
		);
	}
	return `Unknown load mode "${mode}" for a scenario run. ${shared}`;
}

/**
 * Start a scenario **load** run: the collection's plan driven by virtual users
 * (issue #754, reversing #454's deferral).
 *
 * Split from `start_load_run`'s single-target path rather than folded into it,
 * because the two share only their gates: there is no request to compose here
 * (every step composes engine-side at plan time), no url to check (the
 * pre-flight walk checks every step's), and a different set of load fields
 * applies. What they do share - the allowlist, the load shape resolved against
 * the caps (each executor with its own defaults), `checkLoadCaps` and the
 * confirmation - runs through the same helpers, so a cap raised in Settings
 * binds both paths identically.
 */
export async function startScenarioLoadRun(
	args: Record<string, unknown>,
	scenario: ScenarioArg,
	ctx: ToolContext,
	signal?: AbortSignal
): Promise<ToolResult> {
	const inapplicable = SINGLE_TARGET_LOAD_FIELDS.filter(([key]) => args[key] !== undefined);
	if (inapplicable.length > 0) {
		return errorResult(
			`These arguments do not apply to a scenario load run: ` +
				inapplicable.map(([key, why]) => `"${key}" (${why})`).join("; ") +
				`. Nothing was started - each of them would have been read as shaping this run ` +
				`while the scenario executor never looks at it. Remove them and retry.`
		);
	}

	const mode = str(args, "mode") ?? DEFAULT_LOAD_MODE;
	const modeRefusal = scenarioModeRefusal(mode);
	if (modeRefusal) return errorResult(modeRefusal);
	// The engine refuses a rate on either spelling, because either one selects
	// the open-loop path regardless of the declared mode.
	if (typeof args.targetRps === "number" && args.targetRps > 0) {
		return errorResult(
			`"targetRps" is not available for scenario runs: it selects an open-loop arrival rate, ` +
				`and a scenario run is closed-loop by design. Set "concurrency" - the number of ` +
				`virtual users - instead.`
		);
	}

	const monitor = args.monitor as { url?: unknown } | undefined;
	if (monitor && typeof monitor === "object") {
		const monitorGate = checkMonitorHost(String(monitor.url ?? ""), ctx.config, ctx.host);
		if (!monitorGate.ok) return errorResult(monitorGate.error!);
	}

	// No `targetRps`: refused above, so the run is closed-loop at whatever
	// width the shape resolves.
	const shape = resolveLoadShape(
		{ ...readLoadParams(args), mode },
		ctx.config,
		SCENARIO_LOAD_DEFAULTS
	);
	const caps = checkLoadCaps(shape, ctx.config, ctx.host);
	if (!caps.ok) return errorResult(caps.error!);
	const sampleCap = checkSampleCap(num(args, "maxResponseSamples"), ctx.config, ctx.host);
	if (!sampleCap.ok) return errorResult(sampleCap.error!);

	const recursive = scenario.recursive === true;
	let environmentId: string | undefined;
	let plannedSteps: number;
	try {
		environmentId = await resolveEnvironmentId(args, ctx, signal);
		plannedSteps = await preflightScenarioSteps(
			{ collectionId: scenario.collectionId, recursive, environmentId },
			ctx,
			signal
		);
	} catch (err) {
		if (err instanceof ToolArgError) return errorResult(err.message);
		return engineErrorResult(err, ctx);
	}

	const payload: Record<string, unknown> = {
		...loadShapePayload(shape),
		scenario: scenarioBlock(scenario, recursive),
		...(environmentId !== undefined ? { environmentId } : {}),
	};
	// Both travel verbatim for the same reason they do on the single-target
	// path: the keys are the engine's own and it is what judges the values.
	// Neither is executor-specific - a scenario load run is a load run, with the
	// same metrics thread, monitor scrape and end-of-run threshold evaluation.
	if (args.thresholds && typeof args.thresholds === "object")
		payload.thresholds = args.thresholds;
	if (monitor && typeof monitor === "object") payload.monitor = monitor;
	// The timers/scripts override (issue #1495), forwarded verbatim for the
	// same reason as thresholds/monitor above: the engine's validator owns
	// the shape and the value ranges.
	if (args.elements && typeof args.elements === "object") payload.elements = args.elements;
	// And for the same reason again: the recording knobs are read by the
	// `RunContext` both executors share, so a scenario run keeps traces on the
	// terms an agent stated exactly as a single-target run does.
	applyRecordingKnobs(args, payload);

	const summary =
		`Start a scenario load test over collection ${scenario.collectionId} ` +
		`(${plannedSteps} step(s) per iteration, ${describeLoadShape(shape)})?`;
	const unconfirmed = await confirmDestructive(args, ctx, {
		message: `${summary}\n\nThis generates real traffic within Vayu's caps.`,
		acceptTitle: "Start the load test",
		acceptDescription: "Confirm to generate load now.",
		declined: "Load run not started - the user declined.",
		preview:
			"AWAITING CONFIRMATION - no run was started.\n\n" +
			`${summary}\n\n` +
			"This is a preview. To start the load test, call start_load_run again with " +
			"confirmed: true and the same arguments.\n\n" +
			`Planned run (${plannedSteps} step(s) per iteration):\n${JSON.stringify(payload, null, 2)}`,
	});
	if (unconfirmed) return unconfirmed;

	// Read here rather than through `callEngine` for the reason the single-target
	// path states: the run id in the answer is what the renderer watches (#1419).
	let started: unknown;
	try {
		started = await ctx.client.startRun(withMcpOrigin(payload, ctx), signal);
	} catch (err) {
		return engineErrorResult(err, ctx);
	}
	return watchedRun(
		withCaveat(
			startedRunResult(started, shape),
			`\n\nThe plan is ${plannedSteps} step(s) per iteration. Once the run is terminal, ` +
				`get_run_report's \`scenario\` section carries the virtual-user, iteration and ` +
				`per-step breakdown. Pre-request scripts DO run on a scenario load run - each virtual ` +
				`user walks the plan the way the design runner does.`
		),
		"load",
		started
	);
}

/** The `scenario` block `POST /runs` reads, from the arguments an agent gave. */
export function scenarioBlock(
	scenario: ScenarioArg,
	recursive: boolean,
	iterations?: number
): Record<string, unknown> {
	return {
		source: "collection",
		collectionId: scenario.collectionId,
		recursive,
		// Omitted rather than defaulted: with `data` present and this absent the
		// engine sets the pass count to the row count, and a client computing
		// its own would be a second copy of a rule only one side enforces.
		...(iterations !== undefined ? { iterations } : {}),
		...(scenario.data !== undefined ? { data: scenario.data } : {}),
		// Forwarded as given, rows or not: the engine refuses either one sent
		// without `data`, by name, rather than this layer dropping it.
		...(scenario.dataFileName !== undefined ? { dataFileName: scenario.dataFileName } : {}),
		...(scenario.dataFileHash !== undefined ? { dataFileHash: scenario.dataFileHash } : {}),
	};
}

/** Convert a `{key: value}` header map to the engine's KeyValueEntry[] shape. */
export function toKeyValueEntries(
	headers: unknown
): Array<{ key: string; value: string; enabled: boolean }> {
	if (!headers || typeof headers !== "object") return [];
	return Object.entries(headers as Record<string, unknown>).map(([key, value]) => ({
		key,
		value: String(value),
		enabled: true,
	}));
}
