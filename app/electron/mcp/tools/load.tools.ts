/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file load.tools.ts
 * @brief `start_load_run`: a load test over one request or a collection scenario.
 */

import { z } from "zod";
import {
	checkAllowlist,
	checkLoadCaps,
	checkMonitorHost,
	ENGINE_LOAD_DEFAULTS,
	type EngineLoadDefaults,
	LOAD_MODES,
	type LoadDefaultsTable,
} from "../safety.js";
import { HTTP_VERSIONS } from "../http-versions.js";
import { WITHHELD_PLANNED_RUN_SENTENCE, withholdPlannedRequest } from "../withhold.js";
import type { McpTool } from "./contract.js";
import {
	confirmDestructive,
	confirmedInput,
	engineErrorResult,
	errorResult,
	num,
	str,
	ToolArgError,
	watchedRun,
	withCaveat,
} from "./kit.js";
import { inlineFileInput } from "./request-body.js";
import {
	agentScriptGateSentence,
	applyDefaultHeaderOptOuts,
	applyRecordingKnobs,
	composeLoadRunRequest,
	DEFAULT_LOAD_MODE,
	describeLoadShape,
	loadShapePayload,
	MAX_IN_FLIGHT_BOUND,
	MAX_REDIRECTS_BOUND,
	MAX_SLOW_THRESHOLD_MS,
	MAX_SUCCESS_SAMPLE_PERIOD,
	readLoadParams,
	resolveLoadShape,
	withMcpOrigin,
} from "./compose.js";
import {
	authInput,
	collectionIdInput,
	defaultHeaderOptOutsInput,
	elementsTimersInput,
	ENGINE_DEFAULT_HEADERS_SENTENCE,
	environmentIdInput,
	LOAD_RUN_SCHEMA_GATE_REFUSAL,
	scenarioDataInput,
	dataFileNameInput,
	dataFileHashInput,
	scenarioRecursiveInput,
	thresholdsInput,
	validationScriptAliasInput,
	validationScriptInput,
} from "./input-schemas.js";
import { startedRunResult } from "./run-status.js";
import { readScenarioArg, SCENARIO_LOAD_DEFAULTS, startScenarioLoadRun } from "./scenario-runs.js";

/**
 * One field's engine defaults as the schema states them, read from
 * {@link ENGINE_LOAD_DEFAULTS} so a description cannot fall behind the values
 * the tool actually sends: "100 (constant_concurrency, constant_rps, ramp_up),
 * 10 (iterations)".
 */
function statedDefaults(field: keyof EngineLoadDefaults, unit = ""): string {
	const table: LoadDefaultsTable = ENGINE_LOAD_DEFAULTS;
	const modesByValue = new Map<number, string[]>();
	for (const mode of LOAD_MODES) {
		const value = table[mode]?.[field];
		if (typeof value !== "number") continue;
		modesByValue.set(value, [...(modesByValue.get(value) ?? []), mode]);
	}
	return [...modesByValue]
		.map(([value, modes]) => `${value}${unit} (${modes.join(", ")})`)
		.join(", ");
}

export const LOAD_TOOLS: McpTool[] = [
	{
		name: "start_load_run",
		category: "load",
		invalidates: ["run"],
		description:
			"Start a load test against a URL, or against a saved request via `requestId` - which composes it exactly as the app does, including the collection chain's and its own test scripts, so a load run checks the same assertions a Send does. GUARDED: the host must be on the allowlist, and RPS, `concurrency` (virtual users) and duration must be within Vayu's caps. {{variables}} in the URL, headers, and body are resolved when an environmentId (and/or collectionId) is given; pass an `auth` block to authenticate the load (bearer/basic/apikey/oauth2, applied engine-side). Pass a `postRequestScript` - the same assertions you would give run_request - to validate responses under load; it runs against sampled responses. A pre-request script is not offered here for a single target: the engine runs one on a single request only, never on a load run. " +
			agentScriptGateSentence("`postRequestScript` or `tests`") +
			" Pass `scenario` INSTEAD of url/requestId to load-test a collection's ordered sequence: `concurrency` then means virtual users, each walking the plan with its own cookies and running every step's stored scripts, and only constant_concurrency, ramp_up and iterations can drive it. `{{$vu}}` and `{{$iteration}}` in the URL, headers or body are bound fresh by the engine immediately before each send, never at compose time: for a scenario run `{{$vu}}` is the sending virtual user's own 1-based number and `{{$iteration}}` its 0-based pass through the plan; for a single-target run (no `scenario`) `{{$vu}}` is always 1 - one URL repeated under load is one user's iterations, however many are in flight - and `{{$iteration}}` is the 0-based submission index. What the run *keeps* is yours to set too - `successSamplePeriod`, `slowRequestThresholdMs` and `saveTimingBreakdown` decide which responses are traced, and `comment` stamps the run with why it exists; all four apply to a scenario run as well. There is no per-request timeout on a run: the engine's `defaultTimeout` setting governs every transfer (change it with update_engine_config), so a slow target is a config change and not an argument here. Confirmation is required: if the client supports elicitation the user is prompted directly; otherwise call once for a preview, then again with `confirmed: true`. " +
			WITHHELD_PLANNED_RUN_SENTENCE +
			" " +
			ENGINE_DEFAULT_HEADERS_SENTENCE +
			" A load run reads `loadNegotiateCompression` rather than `negotiateCompression` for the Accept-Encoding decision, because decompressing every response changes what the run measures.",
		annotations: {
			title: "Start load test",
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: true,
		},
		inputSchema: {
			method: z.string().optional(),
			url: z
				.string()
				.optional()
				.describe(
					"Target URL (may contain {{variables}}). Required unless `requestId` names a saved request to load-test; supplying both retargets that request at this URL."
				),
			headers: z.record(z.string(), z.string()).optional(),
			body: z.string().optional().describe("Request body content."),
			file: inlineFileInput,
			// The two sibling tools have carried this text since they existed and
			// this one carried nothing, so an agent load-testing a GraphQL endpoint
			// had no way to discover the mode from the schema. The GET transport
			// rule is part of that: a load run goes out through the event loop's
			// `wire_url` / `has_wire_body` pair like any other send (#1228), so a
			// GraphQL run left on the default GET carries no body at all.
			bodyType: z
				.string()
				.optional()
				.describe(
					'Body type: json, text, graphql, jsonrpc, xml, form-data, x-www-form-urlencoded (default text). For the two form types, write `body` as `key=value&key=value`; it is split into form fields. A graphql `body` may be the bare query document, and the method decides how it travels: the `{"query": ...}` JSON envelope on POST, `query`/`operationName`/`variables` query parameters with no body on GET - so give a mutation `method` POST rather than leaving the run on the GET an unnamed method defaults to. A jsonrpc `body` may be the bare call object - the engine adds `"jsonrpc":"2.0"` and `"id":1` when it names no id, and sends a frame that already declares a string `"jsonrpc"` unchanged. A body that sends a file (`binary`, or a form-data file part) cannot be given here - save it with create_request and load-test the saved request by `requestId`. An xml `body` is stored and sent verbatim as application/xml.'
				),
			auth: authInput,
			httpVersion: z
				.enum(HTTP_VERSIONS)
				.optional()
				.describe(
					'Protocol to negotiate for this ad-hoc run: "auto" | "http1.1" | "http2" (default "auto"). There is no saved request behind this call, so this is how the protocol gets specified at all - not an override of a per-run setting.'
				),
			mode: z
				.enum(LOAD_MODES)
				.optional()
				.describe(
					`${LOAD_MODES.join(" | ")} (default ${DEFAULT_LOAD_MODE}). A shape field left out is sent as the engine's default for the mode (each field names its own), and the confirmation preview and the started result's \`shape\` state the run that will start.`
				),
			// Positive, because an agent's natural guess for "unlimited" is -1 or
			// 0, and the engine reads concurrency as an eager per-worker
			// pre-allocation count. It rejects those with a 400; failing here
			// names the field instead of surfacing an HTTP error.
			concurrency: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					`Number of virtual users, each keeping one request in flight (constant_concurrency, iterations); the target a ramp_up climbs to and the ceiling a capacity search will not climb past. Not a target for constant_rps, which is paced by \`targetRps\`. Default ${statedDefaults("concurrency")}; none when a \`targetRps\` paces the run. A scenario run's default is ${SCENARIO_LOAD_DEFAULTS.constant_concurrency.concurrency} virtual users in each of its modes.`
				),
			// Positive for the same reason `concurrency` is: the ramp is seeded
			// with this count, so a negative casts to ~1.8e19 engine-side and a
			// zero start is a ramp that begins with no traffic at all.
			startConcurrency: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					`Virtual users at the start of the ramp (ramp_up), or the first level a capacity search measures. Above \`concurrency\` ramps down. Default ${statedDefaults("startConcurrency")}.`
				),
			duration: z
				.string()
				.optional()
				.describe(
					`Duration with an optional ms/s/m/h unit, e.g. "500ms", "30s", "5m", "2h"; a bare number is seconds (non-iterations modes). Default ${statedDefaults("durationSeconds", "s")}, or the duration cap when that is shorter.`
				),
			rampUpDuration: z
				.string()
				.optional()
				.describe(
					`Ramp time (ramp_up), same units as \`duration\`. Default ${statedDefaults("rampUpDurationSeconds", "s")}.`
				),
			// Capacity discovery reuses `startConcurrency` (where the search
			// begins), `concurrency` (the ceiling it will not climb past) and
			// `duration` (the whole search's deadline), so it adds only these
			// two. The `sloMs` bound is the engine's, so a value this schema
			// accepts is one POST /runs accepts.
			sloMs: z
				.number()
				.positive()
				.max(60_000)
				.optional()
				.describe("p99 budget the capacity search looks for the edge of, in ms."),
			stepDuration: z
				.string()
				.optional()
				.describe(
					"How long each level of virtual users is held before it is judged (capacity), same units as `duration`."
				),
			// An iterations run stops on this count and reads no duration, so it
			// is the only thing bounding the run; `-1` would cast to ~1.8e19.
			iterations: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					`Iteration count (iterations mode). Default ${statedDefaults("iterations")}.`
				),
			targetRps: z.number().optional().describe("Target RPS (constant_rps)."),
			// Streaming under load (issue #576). Forwarded verbatim and bounded
			// only by the engine's own `constants::sse` ranges, on the
			// thresholds precedent: the engine validates before the run row
			// exists, so a value this schema accepts is one `POST /runs`
			// accepts, and re-deriving the rule here would be a second copy to
			// keep in step. The caps are refused there without `stream`, which
			// is what keeps an unbounded run from being mistaken for a capped
			// one - so this schema does not quietly drop them either.
			stream: z
				.boolean()
				.optional()
				.describe(
					"Consume each response as a text/event-stream. Under load a stream is bounded by construction: reaching a cap below completes it successfully rather than failing it."
				),
			maxStreamDurationMs: z
				.number()
				.int()
				.min(1000)
				.max(86_400_000)
				.optional()
				.describe(
					"Wall-clock cap on one stream, in ms (requires `stream`). Defaults to the engine's sseMaxStreamDurationMs."
				),
			maxStreamEvents: z
				.number()
				.int()
				.min(1)
				.max(10_000_000)
				.optional()
				.describe(
					"Event cap on one stream (requires `stream`). Defaults to the engine's sseMaxStreamEvents."
				),
			// A pending-request ceiling read as a `size_t`, so `-1` - the natural
			// "unlimited" spelling - removes the ceiling instead of tightening it.
			// The upper bound is the engine's, so a value this schema accepts is
			// one `POST /runs` accepts.
			maxInFlight: z
				.number()
				.int()
				.positive()
				.max(MAX_IN_FLIGHT_BOUND)
				.optional()
				.describe(
					`In-flight cap (constant_rps only), 1-${MAX_IN_FLIGHT_BOUND}. Default max(targetRps * 10, 1000).`
				),
			thresholds: thresholdsInput,
			// Shaped exactly as the engine's `monitor` block and forwarded
			// verbatim. The value bounds are deliberately not mirrored here the
			// way `thresholds`' are: `monitor.series`' ceiling is the
			// `monitorMaxSeries` **setting**, so a second copy in this schema
			// would refuse blocks the engine accepts as soon as the user raises
			// it - and `validate_run_config` already answers each one by field
			// name. This layer types the shape; the engine owns the ranges.
			monitor: z
				.object({
					url: z
						.string()
						.describe(
							"http(s) URL of a Prometheus /metrics or flat-JSON endpoint on the target. A loopback or private-network URL needs no allowlist entry; a public one is checked against the allowlist like the target URL is."
						),
					intervalMs: z
						.number()
						.optional()
						.describe(
							"Scrape cadence in ms, 250-60000 (default: the engine's setting)."
						),
					format: z
						.enum(["prometheus", "json"])
						.optional()
						.describe(
							'Body format: "prometheus" text exposition, or "json" (a flat object of numbers). Default "prometheus".'
						),
					series: z
						.array(z.string())
						.describe(
							'Metric names to read out of each scrape, e.g. ["process_cpu_seconds_total"]. At least one; the ceiling is the `monitorMaxSeries` setting (8 by default).'
						),
				})
				.optional()
				.describe(
					"Scrape the target's own metrics endpoint for the life of the run, so its CPU or memory can be read on the same timeline as p99 and throughput. The report comes back with a `monitor` section: per-series min/max/avg plus the sample and failed-scrape counts. Omit for a run that measures only the client side."
				),
			// The redirect policy of the request being load-tested. A saved
			// request carries its own (composed in, never elided), so these are
			// the override; an ad-hoc target has none, so they are the only way to
			// state one at all. Load-shape arguments they are not - which is why a
			// scenario run refuses them by name rather than ignoring them.
			followRedirects: z
				.boolean()
				.optional()
				.describe(
					"Whether a 3xx is followed (engine default: true). With `requestId`, overrides the policy stored on that request; on an ad-hoc target this is how the policy is stated at all. A load test that follows redirects measures the whole chain, so its latency is the chain's, not the first hop's."
				),
			maxRedirects: z
				.number()
				.int()
				.min(0)
				.max(MAX_REDIRECTS_BOUND)
				.optional()
				.describe(
					`How many redirects may be followed, 0-${MAX_REDIRECTS_BOUND} (engine default: 10; 0 means a 3xx is returned as the response). Requires \`followRedirects\` to be on to have any effect.`
				),
			// The recording knobs the app's load dialog sets. None of them changes
			// what the run *sends* - they decide what it keeps - so none takes a
			// gate of its own beyond the ones the run already passed.
			comment: z
				.string()
				.optional()
				.describe(
					"A note stamped on the run, shown beside it in History and in the report's `metadata.configuration`. Use it to say what the run was for - the reason a report is worth keeping is rarely recoverable from its numbers."
				),
			successSamplePeriod: z
				.number()
				.int()
				.min(1)
				.max(MAX_SUCCESS_SAMPLE_PERIOD)
				.optional()
				.describe(
					`Keep 1 in N successful responses (the engine's \`success_sample_rate\`, which is a period and not a percentage): 1 keeps every one, 100 keeps 1%. Default 100. Only sampled responses carry a timing breakdown, and only if \`saveTimingBreakdown\` is on. Range 1-${MAX_SUCCESS_SAMPLE_PERIOD}; 0 is a division by zero engine-side and is refused here.`
				),
			slowRequestThresholdMs: z
				.number()
				.int()
				.min(0)
				.max(MAX_SLOW_THRESHOLD_MS)
				.optional()
				.describe(
					'Capture any completion at or above this many milliseconds as an outlier, whatever the sampling period keeps. 0 disables outlier capture. This is the knob that answers "what did the slow 1% look like" - the sampled subset is uniform and will not contain them.'
				),
			saveTimingBreakdown: z
				.boolean()
				.optional()
				.describe(
					"Store the per-phase timing (DNS, connect, TLS, TTFB) of each sampled success, which is what fills the report's timing-breakdown section. Off by default - a breakdown is stored per retained record, so it is the knob that decides whether the run keeps traces at all."
				),
			requestId: z
				.string()
				.optional()
				.describe(
					"Load-test a saved request. It is composed the way the app composes it: {{variables}} resolved, its stored auth applied (inheriting through the collection chain), and its collection-chain + own test scripts run against sampled responses. Any field you also pass explicitly (url, method, headers, body, auth, tests) overrides the saved one. Omit this and `url` is required, for an ad-hoc run."
				),
			environmentId: environmentIdInput,
			collectionId: collectionIdInput,
			postRequestScript: validationScriptInput,
			tests: validationScriptAliasInput,
			disabledDefaultHeaders: defaultHeaderOptOutsInput,
			// The single-target data set (issue #993). Bounded by the engine's
			// own `maxScenarioDataRows` / `maxScenarioDataBytes`, whose 400 is
			// surfaced verbatim rather than re-derived here - the same posture
			// `scenarioDataInput` takes, and for the same reason: a copy of a
			// limit the user can raise in Settings would refuse payloads the
			// engine accepts.
			data: z
				.array(z.record(z.string(), z.unknown()))
				.optional()
				.describe(
					'Data rows for a single-target run, one flat object per row (e.g. [{"id":"1"},{"id":"2"}]). One row is bound per request sent, claimed off a run-wide cursor that wraps, so a run longer than the set repeats it. The columns a collection declares for its data file are its `dataSchema.columns` in list_collections. Every {{data.column}} in the URL, headers, body and auth credentials binds per submission, and the post-request script reads that submission\'s row as pm.iterationData. A present-but-empty array is refused by the engine, as is `data` beside a `scenario` block - a collection run states its rows as scenario.data instead. The set is not persisted (only its count is recorded on the run, with dataFileName / dataFileHash when given), but a bound value travels in the request that carried it and is stored with the run\'s retained traces.'
				),
			dataFileName: dataFileNameInput,
			dataFileHash: dataFileHashInput,
			// The other shape POST /runs accepts (issue #754). Mutually exclusive
			// with every single-target argument, which the handler refuses by name
			// rather than ignoring - see SINGLE_TARGET_LOAD_FIELDS.
			//
			// No `iterations` inside the block, unlike the design-mode runner's:
			// a load run reads the *top-level* `iterations` (`scenario_load.cpp`
			// takes it from the run config), and `scenario.iterations` is the
			// design runner's per-run pass count, which this executor never looks
			// at. Offering it here would be an argument written and never read.
			scenario: z
				.object({
					collectionId: z
						.string()
						.describe("Collection whose saved requests are the sequence."),
					recursive: scenarioRecursiveInput,
					data: scenarioDataInput,
					dataFileName: dataFileNameInput,
					dataFileHash: dataFileHashInput,
				})
				.optional()
				.describe(
					"Load-test a collection's ordered sequence instead of one target. Cannot be combined with url/requestId or any single-target field. `concurrency` is the number of virtual users, each walking the whole plan with its own cookies; `iterations` (top level) is the total passes across all of them in iterations mode. Modes: constant_concurrency (default), ramp_up, iterations - constant_rps and capacity are refused, with the engine's reasoning."
				),
			// The run-level override block issue #1495 defines on `POST /runs`
			// (`validate_elements_run_override`), now reaching a single target's
			// own elements too (issue #1594), the same way it already reaches a
			// scenario's. The engine's contract also takes `includeScriptTime`
			// and `seed`, but no control anywhere in the product - app or MCP -
			// sends either today, so they stay off this schema until something
			// actually needs them.
			elements: z
				.object({
					timers: elementsTimersInput(),
					scripts: z
						.enum(["asMarked", "allInline", "allDeferred"])
						.optional()
						.describe(
							'Forces every script.pre/script.post element\'s inline-vs-deferred execution for this run, overriding each element\'s own setting: "allInline" or "allDeferred". "asMarked" (default) leaves each at what it declares. On a single target, "allInline" is what makes a pre-request script actually reach the wire per submission - left "asMarked" with no per-element mark, it still never runs.'
						),
				})
				.optional()
				.describe(
					"Override how this run's stored timer.*/script.* elements execute, without editing the collection - the same block RunCollectionDialog's load-test section sends. Works on a scenario (\"scenario\") and on a single target alike."
				),
			// Declared only so it can be refused by name - see
			// LOAD_RUN_SCHEMA_GATE_REFUSAL for why an undeclared key would be
			// dropped in silence instead.
			failOnSchemaError: z
				.boolean()
				.optional()
				.describe(
					"Not available on a load run, and refused rather than ignored: the load executor validates sampled responses once the run has drained and never demotes a step, so this gate would decide nothing. Use run_collection to run the same collection in design mode with the contract as a gate. The schema verdict is reported either way, in the report's schemaValidation block."
				),
			confirmed: confirmedInput("actually start the run"),
		},
		handler: async (args, ctx, signal) => {
			// Before the branch, because the reason is the executor rather than the
			// shape of the target: no load path reads the flag, so a single-target
			// run would swallow it exactly as a scenario one would.
			if (args.failOnSchemaError !== undefined) {
				return errorResult(LOAD_RUN_SCHEMA_GATE_REFUSAL);
			}

			// A scenario replaces the single target wholesale - there is nothing to
			// compose here, so the branch comes before composition rather than
			// inside it.
			const scenario = readScenarioArg(args);
			if (scenario) return startScenarioLoadRun(args, scenario, ctx, signal);

			let composed;
			try {
				composed = await composeLoadRunRequest(args, ctx, signal);
			} catch (err) {
				if (err instanceof ToolArgError) return errorResult(err.message);
				return engineErrorResult(err, ctx);
			}
			const url = String(composed.payload.url ?? "");
			if (!url) {
				return errorResult(
					`Saved request "${str(args, "requestId")}" has no URL to load-test.`
				);
			}
			const gate = checkAllowlist(url, ctx.config, ctx.host);
			if (!gate.ok) return errorResult(gate.error!);

			// A monitored run contacts a second host, so it gets a second gate.
			// The scrape needs no duration cap of its own: the monitor thread is
			// joined when the run ends, so whatever bounds the run bounds it.
			const monitor = args.monitor as { url?: unknown } | undefined;
			if (monitor && typeof monitor === "object") {
				const monitorGate = checkMonitorHost(
					String(monitor.url ?? ""),
					ctx.config,
					ctx.host
				);
				if (!monitorGate.ok) return errorResult(monitorGate.error!);
			}

			// One shape for the guard, the preview and the payload: the caps judge
			// the run the engine will actually start, defaults included (#2437).
			const shape = resolveLoadShape(
				{ ...readLoadParams(args), targetRps: num(args, "targetRps") },
				ctx.config
			);
			const caps = checkLoadCaps(shape, ctx.config, ctx.host);
			if (!caps.ok) return errorResult(caps.error!);

			const payload: Record<string, unknown> = {
				...composed.payload,
				...loadShapePayload(shape),
				// The run-level timers/scripts override (issue #1594), same as a
				// scenario's - `validate_elements_run_override` reads it on every
				// `POST /runs` payload regardless of mode, and a single target's
				// own `requestElements` now has a pipeline for it to reach.
				...(args.elements && typeof args.elements === "object"
					? { elements: args.elements }
					: {}),
			};
			for (const key of ["maxInFlight", "sloMs", "maxStreamDurationMs", "maxStreamEvents"]) {
				if (typeof args[key] === "number") payload[key] = args[key];
			}
			// Forwarded only when present: the engine refuses a cap on a
			// non-streaming run, and refuses `stream` beside `transient`, so a
			// defaulted `false` here would turn "the caller said nothing" into
			// a claim the engine then has to judge (issue #576).
			if (typeof args.stream === "boolean") payload.stream = args.stream;
			// Forwarded verbatim, rows and all: the engine validates the set
			// before the run row exists and its refusal names the field, so a
			// second copy of those rules here could only drift (issue #993).
			if (Array.isArray(args.data)) payload.data = args.data;
			// The rows' file by name and hash (issue #2051), as given: the engine
			// refuses either one without `data`, by name.
			for (const key of ["dataFileName", "dataFileHash"]) {
				const v = str(args, key);
				if (v !== undefined) payload[key] = v;
			}
			// Forwarded verbatim - the keys are the engine's own metric names,
			// and they come back unchanged in `get_run_report`'s
			// `thresholdValidation`. Zod has already bounded every value.
			if (args.thresholds && typeof args.thresholds === "object") {
				payload.thresholds = args.thresholds;
			}
			// Same posture as `thresholds`: the keys are the engine's own and
			// `validate_run_config` is what judges the values, so the block
			// travels unchanged rather than being rebuilt field by field here.
			if (monitor && typeof monitor === "object") {
				payload.monitor = monitor;
			}
			applyRecordingKnobs(args, payload);
			// A single target's own send-time refusals (issue #1337). A scenario
			// run never reaches here: it refuses the field by name, because its
			// steps are composed one by one and nothing reads a run-level
			// opt-out - see SINGLE_TARGET_LOAD_FIELDS.
			applyDefaultHeaderOptOuts(args, payload);

			// A saved request's unmarked pre-request script does not run under
			// load unless this run's own `elements.scripts` forces every script
			// inline (issue #1594) - `composeLoadRunRequest` already folds that
			// override into `droppedPreRequestScripts` itself (0 whenever
			// "allInline" applies), so a non-zero count here is always real. Say
			// so rather than let an agent believe the request was prepared the
			// way a Send prepares it.
			const caveat =
				composed.droppedPreRequestScripts > 0
					? `\n\nNote: ${composed.droppedPreRequestScripts} pre-request script(s) on this saved request were NOT applied - they are not marked to run inline, and this run's own elements.scripts is not "allInline", so anything they sign or rewrite is missing from the requests this run sends.`
					: "";

			// The composed payload holds every secret the run will send, so the
			// preview shows it as the run will record it (#1809).
			const shown = await withholdPlannedRequest(ctx, payload, signal);
			const summary = `Start a load test against ${shown.url} (${describeLoadShape(shape)})?`;

			const unconfirmed = await confirmDestructive(args, ctx, {
				message: `${summary}\n\nThis generates real traffic within Vayu's caps.`,
				acceptTitle: "Start the load test",
				acceptDescription: "Confirm to generate load now.",
				declined: "Load run not started - the user declined.",
				preview:
					"AWAITING CONFIRMATION - no run was started.\n\n" +
					`${summary}\n\n` +
					"This is a preview. To start the load test, call start_load_run again with confirmed: true and the same arguments.\n\n" +
					`Planned run:\n${JSON.stringify(shown, null, 2)}${caveat}`,
			});
			if (unconfirmed) return unconfirmed;

			// The engine's answer is read here rather than left to `callEngine`,
			// because the run id it carries is what the renderer attaches its stream
			// to (#1419) - a run has no id until this call returns.
			let started: unknown;
			try {
				started = await ctx.client.startRun(withMcpOrigin(payload, ctx), signal);
			} catch (err) {
				return engineErrorResult(err, ctx);
			}
			return watchedRun(
				withCaveat(startedRunResult(started, shape), caveat),
				"load",
				started
			);
		},
	},
];
