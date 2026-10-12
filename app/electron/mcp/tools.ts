/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file tools.ts
 * @brief The MCP tool registry. Each tool maps to engine capabilities, applies
 *        the safety guards (allowlist / caps / confirmation), and returns a
 *        result. Schemas are Zod (the SDK validates arguments and generates the
 *        JSON Schema for `tools/list`); tools carry MCP annotations (readOnly /
 *        destructive hints + a display title) and some declare an output schema
 *        for structured results. Transport-agnostic - the same registry backs
 *        both the Streamable HTTP server (Electron) and the stdio CLI.
 *
 * The helpers the definitions share live under `tools/` (#1918): `contract.ts`
 * holds the types, `kit.ts` the result, argument and gate helpers, and one file
 * per topic the rest. Imports run one way - nothing under `tools/` imports this
 * file - and `./tools.js` stays the registry's public surface, so what callers
 * import from it is re-exported here.
 */

import { z } from "zod";
import {
	DEFAULT_RUN_PAGE_LIMIT,
	EngineRequestError,
	MAX_ENGINE_PAGE_LIMIT,
} from "./engine-client.js";
import {
	checkAllowlist,
	checkLoadCaps,
	checkMonitorHost,
	defaultDurationUnderCap,
	type LoadRunParams,
} from "./safety.js";
import { compareReports } from "./compare.js";
import {
	type OriginScopes,
	precedenceNote,
	resolveVariableReports,
	VARIABLE_PRECEDENCE_SENTENCE,
	VARIABLE_RESOLUTION_URI,
} from "./variable-origins.js";
import { DATA_CONTRACT_SENTENCE, presentCollections } from "./collection-shape.js";
import { HTTP_VERSIONS } from "./http-versions.js";
import {
	MaskingIncompleteError,
	runOutputShape,
	secretsShape,
	WITHHELD_AUTH_SENTENCE,
	WITHHELD_CONFIG_SENTENCE,
	WITHHELD_COOKIE_SENTENCE,
	WITHHELD_DIAGNOSE_SENTENCE,
	WITHHELD_HEADER_SENTENCE,
	WITHHELD_MOCK_ACTIVITY_SENTENCE,
	WITHHELD_PLANNED_RUN_SENTENCE,
	WITHHELD_RUN_OUTPUT_SENTENCE,
	WITHHELD_SMOKE_ROW_URL_SENTENCE,
	WITHHELD_SPEC_DIFF_SENTENCE,
	WITHHELD_URL_SENTENCE,
	WITHHELD_VARIABLE_SENTENCE,
	withholdConfigCredentials,
	withholdCookieValues,
	withholdDiagnoseCredentials,
	withholdPlannedRequest,
	withholdReorderRows,
	withholdRequestUrl,
	withholdRowListSecrets,
	withholdRowSecrets,
	withholdSpecDiffChanges,
} from "./withhold.js";
import type { McpTool, McpToolInfo, ToolContext, ToolResult } from "./tools/contract.js";
import {
	callEngine,
	callEngineForRunOutput,
	collectionEchoShape,
	confirmDestructive,
	confirmedInput,
	echoShape,
	elementsArg,
	engineErrorResult,
	errorResult,
	isRecord,
	jsonResult,
	NOTHING_CHANGED,
	optionalOffset,
	optionalPageLimit,
	optionalPositiveInt,
	requireStr,
	STARTED_RUNS,
	str,
	stringArray,
	structuredResult,
	textResult,
	ToolArgError,
	unchanged,
	watchedRun,
	withCaveat,
	writesDisabled,
} from "./tools/kit.js";
import {
	boundExecuteResponse,
	boundRunReport,
	boundText,
	MAX_INLINE_BODY_BYTES,
	MAX_REPORT_TRACE_BYTES,
} from "./tools/inline-body-bounds.js";
import {
	DEFAULT_RUN_SAMPLE_LIMIT,
	DEFAULT_RUN_SERIES_LIMIT,
	describeInbox,
	describeRun,
	MAX_RUN_SERIES_LIMIT,
	pagedRead,
	resolveBaseline,
	RUN_STATUSES,
	RUN_TYPES,
	runListQuery,
} from "./tools/run-housekeeping.js";
import { fileRefInput, inlineFileInput, shapeBody } from "./tools/request-body.js";
import {
	absentRemovalCaveat,
	describeEnvironment,
	describeScopes,
	gatherVariableScopes,
	mergeVariables,
	readVariablesPatch,
	removalNames,
	removeVariablesInput,
	variablesInput,
} from "./tools/variable-blobs.js";
import {
	agentScriptGateSentence,
	applyDefaultHeaderOptOuts,
	applyRecordingKnobs,
	composeLoadRunRequest,
	composeViaEngine,
	DEFAULT_LOAD_MODE,
	MAX_IN_FLIGHT_BOUND,
	MAX_REDIRECTS_BOUND,
	MAX_SLOW_THRESHOLD_MS,
	MAX_SUCCESS_SAMPLE_PERIOD,
	readAuthArg,
	readRequestOverrides,
	readScriptEdits,
	readValidationScript,
	refuseAgentScripts,
	runStreamingRequest,
	scriptElement,
	upsertScriptElement,
	withMcpOrigin,
} from "./tools/compose.js";
import {
	applyRequestSettings,
	authInput,
	collectionIdInput,
	collectionScriptInput,
	dataRowInput,
	defaultHeaderOptOutsInput,
	elementSchema,
	elementsInput,
	elementsTimersInput,
	ENGINE_DEFAULT_HEADERS_SENTENCE,
	environmentIdInput,
	failOnSchemaErrorInput,
	INSECURE_TLS_REFUSAL,
	LOAD_RUN_SCHEMA_GATE_REFUSAL,
	maxStreamEventsInput,
	requestSettingsInput,
	scenarioDataInput,
	scenarioRecursiveInput,
	storedAuthInput,
	storedScriptInput,
	streamBudgetMsInput,
	streamInput,
	thresholdsInput,
	validationScriptAliasInput,
	validationScriptInput,
	verifySSLSendInput,
} from "./tools/input-schemas.js";
import {
	OAUTH2_INTERACTIVE_REFUSAL,
	oauth2CacheKeyInput,
	oauth2ConfigInput,
	projectOAuth2Status,
	projectOAuth2Token,
} from "./tools/oauth2.js";
import {
	childCollectionNames,
	configUpdateSchema,
	engineHealthSchema,
	isEngineHealthShape,
	isNetworkConfigKey,
	readSchemaVerdict,
	readTestVerdict,
	restartRequiredAmong,
	runComparisonSchema,
	smokeResultSchema,
	smokeRowUrl,
	smokeScopeCaveat,
} from "./tools/output-schemas.js";
import {
	preflightScenarioSteps,
	readScenarioArg,
	scenarioBlock,
	startScenarioLoadRun,
	toKeyValueEntries,
} from "./tools/scenario-runs.js";
import {
	type CascadeScope,
	collectionParent,
	collectionSubtree,
	describeCascade,
	readCascadeScope,
	readCollectionRows,
} from "./tools/cascade.js";
import {
	describeTrashEntry,
	readTrashEntry,
	trashRefusalMessage,
	type TrashRow,
} from "./tools/trash.js";
import {
	MOCK_ISSUER_FAILURE_MODES,
	mockIssuerPatchPayload,
	mockIssuerStartPayload,
} from "./tools/mock-issuer.js";
import { mockServerCaveat, mockServerStartPayload } from "./tools/mock-server.js";
import {
	boundInboxCaptures,
	DEFAULT_INBOX_CAPTURE_LIMIT,
	inboxResponsePayload,
	inboxStartPayload,
	MAX_INBOX_CAPTURE_LIMIT,
} from "./tools/webhook-inbox.js";
import {
	boundExampleBodies,
	describeExample,
	exampleWritePayload,
	MAX_EXAMPLES_BODY_BYTES,
} from "./tools/examples.js";
import { MOVE_POSITIONS, moveBatch, readOrderedSiblings } from "./tools/move.js";
import {
	asRecord,
	boundedBucket,
	boundSpecContent,
	changedEntry,
	CONNECTION_OUTCOME_HINTS,
	describeBind,
	describeBindPreview,
	describeImport,
	describeImportPreview,
	describeSpecDiff,
	describeSync,
	importDocumentInput,
	importPayload,
	MAX_SPEC_DIFF_ENTRIES,
	previewSpecBind,
	readSpecBinding,
	readSpecDiffAuth,
	type SpecBinding,
	summarizeImportTree,
} from "./tools/spec-bindings.js";

export type {
	ElicitParams,
	ElicitOutcome,
	ElicitFn,
	McpDataEntity,
	McpDataChangedEvent,
	StartedRun,
	ToolContext,
	ToolResult,
	ToolCategory,
	McpTool,
	McpToolInfo,
} from "./tools/contract.js";
export { MCP_DATA_ENTITIES } from "./tools/contract.js";
export { MAX_INLINE_BODY_BYTES, MAX_REPORT_TRACE_BYTES } from "./tools/inline-body-bounds.js";
export {
	DEFAULT_RUN_SAMPLE_LIMIT,
	DEFAULT_RUN_SERIES_LIMIT,
	MAX_RUN_SERIES_LIMIT,
	resolveBaseline,
} from "./tools/run-housekeeping.js";
export { INLINE_FILE_REFUSAL } from "./tools/request-body.js";
export {
	MAX_IN_FLIGHT_BOUND,
	MAX_SUCCESS_SAMPLE_PERIOD,
	MAX_SLOW_THRESHOLD_MS,
	MAX_REDIRECTS_BOUND,
} from "./tools/compose.js";
export {
	ENGINE_DEFAULT_HEADERS_SENTENCE,
	INSECURE_TLS_REFUSAL,
	elementSchema,
	REQUEST_SETTINGS_KEYS,
} from "./tools/input-schemas.js";
export { projectOAuth2Token, projectOAuth2Status } from "./tools/oauth2.js";
export { DEFAULT_INBOX_CAPTURE_LIMIT, MAX_INBOX_CAPTURE_LIMIT } from "./tools/webhook-inbox.js";
export { MAX_EXAMPLES_BODY_BYTES } from "./tools/examples.js";
export { MAX_SPEC_DIFF_ENTRIES } from "./tools/spec-bindings.js";

/**
 * The answer for a write tool the toggle withheld from registration, or null
 * when @p name is not one - a read/execute/load tool, a name no registry entry
 * carries, or a write tool in a session where writes are on.
 *
 * The same refusal the handlers return, because it is the same fact: the tool
 * exists, the user has not enabled writes, and enabling them is what unblocks
 * it. Without this the SDK answers an unregistered name with "Tool <name> not
 * found", which tells an agent nothing it can act on (issue #1431).
 *
 * A tool the *user* switched off is deliberately not covered: it is unregistered
 * for a different reason, and answering it here would tell a user who then
 * enabled writes to expect a tool that is still off.
 */
export function withheldWriteRefusal(name: string, ctx: ToolContext): ToolResult | null {
	if (ctx.config.allowWrites) return null;
	if (ctx.config.disabledTools.includes(name)) return null;
	const tool = findTool(name);
	if (!tool || tool.category !== "write") return null;
	return writesDisabled(ctx);
}

// --- Tool definitions --------------------------------------------------------

export const TOOLS: McpTool[] = [
	{
		name: "get_engine_health",
		category: "read",
		invalidates: [],
		description:
			'Check the Vayu engine\'s status and version. Use this first to confirm Vayu is running. Returns `status`, plus `version` when the engine reports one. An engine answering mid-restart may not return that shape at all; rather than failing, this reports `status: "unknown"` with the engine\'s raw body under `raw`, so a restarting engine reads as unknown rather than as a broken tool. An engine that is not running at all - port closed, nothing listening - comes back as a tool error instead, which is the difference between "starting up" and "not there".',
		annotations: {
			title: "Check engine health",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		outputSchema: engineHealthSchema,
		handler: async (_args, ctx, signal) => {
			try {
				const value = await ctx.client.health(signal);
				// Anything the outputSchema would reject is wrapped instead of
				// returned bare. A declared outputSchema makes the SDK reject a
				// non-error result whose `structuredContent` does not validate (and
				// one with none at all), and that rejection surfaces as "Tool
				// get_engine_health has an output schema but no structured content
				// was provided" - blaming the schema and swallowing the body an
				// operator needs to see. A mid-restart engine answering 200 with a
				// bare string or a `status`-less object is exactly when it matters.
				return isEngineHealthShape(value)
					? structuredResult(value)
					: structuredResult({ status: "unknown", raw: value ?? null });
			} catch (err) {
				return engineErrorResult(err);
			}
		},
	},
	{
		name: "list_collections",
		category: "read",
		invalidates: [],
		description:
			"List all request collections (folders that organize saved requests). Each row carries that collection's own `variables` blob and `auth` block; a request resolves against the whole chain from the root down, not just its own collection. " +
			DATA_CONTRACT_SENTENCE +
			" " +
			WITHHELD_VARIABLE_SENTENCE +
			" " +
			WITHHELD_AUTH_SENTENCE +
			" " +
			precedenceNote(
				"Collection variables sit between globals and the active environment, and a nested collection outranks its ancestors."
			),
		annotations: {
			title: "List collections",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		handler: (_args, ctx, signal) =>
			callEngine(
				() => ctx.client.listCollections(signal),
				(rows) => secretsShape(ctx, withholdRowListSecrets)(presentCollections(rows, ctx))
			),
	},
	{
		name: "list_requests",
		category: "read",
		invalidates: [],
		description:
			"List the saved requests directly inside one collection. Each row is the *whole* stored request - method, url, headers, body, auth and both scripts - not a summary, so a large collection returns a correspondingly large result and there is no separate call needed to read one request. The one exception is a stored column the engine cannot hand back: one that will not parse, or one past its 10 MB field cap, comes back as an empty value rather than failing the row. A sub-collection's requests are not included; list them by calling this again with the sub-collection id that list_collections returns. A stored request that cannot be serialized is omitted from the array rather than failing the call, so a short list is not proof the collection is small. " +
			WITHHELD_AUTH_SENTENCE +
			" " +
			WITHHELD_HEADER_SENTENCE +
			" " +
			WITHHELD_URL_SENTENCE,
		annotations: {
			title: "List requests",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: { collectionId: z.string().describe("Collection ID to list.") },
		handler: (args, ctx, signal) =>
			callEngine(
				() => ctx.client.listRequests(requireStr(args, "collectionId"), signal),
				secretsShape(ctx, withholdRowListSecrets)
			),
	},
	{
		name: "list_environments",
		category: "read",
		invalidates: [],
		description:
			"List all environments (named sets of variables like baseUrl, apiKey). The row with `isActive: true` is the one requests resolve against when a call names no environmentId. " +
			WITHHELD_VARIABLE_SENTENCE +
			" " +
			precedenceNote(
				"An environment's variables are the top scope tier: they shadow every collection and global of the same name."
			),
		annotations: {
			title: "List environments",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		handler: (_args, ctx, signal) =>
			callEngine(
				() => ctx.client.listEnvironments(signal),
				secretsShape(ctx, withholdRowListSecrets)
			),
	},
	{
		name: "list_runs",
		category: "read",
		invalidates: [],
		description:
			"List past runs (single Design-mode requests, collection runs and load tests), " +
			`newest first - the only order the engine lists in. Returns a {data, pagination} envelope of at most ${DEFAULT_RUN_PAGE_LIMIT} runs by default (${MAX_ENGINE_PAGE_LIMIT} max); each row carries a compact summary (requestName/url/method/mode/duration/concurrency/comment), not the full config snapshot. ` +
			"Filter to find a specific run instead of paging blocks of history: by saved request, by collection (collection runs only - a design or load run stores none), by type, by status, by text over the stored config, or to pinned baselines only. " +
			"`pagination.total` and `hasMore` describe the filtered set, so a filtered page says how much more of that filter there is. " +
			WITHHELD_RUN_OUTPUT_SENTENCE,
		annotations: {
			title: "List runs",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			limit: z
				.number()
				.int()
				.positive()
				.max(MAX_ENGINE_PAGE_LIMIT)
				.optional()
				.describe(
					`How many runs to return (default ${DEFAULT_RUN_PAGE_LIMIT}, max ${MAX_ENGINE_PAGE_LIMIT}). A larger value is refused, not clamped.`
				),
			offset: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe("How many runs to skip, for paging (default 0)."),
			type: z
				.enum(RUN_TYPES)
				.optional()
				.describe(
					'Only runs of this kind: "design" (one request), "load" (a load test), "scenario" (a collection run).'
				),
			status: z
				.enum(RUN_STATUSES)
				.optional()
				.describe(
					'Only runs in this state: "pending", "running", "completed", "failed", "stopped".'
				),
			requestId: z.string().optional().describe("Only runs of this saved request."),
			collectionId: z
				.string()
				.optional()
				.describe(
					"Only collection runs of this collection. Design and load runs record no collection, so they never match."
				),
			q: z
				.string()
				.optional()
				.describe(
					"Case-insensitive substring match over the run's stored configuration (url, comment, and the rest of the snapshot)."
				),
			baseline: z
				.boolean()
				.optional()
				.describe(
					"true lists only runs pinned as a baseline, false only unpinned ones. Omit for both."
				),
		},
		handler: async (args, ctx, signal) => {
			// Built before the call, not inside it: an argument the caller got
			// wrong must reach dispatch as a ToolArgError - inside `pagedRead`'s
			// try it would be reported as an engine failure.
			const query = runListQuery(args);
			return pagedRead(
				() => ctx.client.listRuns(query, signal),
				"runs",
				await runOutputShape(ctx, signal)
			);
		},
	},
	{
		name: "get_run_report",
		category: "read",
		invalidates: [],
		description:
			"Get the full report for a completed run: summary, latency percentiles (p50/p95/p99), status codes, errors, and timing breakdown. Ideal input for analyzing performance. " +
			"A run may also carry `warnings`: what it did not do, even though it finished and its numbers look fine - a request sent with an unresolved `{{token}}`, or a step whose pre-request script load mode never runs. Each entry carries `code`, a human-readable `message`, and either `count`/`names` or `steps`. Absent for a run with nothing to report. " +
			"A run of a collection bound to an OpenAPI document also carries `coverage`: which of the contract's operations the run exercised, which of their declared responses it saw, and any statuses the document never declared. Absent - never zeros - for a run that was not measured against a contract. " +
			`Stored bodies on each row's trace (request and response) are capped at ${MAX_INLINE_BODY_BYTES} bytes for this result: a capped one carries \`bodyTruncated: true\` beside \`bodyBytes\`, the full size, and a capped \`rawRequest\` carries \`rawRequestTruncated\`. A body in full is still available in the Vayu app's own run history. ` +
			`The traces together are capped at ${MAX_REPORT_TRACE_BYTES} bytes, since a multi-step run's rows add up past any per-body cap: rows beyond the budget keep every scalar (status, latency, step identity) and carry \`traceOmitted: true\` instead of their trace, with \`tracesOmitted\` and \`traceBudgetBytes\` on the report saying how many. Non-passing steps keep their traces first, matching the engine's own rule for \`stepsStored\`, so a failure is the last thing dropped. An omitted row's trace is still in the Vayu app's own run history. ` +
			WITHHELD_RUN_OUTPUT_SENTENCE,
		annotations: {
			title: "Get run report",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: { runId: z.string().describe("Run ID to fetch.") },
		handler: (args, ctx, signal) => {
			const runId = requireStr(args, "runId");
			return callEngineForRunOutput(ctx, () => ctx.client.getRunReport(runId, signal), {
				bound: boundRunReport,
				signal,
			});
		},
	},
	{
		name: "get_run_samples",
		category: "read",
		invalidates: [],
		description:
			"Get the response samples a load run captured - the actual headers and bodies of individual exchanges, which the report's aggregates do not carry. Only a run started with response capture on has any; a run that captured nothing returns an empty page, not an error. " +
			`Each sample carries \`resultId\`, so it joins against the report's \`results[].id\`. A binary body is reported as \`binary: true\` rather than as text, and a body the engine cut at its own capture cap carries \`bodyTruncated\`. BOUNDED: ${DEFAULT_RUN_SAMPLE_LIMIT} samples per call by default, ${MAX_ENGINE_PAGE_LIMIT} at most - a larger \`limit\` is refused, not clamped. \`pagination\` says how many exist; read the rest with \`offset\`. ` +
			WITHHELD_RUN_OUTPUT_SENTENCE,
		annotations: {
			title: "Get run samples",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			runId: z.string().describe("Run ID whose captured samples to read."),
			limit: z
				.number()
				.int()
				.positive()
				.max(MAX_ENGINE_PAGE_LIMIT)
				.optional()
				.describe(
					`How many samples to return (default ${DEFAULT_RUN_SAMPLE_LIMIT}, max ${MAX_ENGINE_PAGE_LIMIT}).`
				),
			offset: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe("How many samples to skip, for paging (default 0)."),
		},
		handler: async (args, ctx, signal) => {
			const runId = requireStr(args, "runId");
			const limit = optionalPageLimit(
				args,
				"limit",
				DEFAULT_RUN_SAMPLE_LIMIT,
				MAX_ENGINE_PAGE_LIMIT
			);
			const offset = optionalOffset(args, "offset");
			return pagedRead(
				() => ctx.client.getRunSamples(runId, limit, offset, signal),
				"captured samples",
				await runOutputShape(ctx, signal)
			);
		},
	},
	{
		name: "get_run_timeseries",
		category: "read",
		invalidates: [],
		description:
			"Get a completed run's per-tick time series: RPS, latency percentiles, error rate and status mix, one row per tick, oldest first. This is the stored history the app's charts are drawn from - use it to see how a run behaved over time, where get_run_report gives the totals and get_live_metrics the last few ticks of a run still going. A run with no ticks (a design run, or a load run that never started) returns an empty page, not an error. " +
			`BOUNDED: ${DEFAULT_RUN_SERIES_LIMIT} ticks per call by default, ${MAX_RUN_SERIES_LIMIT} at most - a larger \`limit\` is refused, not clamped, and the engine's own 5000-row default is far past what a tool result can carry. \`pagination\` says how many exist; read the rest with \`offset\`.`,
		annotations: {
			title: "Get run time series",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			runId: z.string().describe("Run ID whose time series to read."),
			limit: z
				.number()
				.int()
				.positive()
				.max(MAX_RUN_SERIES_LIMIT)
				.optional()
				.describe(
					`How many ticks to return (default ${DEFAULT_RUN_SERIES_LIMIT}, max ${MAX_RUN_SERIES_LIMIT}).`
				),
			offset: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe("How many ticks to skip, for paging (default 0)."),
		},
		handler: (args, ctx, signal) => {
			const runId = requireStr(args, "runId");
			const limit = optionalPageLimit(
				args,
				"limit",
				DEFAULT_RUN_SERIES_LIMIT,
				MAX_RUN_SERIES_LIMIT
			);
			const offset = optionalOffset(args, "offset");
			return pagedRead(
				() => ctx.client.getRunTimeSeries(runId, limit, offset, signal),
				"ticks"
			);
		},
	},
	{
		name: "get_run_monitor",
		category: "read",
		invalidates: [],
		description:
			"Get the server vitals scraped during a run - the target's own CPU, memory and load, sampled on the monitor's cadence rather than the tick cadence, so these rows do not line up with get_run_timeseries row for row. Answers 'was the target saturated?' beside the client-side latency the report shows. Only a run started with a `monitor` block has any; any other run returns an empty page, not an error. " +
			`BOUNDED the same way as get_run_timeseries: ${DEFAULT_RUN_SERIES_LIMIT} samples by default, ${MAX_RUN_SERIES_LIMIT} at most, refused above that. \`pagination\` says how many exist; read the rest with \`offset\`.`,
		annotations: {
			title: "Get run monitor series",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			runId: z.string().describe("Run ID whose monitor samples to read."),
			limit: z
				.number()
				.int()
				.positive()
				.max(MAX_RUN_SERIES_LIMIT)
				.optional()
				.describe(
					`How many samples to return (default ${DEFAULT_RUN_SERIES_LIMIT}, max ${MAX_RUN_SERIES_LIMIT}).`
				),
			offset: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe("How many samples to skip, for paging (default 0)."),
		},
		handler: (args, ctx, signal) => {
			const runId = requireStr(args, "runId");
			const limit = optionalPageLimit(
				args,
				"limit",
				DEFAULT_RUN_SERIES_LIMIT,
				MAX_RUN_SERIES_LIMIT
			);
			const offset = optionalOffset(args, "offset");
			return pagedRead(
				() => ctx.client.getRunMonitorSeries(runId, limit, offset, signal),
				"monitor samples"
			);
		},
	},
	{
		name: "get_engine_config",
		category: "read",
		invalidates: [],
		description:
			"Get the engine's tunable configuration entries (workers, timeouts, connection limits, buffer sizes, etc.), each with its current value, default, type, and allowed range. Read this before update_engine_config rather than assuming a key exists or what it accepts - the ranges here are what that call validates against. The values are what the engine has saved, which is not always what it is running: a key changed since the last restart reads as its new value here while the running engine still uses the old one. " +
			WITHHELD_CONFIG_SENTENCE,
		annotations: {
			title: "Get engine config",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		handler: (_args, ctx, signal) =>
			callEngine(
				() => ctx.client.getConfig(signal),
				secretsShape(ctx, withholdConfigCredentials)
			),
	},
	{
		name: "run_request",
		category: "execute",
		invalidates: ["run", "cookie", "variables"],
		description:
			"Send a single HTTP request through Vayu (Design mode) and return the response, timing, and any test results. The target host must be on Vayu's MCP allowlist. {{variables}} in the URL, headers, and body are resolved when an environmentId (and/or collectionId) is given, using the same precedence as the app. " +
			VARIABLE_PRECEDENCE_SENTENCE +
			` See ${VARIABLE_RESOLUTION_URI}.` +
			" Pass an `auth` block to have the engine apply bearer/basic/apikey/oauth2 auth. Pass a `preRequestScript` to sign or otherwise rewrite the request before it goes out - its pm.request edits are applied to what is actually sent. " +
			agentScriptGateSentence(
				"`preRequestScript`, `postRequestScript`, `tests`, or an `elements` entry of a `script.*` kind"
			) +
			" Extractors, assertions and timers in `elements` are not scripts and pass. With write access off, nothing a script or extractor sets is stored: the value is visible for the rest of this send and is not written to the environment, collection or globals. (To replay a saved request with its stored auth and scripts across a whole collection, use run_collection_smoke.) Certificate verification is always on for a send made this way - `verifySSL: false` is refused here, because a skipped check on a one-off call is recorded nowhere; it belongs on the saved request, where the app shows it. " +
			ENGINE_DEFAULT_HEADERS_SENTENCE +
			" " +
			`The response body is capped at ${MAX_INLINE_BODY_BYTES} bytes in this result: over that, \`bodyRaw\` holds the first ${MAX_INLINE_BODY_BYTES} bytes, \`bodyTruncated\` is true, \`bodySize\` is the real size, and the parsed \`body\` is null rather than a full copy of what was cut. A large \`rawRequest\` is capped the same way (headers kept whole) and flagged with \`rawRequestTruncated\`. \`bodyCapped\` is a different fact and is always present: it says the engine itself stopped reading the response at \`maxDesignResponseBodyBytes\`, so \`bodySize\` is the prefix it read and re-sending returns the same amount - raise that config entry to read more, where \`bodyTruncated\` is only this result showing less than the engine returned. ` +
			WITHHELD_RUN_OUTPUT_SENTENCE,
		annotations: {
			title: "Send a request",
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: true,
		},
		inputSchema: {
			method: z.string().optional().describe("HTTP method (default GET)."),
			url: z.string().describe("Request URL (may contain {{variables}})."),
			headers: z
				.record(z.string(), z.string())
				.optional()
				.describe("Request headers as a string map."),
			body: z.string().optional().describe("Request body content."),
			file: inlineFileInput,
			bodyType: z
				.string()
				.optional()
				.describe(
					'Body type: json, text, graphql, jsonrpc, xml, form-data, x-www-form-urlencoded (default text). For the two form types, write `body` as `key=value&key=value`; it is split into form fields. A body that sends a file (`binary`, or a form-data file part) cannot be sent from here - save it with create_request and run the saved request by id (start_load_run with `requestId`, or run_collection). For graphql, a bare query document is enveloped as `{"query": ...}` and sent as application/json; an envelope you write yourself is sent unchanged. That is the POST transport: with `method` GET the same document is sent as `query`/`operationName`/`variables` query parameters and no body, which is what GraphQL-over-HTTP defines GET to mean - so use POST for a mutation, and note that a GET is what a request gets by default. For jsonrpc, a bare call object gains `"jsonrpc":"2.0"` - plus `"id":1` when it names no id - and is sent as application/json; a frame already declaring a string `"jsonrpc"` is sent byte for byte, so write the frame yourself to choose your own id or to send a notification (no id). A top-level array is a batch call and is sent unchanged. An xml `body` is sent byte for byte as application/xml; a Content-Type you set yourself wins.'
				),
			auth: authInput,
			httpVersion: z
				.enum(HTTP_VERSIONS)
				.optional()
				.describe(
					'Protocol to negotiate: "auto" | "http1.1" | "http2" (default "auto"). Mirrors the request builder\'s Settings tab picker.'
				),
			verifySSL: verifySSLSendInput,
			requestId: z.string().optional().describe("Optional saved request ID to link."),
			environmentId: environmentIdInput,
			collectionId: collectionIdInput,
			data: dataRowInput,
			disabledDefaultHeaders: defaultHeaderOptOutsInput,
			preRequestScript: z
				.string()
				.optional()
				.describe(
					"JavaScript run before the request is sent. It may edit pm.request.url / .method / .headers / .body, and those edits are what gets sent - a script-set header overrides the engine-applied auth. The sandbox is synchronous and has no network: to sign a request use pm.crypto.sha256 / pm.crypto.hmacSha256 and the btoa / atob globals. Sent to the engine as an ad-hoc `script.pre` element (issue #1514 refuses the raw field). Read the `vayu://scripting/completions` resource for the full surface. Refused while Reveal secrets to agents is off."
				),
			postRequestScript: validationScriptInput,
			tests: validationScriptAliasInput,
			elements: z
				.array(elementSchema)
				.optional()
				.describe(
					"Ad-hoc elements (extractors, assertions, timers…) for this send only - not stored anywhere, and alongside any preRequestScript/postRequestScript given on the same call rather than replacing them. A `script.*` entry is a script, and is refused while Reveal secrets to agents is off. Read the `vayu://elements/kinds` resource for the catalogue."
				),
			stream: streamInput,
			maxStreamEvents: maxStreamEventsInput,
			streamBudgetMs: streamBudgetMsInput,
		},
		handler: async (args, ctx, signal) => {
			// Before anything is composed, let alone sent: a refusal that arrived
			// after the exchange would be a request already made insecurely. `true`
			// falls through - it restates the composed default (issue #795).
			if (args.verifySSL === false) return errorResult(INSECURE_TLS_REFUSAL);
			// The same posture for the same reason: a script is refused before the
			// compose that would carry it, not after an exchange that ran it (#1834).
			refuseAgentScripts(args, ctx.config.revealSecretsToAgents, elementsArg(args));
			const request: Record<string, unknown> = {
				...readRequestOverrides(args),
				url: requireStr(args, "url"),
			};
			if (request.method === undefined) request.method = "GET";
			/*
			 * The two ad-hoc scripts, as the `elements` entries `/execute` now
			 * takes: it refuses `preRequestScript` / `postRequestScript` / `tests`
			 * outright (issue #1514), and `/compose` copies an inline request's
			 * keys onto the payload verbatim, so sending the old names here would
			 * surface as a 400 from the send rather than from composition.
			 *
			 * The request's own scripts only, which is the scope this tool always
			 * had: composition is inline (no `requestId` reaches `/compose`, see
			 * below), so there is no stored row or collection chain to inherit
			 * elements from and nothing is being dropped by not walking one.
			 * Scripts ride through composition untouched - the engine never
			 * interpolates them. An ad-hoc `elements` argument (issue #1517) joins
			 * the same list, for a caller who wants more than a script.
			 */
			const elements: unknown[] = [];
			const preScript = str(args, "preRequestScript");
			if (preScript !== undefined) {
				elements.push(scriptElement("pre", preScript, "mcp-script-pre"));
			}
			const postScript = readValidationScript(args);
			if (postScript !== undefined) {
				elements.push(scriptElement("post", postScript, "mcp-script-post"));
			}
			elements.push(...(elementsArg(args) ?? []));
			if (elements.length > 0) request.elements = elements;
			const authArg = readAuthArg(args);
			if (authArg) request.auth = authArg;

			// Compose engine-side (pure), gate on the *resolved* URL, then execute
			// the composed payload. The gate is a host rule: a pre-request script
			// this call forwards can still edit `pm.request`, and since #1008 a
			// name compose could not answer is resolved before the send - neither
			// of which can reach a host the allowlist did not see, because an
			// unresolved authority is refused rather than checked (safety.ts).
			let payload: Record<string, unknown>;
			try {
				payload = await composeViaEngine(
					ctx.client,
					{
						request,
						collectionId: str(args, "collectionId"),
						environmentId: str(args, "environmentId"),
					},
					signal
				);
			} catch (err) {
				if (err instanceof ToolArgError) return errorResult(err.message);
				return engineErrorResult(err);
			}
			const gate = checkAllowlist(String(payload.url ?? ""), ctx.config);
			if (!gate.ok) return errorResult(gate.error!);
			// `requestId` here only links the run to a saved request for History;
			// it must not reach /compose, which would compose the *stored* row
			// instead of the arguments the agent actually gave.
			const linkId = str(args, "requestId");
			if (linkId !== undefined) payload.requestId = linkId;

			// Beside the composed payload, not through composition: `{{data.*}}`
			// survives `/compose` by design (`request_composer.hpp`), so the
			// tokens are still written when `/execute` binds them against this
			// row (issue #601). Absent means today's send, unchanged.
			const dataRow = args.data;
			if (dataRow !== undefined && dataRow !== null) payload.data = dataRow;

			// The same posture, and the same reason it is not composed: the names
			// say which of the engine's own defaults this send declines, which
			// composition neither reads nor rewrites (issue #1337).
			applyDefaultHeaderOptOuts(args, payload);

			// Stated on every call, never elided: the two answers have different
			// *shapes* - `202 {runId, eventsUrl}` against the exchange - so a
			// caller that let composition or an engine default decide would not
			// know which one it was about to parse. The same rule both app
			// clients follow for `followRedirects`.
			const streaming = args.stream === true;
			payload.stream = streaming;
			// Beside `stream` so both transports carry it: with write access off,
			// what a script or extractor sets stays within this send (#1904).
			if (!ctx.config.allowWrites) payload.persistVariables = false;
			if (!streaming) {
				return callEngineForRunOutput(
					ctx,
					() => ctx.client.executeRequest(withMcpOrigin(payload, ctx), signal),
					{ bound: boundExecuteResponse, signal, auth: payload.auth }
				);
			}
			return runStreamingRequest(args, payload, ctx, signal);
		},
	},
	{
		name: "update_engine_config",
		category: "write",
		invalidates: ["config"],
		description:
			"Update one or more engine configuration entries. GUARDED: requires write access to be enabled in Vayu Settings, and the network entries - every `proxy*` key and `customCaCertificates` - additionally require Network settings to be enabled there; a batch naming one without it is refused whole. Pass `entries` as a map of config key to new value; the engine validates types/ranges and rejects the whole batch on any invalid value. Some keys require an engine RESTART to take effect - the result lists those under `restartRequired`; they are saved but the running engine keeps the old value until the user restarts it (Vayu Settings → restart engine, or relaunch).",
		annotations: {
			title: "Update engine config",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			entries: z
				.record(z.string(), z.string())
				.describe('Map of config key to new value, e.g. { "workers": "8" }.'),
		},
		outputSchema: configUpdateSchema,
		handler: async (args, ctx, signal) => {
			if (!ctx.config.allowWrites) {
				return errorResult(
					"Config writes are disabled. Turn on write access in Vayu Settings → MCP to allow this."
				);
			}
			const entries = args.entries;
			if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
				return errorResult('"entries" must be an object mapping config keys to values.');
			}
			const network = Object.keys(entries).filter(isNetworkConfigKey);
			if (network.length > 0 && !ctx.config.allowNetworkSettings) {
				return errorResult(
					`Network settings are not open to agents: ${network.join(", ")} decide where every request goes and which certificate authorities Vayu trusts, so they need Network settings turned on in Vayu Settings → MCP as well as write access. Nothing was changed.`
				);
			}
			try {
				const updated = await ctx.client.updateConfig({ entries }, signal);
				const changedKeys = Object.keys(entries as Record<string, unknown>);
				// Best-effort: read back to flag restart-required keys. Failure here
				// must not fail the (already-applied) update.
				let restartRequired: string[] = [];
				try {
					const cfg = await ctx.client.getConfig(signal);
					restartRequired = restartRequiredAmong(cfg, changedKeys);
				} catch {
					/* leave restartRequired empty */
				}
				// The engine answers with the whole config table, so its echo is a
				// read like get_engine_config and withholds the same credentials.
				const result: Record<string, unknown> = {
					changedKeys,
					restartRequired,
					updated: secretsShape(ctx, withholdConfigCredentials)(updated),
				};
				if (restartRequired.length > 0) {
					const note =
						`Updated ${changedKeys.length} config key(s). ⚠ Restart required for: ` +
						`${restartRequired.join(", ")}. These are saved, but the running engine keeps ` +
						`the old values until it is restarted (Vayu Settings → restart engine, or relaunch the app).`;
					return {
						content: [
							{ type: "text", text: `${note}\n\n${JSON.stringify(result, null, 2)}` },
						],
						structuredContent: result,
					};
				}
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					structuredContent: result,
				};
			} catch (err) {
				return engineErrorResult(err);
			}
		},
	},
	{
		name: "create_collection",
		category: "write",
		invalidates: ["collection"],
		description:
			"Create a collection (the folder saved requests live in), with the variables, auth and elements (extractors, assertions, timers, scripts) every request inside it composes against. GUARDED: requires write access to be enabled in Vayu Settings. Pass `parentId` to nest it inside an existing collection; omit it for a top-level one. Returns the created collection - its `id` is what create_request takes as `collectionId`. " +
			precedenceNote(
				"Collection variables sit between globals and the active environment: they shadow globals, a nested collection shadows its ancestors, and the active environment shadows them all."
			) +
			" " +
			WITHHELD_VARIABLE_SENTENCE +
			" " +
			WITHHELD_AUTH_SENTENCE,
		annotations: {
			title: "Create collection",
			readOnlyHint: false,
			destructiveHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			name: z.string().describe("Display name for the collection."),
			parentId: z
				.string()
				.optional()
				.describe("Optional parent collection ID; omit for a top-level collection."),
			description: z.string().optional(),
			variables: variablesInput("the new collection"),
			auth: storedAuthInput(
				"this collection",
				'A collection is the root of an auth chain and never inherits, so "inherit" is refused by the engine; requests below it that store { mode: "inherit" } resolve to this block.'
			),
			elements: elementsInput("this collection"),
			preRequestScript: collectionScriptInput("pre"),
			postRequestScript: collectionScriptInput("post"),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const payload: Record<string, unknown> = { name: requireStr(args, "name") };
			const parentId = str(args, "parentId");
			if (parentId !== undefined) payload.parentId = parentId;
			const description = str(args, "description");
			if (description !== undefined) payload.description = description;
			const auth = readAuthArg(args);
			if (auth) payload.auth = auth;
			const patch = readVariablesPatch(args);
			// Merged against nothing, the way create_environment does it: on a
			// create every variable is new, which is what turns the string form
			// into a stored entry and enforces "a new variable carries a value".
			if (patch !== undefined)
				payload.variables = mergeVariables(
					{},
					patch,
					[],
					ctx.config.revealSecretsToAgents
				).variables;
			const elementsGiven = elementsArg(args);
			const scriptEdits = readScriptEdits(args);
			if (elementsGiven !== undefined && scriptEdits.length > 0) {
				return errorResult(
					'Pass "elements" or "preRequestScript"/"postRequestScript", not both - add a "script.pre"/"script.post" entry to "elements" directly instead.'
				);
			}
			if (elementsGiven !== undefined) {
				payload.elements = elementsGiven;
			} else {
				// Scripts are `elements` on the wire (issue #1514). Nothing is
				// stored yet on a create, so the list is built outright rather
				// than merged.
				const elements: Record<string, unknown>[] = [];
				for (const [which, script] of scriptEdits) {
					if (script !== "") elements.push(scriptElement(which, script));
				}
				if (elements.length > 0) payload.elements = elements;
			}
			return callEngine(
				() => ctx.client.createCollection(payload, signal),
				collectionEchoShape(ctx)
			);
		},
	},
	{
		name: "update_collection",
		category: "write",
		invalidates: ["collection"],
		description:
			"Change a collection: its name, description, variables, auth or elements (extractors, assertions, timers, scripts) - the state every request inside it composes against. GUARDED: requires write access to be enabled in Vayu Settings. Only the fields you pass change, and the requests inside it are never touched. Variables merge: one you do not name is left alone, and a named one keeps every flag you do not state; removeVariables deletes names outright. Auth and elements each replace the stored block/list whole. This is not a move - to re-parent a collection, use move_item. " +
			precedenceNote(
				"Collection variables sit between globals and the active environment: they shadow globals, a nested collection shadows its ancestors, and the active environment shadows them all."
			) +
			" " +
			WITHHELD_VARIABLE_SENTENCE +
			" " +
			WITHHELD_AUTH_SENTENCE,
		annotations: {
			title: "Update collection",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z.string().describe("Collection ID to update."),
			name: z.string().optional().describe("New display name."),
			description: z.string().optional().describe("New description."),
			variables: variablesInput("this collection"),
			removeVariables: removeVariablesInput("this collection"),
			auth: storedAuthInput(
				"this collection",
				'A collection never inherits - it is the root of the chain - so the engine refuses "inherit" here; { mode: "none" } is how a collection stops being an auth source.'
			),
			elements: elementsInput("this collection"),
			preRequestScript: collectionScriptInput("pre"),
			postRequestScript: collectionScriptInput("post"),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const collectionId = requireStr(args, "collectionId");
			// The engine merge-patches, so a body naming nothing would be a write
			// that changes nothing while reporting success. Say so instead.
			const payload: Record<string, unknown> = {};
			for (const field of ["name", "description"] as const) {
				const value = str(args, field);
				if (value !== undefined) payload[field] = value;
			}
			const scriptEdits = readScriptEdits(args);
			const auth = readAuthArg(args);
			if (auth) payload.auth = auth;
			const patch = readVariablesPatch(args);
			const removals = removalNames(args);
			const elementsGiven = elementsArg(args);
			if (elementsGiven !== undefined && scriptEdits.length > 0) {
				return errorResult(
					'Pass "elements" or "preRequestScript"/"postRequestScript", not both - add a "script.pre"/"script.post" entry to "elements" directly instead.'
				);
			}
			if (
				Object.keys(payload).length === 0 &&
				scriptEdits.length === 0 &&
				elementsGiven === undefined &&
				patch === undefined &&
				removals.length === 0
			) {
				return errorResult(
					'Pass at least one field to change ("name", "description", "variables", "removeVariables", "auth", "elements", "preRequestScript" or "postRequestScript").'
				);
			}
			let absentRemovals: string[] = [];
			// One read serves both merges. `PUT /collections/:id` replaces the
			// whole variables blob and the whole `elements` list rather than
			// patching inside either, so "change one of them" is a
			// read-merge-write here - without the read, an agent setting one
			// variable would drop every other one the collection holds, and
			// setting one script would drop every other element on it. An
			// explicit `elements` argument needs no read: it already states
			// the whole list.
			if (patch !== undefined || removals.length > 0 || scriptEdits.length > 0) {
				let existing: Record<string, unknown>;
				try {
					existing = ((await ctx.client.getCollection(collectionId, signal)) ??
						{}) as Record<string, unknown>;
				} catch (err) {
					return engineErrorResult(err);
				}
				if (patch !== undefined || removals.length > 0) {
					const merged = mergeVariables(
						existing.variables,
						patch,
						removals,
						ctx.config.revealSecretsToAgents
					);
					payload.variables = merged.variables;
					absentRemovals = merged.absentRemovals;
				}
				if (scriptEdits.length > 0) {
					let elements = existing.elements;
					for (const [which, script] of scriptEdits) {
						elements = upsertScriptElement(elements, which, script);
					}
					payload.elements = elements;
				}
			}
			if (elementsGiven !== undefined) {
				payload.elements = elementsGiven;
			}
			const result = await callEngine(
				() => ctx.client.updateCollection(collectionId, payload, signal),
				collectionEchoShape(ctx)
			);
			return result.isError
				? result
				: withCaveat(result, absentRemovalCaveat(absentRemovals));
		},
	},
	{
		name: "delete_collection",
		category: "write",
		invalidates: ["collection"],
		description:
			"Delete a collection AND EVERYTHING INSIDE IT - every nested sub-collection and every saved request in them. GUARDED: requires write access to be enabled in Vayu Settings, and confirmation: if the client supports elicitation the user is prompted with the number of sub-collections and requests this destroys; otherwise call once to see those counts, then again with `confirmed: true`. It goes to Vayu's Trash rather than disappearing outright - list_trash shows it there, and restore_trash_entry puts it back, until the retention window (`trashRetentionDays`, 30 days by default) runs out.",
		annotations: {
			title: "Delete collection",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z.string().describe("Collection ID to delete, with its whole subtree."),
			confirmed: confirmedInput("actually delete the collection and its contents"),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const collectionId = requireStr(args, "collectionId");
			// Read what the cascade takes before asking: an unreadable subtree is a
			// refusal, never a prompt carrying counts nobody verified.
			let scope: CascadeScope;
			try {
				scope = await readCascadeScope(ctx.client, collectionId, signal);
			} catch (err) {
				if (err instanceof ToolArgError) return errorResult(err.message);
				return engineErrorResult(err);
			}
			const cascade = describeCascade(scope);
			const unconfirmed = await confirmDestructive(args, ctx, {
				message: `Delete the collection "${scope.name}"?\n\n${cascade}`,
				acceptTitle: "Delete the collection",
				acceptDescription: "Confirm to delete it and everything inside it.",
				declined: "Collection not deleted - the user declined.",
				preview:
					"AWAITING CONFIRMATION - nothing was deleted.\n\n" +
					`${cascade}\n\n` +
					"This is a preview. To delete it, call delete_collection again with confirmed: true and the same arguments.",
			});
			if (unconfirmed) return unconfirmed;
			const result = await callEngine(() =>
				ctx.client.deleteCollection(collectionId, signal)
			);
			// The counts describe what was destroyed, so they belong only on a
			// delete that happened - a refusal wearing them would read as one.
			return result.isError
				? result
				: withCaveat(
						result,
						`\n\nDeleted "${scope.name}" with ${scope.descendants} sub-collection(s) and ${scope.requests} saved request(s).`
					);
		},
	},
	{
		name: "get_spec",
		category: "read",
		invalidates: [],
		description:
			"Read the OpenAPI document a collection is bound to - where it came from, when it was fetched, its content hash and its size - by `collectionId` (resolving the collection's binding) or by `specId` directly. The document text is NOT included by default: a real spec runs to megabytes, so pass includeContent: true to get it, capped at 32 KB with `contentBytes` reporting the true size. A collection that binds nothing answers `bound: false` rather than failing.",
		annotations: {
			title: "Get bound OpenAPI spec",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z
				.string()
				.optional()
				.describe("Collection whose binding to resolve. Pass this or specId, not both."),
			specId: z
				.string()
				.optional()
				.describe(
					"Stored document to read directly. Spec IDs come from a collection's binding - there is no list route for them."
				),
			includeContent: z
				.boolean()
				.optional()
				.describe(
					"Include the document text (capped at 32 KB). Off by default - the metadata is what describes a binding, and the text can be megabytes."
				),
		},
		handler: async (args, ctx, signal) => {
			const collectionId = str(args, "collectionId");
			const specIdArg = str(args, "specId");
			if (collectionId && specIdArg) {
				return errorResult(
					'Pass either "collectionId" or "specId", not both - they would have to agree, and this tool cannot say which one you meant if they do not.'
				);
			}
			const includeContent = args.includeContent === true;

			// Assigned on the first two arms below - by the binding the collection
			// resolves to, or by the argument - so it is a string by the time it is
			// read. The "neither was passed" case is the third arm rather than a
			// guard above it: as a guard, proving the `else` still holds an id is a
			// step across two conditions that `strict` control flow does not make in
			// either compiler, and the assertion it would take is the kind that stops
			// being true when someone edits the guard.
			let specId: string;
			let binding: SpecBinding | null = null;
			if (collectionId) {
				let collection: unknown;
				try {
					collection = await ctx.client.getCollection(collectionId, signal);
				} catch (err) {
					return engineErrorResult(err);
				}
				if (collection === null) {
					return errorResult(`No collection with id "${collectionId}".`);
				}
				binding = readSpecBinding(collection);
				// Unbound is an answer, not a failure: "which spec does this
				// collection use" has "none" as a legitimate reply, and an error
				// here would read as an engine or id problem.
				if (!binding) {
					return withCaveat(
						jsonResult({ collectionId, bound: false }),
						"\n\nThis collection is not bound to an OpenAPI document. Bind one with `bind_spec` (call `preview_spec_bind` first to see what it would change)."
					);
				}
				specId = binding.specId;
			} else if (specIdArg) {
				specId = specIdArg;
			} else {
				return errorResult('Pass either "collectionId" or "specId".');
			}

			try {
				// The metadata route unless the text was asked for: it is the whole
				// point of `GET /specs/:id/meta` that describing a document does not
				// transfer it, and the full read carries the two extracted indexes
				// as well, which are as heavy as the document itself.
				const document = includeContent
					? await ctx.client.getSpec(specId, signal)
					: await ctx.client.getSpecMeta(specId, signal);
				const meta = isRecord(document) ? document : {};
				const value: Record<string, unknown> = {
					specId,
					sourceUrl: meta.sourceUrl ?? null,
					fetchedAt: meta.fetchedAt ?? null,
					hash: meta.hash ?? null,
					// `contentBytes` is only on the meta read; the full read carries
					// the bytes themselves, so measure them the same way the engine
					// does (`content.size()`) rather than reporting nothing.
					contentBytes:
						typeof meta.contentBytes === "number"
							? meta.contentBytes
							: typeof meta.content === "string"
								? Buffer.byteLength(meta.content, "utf8")
								: null,
					...(binding ? { collectionId, bound: true, binding } : {}),
					...(includeContent ? boundSpecContent(meta) : {}),
				};
				return jsonResult(value);
			} catch (err) {
				return engineErrorResult(err);
			}
		},
	},
	{
		name: "diff_spec",
		category: "read",
		invalidates: [],
		description:
			"Check whether an OpenAPI contract has drifted from the collection bound to it, and where. Pass the collection and the re-fetched document text; the engine compares it against the document the collection is currently bound to AND against every request in its subtree, and answers which operations the document adds, which requests it no longer declares, and which requests changed field by field with the current and next value of each. Reads only: nothing is stored, no binding moves, no request is stamped, so it is safe to ask about a document you have not decided to apply. `identical` is decided on the stored bytes and is the 'already up to date' answer. A field flagged `userTouched` is one somebody edited by hand rather than one the last import wrote - applying the document there would overwrite a person's work. `unmapped` counts requests carrying no operation identity at all, which no comparison covers. This tool is the read half: `sync_spec` applies the safe half of a drift. " +
			WITHHELD_SPEC_DIFF_SENTENCE,
		annotations: {
			title: "Diff OpenAPI spec against collection",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z
				.string()
				.describe(
					"Collection to compare. It must already be bound to a document - the comparison is three-way and the bound document is the middle term. Its whole subtree is read, since an imported spec files its requests under one sub-collection per tag."
				),
			content: z
				.string()
				.describe(
					"The re-fetched OpenAPI document text, JSON or YAML. Not stored - this is the candidate, compared against the bytes the collection is bound to. Capped by the maxSpecDocumentBytes setting, the same cap a bind applies."
				),
		},
		handler: async (args, ctx, signal) => {
			const collectionId = requireStr(args, "collectionId");
			const content = requireStr(args, "content");
			// The requests and the bound document are deliberately not sent: the
			// engine walks the subtree and reads the binding itself, so a caller
			// cannot make its own stale copy the "previous" side of a three-way
			// comparison. Nothing is worked out here for the same reason
			// `bind_spec` works nothing out - the comparison is the engine's
			// (`core::diff_spec`), off the bytes handed to it.
			let answer: unknown;
			try {
				answer = await ctx.client.diffSpec({ collectionId, spec: { content } }, signal);
			} catch (err) {
				// The engine's own sentence is the useful one: a 400 names the
				// collection that binds nothing and says to bind it first, a 404
				// names the collection, and a 409 names the binding whose document
				// the store no longer holds.
				return engineErrorResult(err);
			}
			const diff = asRecord(answer);
			const added = boundedBucket(diff.added, (entry) => ({
				operation: entry.operation ?? null,
				folder: entry.folder ?? null,
			}));
			const removed = boundedBucket(diff.removed, (entry) => ({
				requestId: entry.requestId ?? null,
				name: entry.name ?? null,
				operation: entry.operation ?? null,
			}));
			const changed = boundedBucket(diff.changed, changedEntry);
			const storedAuth = await readSpecDiffAuth(ctx, changed.entries, signal);
			const truncated = [added, removed, changed].some(
				(bucket) => bucket.entries.length < bucket.total
			);
			return withCaveat(
				jsonResult({
					collectionId,
					identical: diff.identical === true,
					// The engine's totals, not these lists' lengths - see
					// `MAX_SPEC_DIFF_ENTRIES` for why the two can differ.
					summary: {
						added: added.total,
						removed: removed.total,
						changed: changed.total,
						unchanged: typeof diff.unchanged === "number" ? diff.unchanged : 0,
						unmapped: typeof diff.unmapped === "number" ? diff.unmapped : 0,
					},
					added: added.entries,
					removed: removed.entries,
					changed: secretsShape(ctx, (entries) =>
						withholdSpecDiffChanges(entries, storedAuth)
					)(changed.entries),
					entriesTruncated: truncated,
				}),
				`\n\n${describeSpecDiff(diff)}${
					truncated
						? ` Each list here is capped at ${MAX_SPEC_DIFF_ENTRIES} entries; the counts in \`summary\` are the true totals.`
						: ""
				}`
			);
		},
	},
	{
		name: "sync_spec",
		category: "write",
		// The same set a bind uses, and for the same reason: the document and the
		// binding live on the collection row, and the requests this creates,
		// updates and deletes live beneath it. A sync moves both at once, so
		// declaring one would leave an open request list showing rows this call
		// has already rewritten.
		invalidates: ["collection", "request"],
		description:
			"Apply a drifted OpenAPI contract to the collection bound to it - the safe half of it. GUARDED: requires write access to be enabled in Vayu Settings. Pass the collection and the re-fetched document text; the engine stores the document, moves the binding to it, and creates, updates and deletes requests in ONE transaction - nothing lands unless all of it does. WHAT IT WRITES IS NOT YOURS TO CHOOSE, deliberately: this sends `policy: \"safe\"` and the engine decides, which means every operation the document adds becomes a request, every field the document moved that nobody had edited by hand is written, and NOTHING IS DELETED and NO HAND-EDITED FIELD IS OVERWRITTEN. A request whose bound document could not be read is left alone whole, since there nobody's edit can be told from the document's change. `skipped` reports what that left: requests untouched, fields not written, deletions not made. Use `diff_spec` first to see the drift and which of it is marked safe - it is the same answer this applies. To apply anything the policy declines - a deletion, or a field somebody edited - use the Vayu app (Collection -> Spec -> Sync), where a person can tick it.",
		annotations: {
			title: "Apply OpenAPI spec drift",
			readOnlyHint: false,
			// Nothing a person authored is written: the policy skips every
			// hand-edited field, deletes nothing, and leaves a request it cannot
			// reason about alone. What it does write is what the last import
			// wrote and the document has since moved - which is the document's,
			// not the user's. That is precisely what makes the safe half of a
			// sync the half an agent may have.
			destructiveHint: false,
			// The engine mints a new `spec_documents` row per call, as a bind
			// does, so syncing the same bytes twice is not the same call twice.
			idempotentHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z
				.string()
				.describe(
					"Collection to sync. It must already be bound to a document - a sync moves a binding forward and binding is `bind_spec`. Its whole subtree is written, since an imported spec files its requests under one sub-collection per tag."
				),
			content: z
				.string()
				.describe(
					"The re-fetched OpenAPI document text, JSON or YAML. Stored verbatim and the binding moves to it, even when no request row changes - catching a collection up to a document that only reworded its description is a real sync. Capped by the maxSpecDocumentBytes setting."
				),
			sourceUrl: z
				.string()
				.optional()
				.describe(
					"Where the document was re-fetched from, if it came from a URL. Recorded on the document so the next sync knows what to re-fetch; omit it for one you were handed as text."
				),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const collectionId = requireStr(args, "collectionId");
			const content = requireStr(args, "content");
			const sourceUrl = str(args, "sourceUrl");
			// `policy` rather than rows, and no argument offering an alternative:
			// which of a drift is safe to write is `core::safe_spec_apply`, the
			// same function whose answer `diff_spec` reports per entry. A tool
			// that let an agent name rows would be a second opinion about which
			// of a person's fields a sync may overwrite - the one judgement this
			// side must never make (issue #871).
			let outcome: unknown;
			try {
				outcome = await ctx.client.syncSpec(
					{
						collectionId,
						spec: { content, ...(sourceUrl ? { sourceUrl } : {}) },
						policy: "safe",
					},
					signal
				);
			} catch (err) {
				// The engine's own sentence: a 400 names the collection that binds
				// nothing and says to bind it first, a 404 names the collection,
				// and a 409 says a row the comparison was made against has since
				// gone - which is a re-check, not a bad request.
				return engineErrorResult(err);
			}
			return withCaveat(jsonResult(outcome), `\n\n${describeSync(outcome)}`);
		},
	},
	{
		name: "preview_import",
		category: "read",
		invalidates: [],
		description:
			"Read a collection, environment or API spec document the way import_document would, and store nothing: the collections it would create (names, folder and request counts), the environments, the number of globals, and `meta` - the format, the counts, and `meta.skipped`, what the document declares that Vayu cannot carry, each with the requests it applies to. Takes exactly import_document's arguments, so preview first, show the user what would be left out, then import. Available with writes off.",
		annotations: {
			title: "Preview an import",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: importDocumentInput,
		handler: async (args, ctx, signal) => {
			const payload = importPayload(args);
			let summary: Record<string, unknown>;
			try {
				summary = summarizeImportTree(await ctx.client.parseImport(payload, signal));
			} catch (err) {
				return engineErrorResult(err);
			}
			return withCaveat(jsonResult(summary), `\n\n${describeImportPreview(summary)}`);
		},
	},
	{
		name: "import_document",
		category: "write",
		// All three families: a Postman collection creates collections and
		// requests, an environment export creates an environment, and a globals
		// export rewrites the global scope. Which of them a given document
		// touches is not knowable until it has been read, and an entity left out
		// would leave an open list showing a tree the import has already changed.
		invalidates: ["collection", "request", "environment"],
		description:
			"Import a collection, environment or API spec from its document text. GUARDED: requires write access to be enabled in Vayu Settings. Every format Vayu accepts is read by the engine: OpenAPI 3.x and 2.0 (JSON or YAML), Postman Collection v2.1 and v2.0, a Postman environment or globals export, and an Insomnia v4 export - detection is by content, so you do not say which one it is. The whole tree lands in one transaction: a document that is refused creates nothing. An OpenAPI document is stored and the collection is bound to it, so its runs report contract coverage and its responses are schema-checked straight away, and its operations are filed under one sub-collection per tag. The result reports what was created plus `meta`, which names the format, the counts, and - in `meta.skipped` - everything the document declared that Vayu cannot represent, so a lossy import says so rather than looking complete. A Postman globals export MERGES into the existing global scope, imported values winning on a collision; nothing else here overwrites anything. Call preview_import first with the same arguments to see what would be created and what would be left out, without storing anything.",
		annotations: {
			title: "Import a document",
			readOnlyHint: false,
			// Nothing existing is removed: an import only creates. The one write
			// that touches prior state is the globals merge, which adds and
			// overwrites by key and deletes nothing.
			destructiveHint: false,
			// Two imports of one document are two collections, not one.
			idempotentHint: false,
			openWorldHint: false,
		},
		inputSchema: importDocumentInput,
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const payload = importPayload(args);
			let outcome: unknown;
			try {
				outcome = await ctx.client.importDocument(payload, signal);
			} catch (err) {
				// The engine's own sentence: "Unrecognised format" for a file no
				// format claims, a read failure naming the line for one that is
				// broken, and the cap by name for one that is too large.
				return engineErrorResult(err);
			}
			return withCaveat(jsonResult(outcome), `\n\n${describeImport(outcome)}`);
		},
	},
	{
		name: "preview_spec_bind",
		category: "read",
		invalidates: [],
		description:
			"Say what bind_spec would do with a document, and store nothing: how many of the collection's requests it would record an operation on, which requests would LOSE the operation they carry today because this document does not declare it (`wouldClear`), which requests match no operation, and which operations match no request. Uses the engine's own reader and matching rule, the ones bind_spec uses, over the collection's whole subtree. Lists are capped at " +
			MAX_SPEC_DIFF_ENTRIES +
			" entries; each `count` is the true total. Available with writes off.",
		annotations: {
			title: "Preview an OpenAPI bind",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z
				.string()
				.describe(
					"Collection to preview binding. Its whole subtree is matched, as bind_spec does."
				),
			content: z
				.string()
				.describe(
					"The OpenAPI document text, JSON or YAML. Capped by the maxSpecDocumentBytes setting, as bind_spec is."
				),
		},
		handler: async (args, ctx, signal) => {
			const collectionId = requireStr(args, "collectionId");
			const content = requireStr(args, "content");
			let preview: Record<string, unknown>;
			try {
				preview = await previewSpecBind(ctx.client, collectionId, content, signal);
			} catch (err) {
				return engineErrorResult(err);
			}
			return withCaveat(jsonResult(preview), `\n\n${describeBindPreview(preview)}`);
		},
	},
	{
		name: "bind_spec",
		category: "write",
		// Both families: the binding lives on the collection row, and the stamps
		// this writes and clears live on the requests beneath it. Declaring only
		// the collection would leave an open request list showing identity a bind
		// has already removed. No `spec` family - the stored document is
		// immutable under its id, and this creates a new one rather than
		// changing any cached row.
		invalidates: ["collection", "request"],
		description:
			"Bind a collection to an OpenAPI document, so its runs report contract coverage and its responses are schema-checked. GUARDED: requires write access to be enabled in Vayu Settings. Pass the document text (JSON or YAML) - the engine stores it, works out which of the collection's requests is which operation by method and path shape, and records that identity, all in one transaction: nothing is created or deleted, and a bind that fails writes nothing at all. RE-BINDING REPLACES THE CONTRACT: any request whose identity the new document does not account for has it cleared, because a stamp naming an operation of a document this collection is no longer bound to would be read as identity rather than as a gap. The result reports how many requests were stamped and how many cleared, plus the requests and operations nothing paired with. Call preview_spec_bind first to see which requests would gain an operation and which would lose the one they carry, without storing anything.",
		annotations: {
			title: "Bind OpenAPI spec",
			readOnlyHint: false,
			// Nothing a user authored is lost: no request is created or deleted,
			// the only field written is the identity a bind exists to record, and
			// the document a collection was bound to before is still stored while
			// anything else binds it. A re-bind is undone by binding the previous
			// document again.
			destructiveHint: false,
			// The engine mints a new `spec_documents` row per call, so binding the
			// same bytes twice is not the same call twice.
			idempotentHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z
				.string()
				.describe(
					"Collection to bind. Its whole subtree is matched - an imported spec files its requests under one sub-collection per tag."
				),
			content: z
				.string()
				.describe(
					"The OpenAPI document text, JSON or YAML, stored verbatim. Capped by the maxSpecDocumentBytes setting."
				),
			sourceUrl: z
				.string()
				.optional()
				.describe(
					"Where the document came from, if it came from a URL. Recorded on the document so a later sync knows what to re-fetch; omit it for a document you were handed as text."
				),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const collectionId = requireStr(args, "collectionId");
			const content = requireStr(args, "content");
			const sourceUrl = str(args, "sourceUrl");
			// The document and the collection, and nothing worked out here: the
			// pairing is the engine's (`core::match_operations`), read off the
			// bytes it is about to store. An agent has no OpenAPI reader, and one
			// written here would be the second opinion about what a document
			// declares that #761's phase B moved the reader engine-side to end.
			let outcome: unknown;
			try {
				outcome = await ctx.client.bindSpec(
					{ collectionId, spec: { content, ...(sourceUrl ? { sourceUrl } : {}) } },
					signal
				);
			} catch (err) {
				return engineErrorResult(err);
			}
			return withCaveat(jsonResult(outcome), `\n\n${describeBind(outcome)}`);
		},
	},
	{
		name: "export_spec",
		category: "read",
		invalidates: [],
		description:
			"Export a collection as an OpenAPI document - its own bound document updated, or a skeleton describing its requests when it binds none. Reads only: nothing is stored, and the collection is left exactly as it is. A bound export patches the stored document, so everything Vayu does not model (vendor extensions, security schemes, unreferenced components) survives and operations no request claims are removed; a skeleton is a starting point rather than a contract, with no schema Vayu did not read off a stored example body. A bound export keeps the contract by default (examples and parameter values only); `mode` set to `full` writes every edit the collection holds into the document instead - names, new rows, bodies, auth, and new operations for requests the document never declared. Everything OpenAPI has no member for (folders, scripts, settings, variables) travels as `x-vayu-*` extensions Vayu reads back, and credentials are always written empty - auth secrets, variables marked secret, and by name the header, parameter and URL values and a saved example's response headers; bodies, examples and scripts are not judged and are written as stored. `notes` says what the export could not carry - a request with no operation identity, an example whose media type nobody recorded, how many credentials it left out (`secretsOmitted`) - and the document text is capped at 32 KB with `contentBytes` reporting the true size, so a large spec comes back described rather than whole.",
		annotations: {
			title: "Export collection as OpenAPI",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z
				.string()
				.describe(
					"Collection to export. Its whole subtree is read - an OpenAPI import files requests under one sub-collection per tag - stopping at any collection bound to a different document."
				),
			format: z
				.enum(["json", "yaml"])
				.optional()
				.describe('Serialization to write. Defaults to "json".'),
			mode: z
				.enum(["contract", "full"])
				.optional()
				.describe(
					'What a bound export may write. "contract" (default) keeps the stored document as the contract and writes only examples and parameter values; "full" writes every edit the collection holds. Ignored for a collection bound to no document.'
				),
		},
		handler: async (args, ctx, signal) => {
			const collectionId = requireStr(args, "collectionId");
			const format = str(args, "format") || "json";
			const mode = str(args, "mode") || "contract";
			let exported: unknown;
			try {
				exported = await ctx.client.exportSpec(collectionId, format, mode, signal);
			} catch (err) {
				// The engine's own sentence, which is the useful one here: a 404
				// names the collection, and a 409 names the binding whose document
				// it could not read and says unbinding would export a skeleton.
				return engineErrorResult(err);
			}
			const answer = isRecord(exported) ? exported : {};
			const text = typeof answer.text === "string" ? answer.text : "";
			const { text: bounded, truncated } = boundText(text);
			return jsonResult({
				collectionId,
				format,
				mode,
				fileName: answer.fileName ?? null,
				notes: answer.notes ?? null,
				document: bounded,
				documentTruncated: truncated,
				contentBytes: Buffer.byteLength(text, "utf8"),
			});
		},
	},
	{
		name: "export_postman",
		category: "read",
		invalidates: [],
		description:
			"Export a collection as a Postman Collection v2.1 document - its folders, requests, variables, auth and scripts, in the JSON Postman imports. Reads only: nothing is stored, and the collection is left exactly as it is. Credentials are always written empty here - auth secrets, variables marked secret, and by name the header, parameter and URL values, a saved example's recorded request and response headers, and cookie values - and `notes.secretsOmitted` counts them; bodies and scripts are not judged and are written as stored; the app's export dialog is where a person can choose to include them. `notes` also lists what Postman has no place for (`notCarried`, one entry per kind with a count and the engine's sentence), so nothing is dropped without saying so. The document text is capped at 32 KB, with `contentBytes` reporting the true size.",
		annotations: {
			title: "Export collection as Postman",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z
				.string()
				.describe("Collection to export. Its whole subtree is read, folders included."),
		},
		handler: async (args, ctx, signal) => {
			const collectionId = requireStr(args, "collectionId");
			let exported: unknown;
			try {
				// No `includeSecrets` argument: a tool result is text an agent may
				// quote or paste anywhere, and a person choosing to hand over
				// credentials is a choice the dialog asks for, not one an agent
				// makes for them.
				exported = await ctx.client.exportPostman(collectionId, signal);
			} catch (err) {
				return engineErrorResult(err);
			}
			const answer = isRecord(exported) ? exported : {};
			const text = typeof answer.text === "string" ? answer.text : "";
			const { text: bounded, truncated } = boundText(text);
			return jsonResult({
				collectionId,
				fileName: answer.fileName ?? null,
				notes: answer.notes ?? null,
				document: bounded,
				documentTruncated: truncated,
				contentBytes: Buffer.byteLength(text, "utf8"),
			});
		},
	},
	{
		name: "unbind_spec",
		category: "write",
		invalidates: ["collection"],
		description:
			"Detach a collection from the OpenAPI document it is bound to. GUARDED: requires write access to be enabled in Vayu Settings. The document itself is kept - other collections may bind it - and the requests keep the operation identities they were stamped with, exactly as the app's Unbind button leaves them, so re-binding the same document later costs nothing. After this the collection's runs report no contract coverage and its responses are no longer schema-checked. Re-binding is `bind_spec`, which restores this state exactly if you hand it the same document." +
			" " +
			WITHHELD_VARIABLE_SENTENCE +
			" " +
			WITHHELD_AUTH_SENTENCE,
		annotations: {
			title: "Unbind OpenAPI spec",
			readOnlyHint: false,
			// The binding goes, nothing it named does: the document stays stored and
			// the stamps stay on the requests, and a re-bind in the app restores the
			// state this leaves. That is not the irreversible loss the hint marks.
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z.string().describe("Collection to unbind from its OpenAPI document."),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const collectionId = requireStr(args, "collectionId");
			let collection: unknown;
			try {
				collection = await ctx.client.getCollection(collectionId, signal);
			} catch (err) {
				return engineErrorResult(err);
			}
			if (collection === null) {
				return errorResult(`No collection with id "${collectionId}".`);
			}
			const binding = readSpecBinding(collection);
			// Read first so an unbound collection is reported as already unbound
			// rather than written to. The PUT would succeed either way - the engine
			// reads `null` as "reset to the default", and the default is unbound -
			// and an agent told "unbound" about a collection that was never bound
			// would believe it had changed something.
			if (!binding) {
				return withCaveat(
					jsonResult({ collectionId, bound: false }),
					"\n\nNothing to do: this collection was not bound to an OpenAPI document."
				);
			}
			// `null`, not `{}`: the engine reads an absent field as "keep" and null
			// as "reset to the default", which is unbound. The same value the Spec
			// tab's Unbind sends, so the two paths cannot come to mean different
			// things.
			const result = await callEngine(
				() => ctx.client.updateCollection(collectionId, { openapi: null }, signal),
				collectionEchoShape(ctx)
			);
			return result.isError
				? result
				: withCaveat(
						result,
						`\n\nUnbound from spec ${binding.specId}. The document is still stored (another collection may bind it), and the requests keep their recorded operation identities.`
					);
		},
	},
	{
		name: "create_request",
		category: "write",
		invalidates: ["request"],
		description:
			'Create a saved request inside a collection (stores it; does not send it), with its auth, redirect policy, protocol, stream flag, certificate-verification setting and its elements (extractors, assertions, timers, scripts) - everything the app\'s builder stores except form-data file parts. GUARDED: requires write access to be enabled in Vayu Settings. The URL may contain {{variables}} since it is only saved, not executed, and a stored element runs only when the request is later sent. Auth is stored as written and resolved at send time, so {{variables}} inside it are fine; leaving `auth` out stores the default "inherit", which resolves against the collection chain.' +
			" " +
			WITHHELD_AUTH_SENTENCE +
			" " +
			WITHHELD_HEADER_SENTENCE +
			" " +
			WITHHELD_URL_SENTENCE,
		annotations: {
			title: "Create saved request",
			readOnlyHint: false,
			destructiveHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z.string().describe("Collection to add the request to."),
			name: z.string().describe("Display name for the saved request."),
			url: z.string().describe("Request URL (may contain {{variables}})."),
			method: z.string().optional().describe("HTTP method (default GET)."),
			headers: z
				.record(z.string(), z.string())
				.optional()
				.describe("Headers as a string map."),
			body: z.string().optional().describe("Request body content."),
			file: fileRefInput,
			bodyType: z
				.string()
				.optional()
				.describe(
					'Body type: json, text, graphql, jsonrpc, xml, form-data, x-www-form-urlencoded, binary (default text). For the two form types, write `body` as `key=value&key=value`; it is split into form fields. A jsonrpc `body` may be the bare call object - the engine adds `"jsonrpc":"2.0"` and `"id":1` when it names no id, and sends a frame that already declares a string `"jsonrpc"` unchanged. `binary` sends one file as the whole body: pass `file` instead of `body` (`file` alone implies `binary`). The path is stored as one the user has not chosen - the engine sends it only once they pick it again in the request editor or it lives under a folder allowed in Settings > Files, because an agent cannot choose a file on their behalf. Form-data file parts are not supported here; author them in the app. A graphql `body` may be the bare query document, and the method decides how it travels: the `{"query": ...}` JSON envelope on POST, `query`/`operationName`/`variables` query parameters with no body on GET - so give a mutation `method` POST rather than leaving the GET a new request defaults to. An xml `body` is stored and sent verbatim as application/xml.'
				),
			description: z.string().optional(),
			auth: storedAuthInput(
				"this request",
				'Omit it for the stored default, "inherit", which resolves against the collection chain when the request is sent.'
			),
			...requestSettingsInput(),
			elements: elementsInput("this request"),
			preRequestScript: storedScriptInput("pre", false),
			postRequestScript: storedScriptInput("post", false),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const payload: Record<string, unknown> = {
				collectionId: requireStr(args, "collectionId"),
				name: requireStr(args, "name"),
				url: requireStr(args, "url"),
				method: str(args, "method") ?? "GET",
			};
			const auth = readAuthArg(args);
			if (auth) payload.auth = auth;
			applyRequestSettings(args, payload);
			if (args.headers && typeof args.headers === "object") {
				payload.headers = toKeyValueEntries(args.headers);
			}
			// The engine stores the body blob verbatim; the canonical shape keys
			// off `mode` (not `type`), so a `type`-keyed body would not round-trip
			// in the app. `bodyType` mirrors it into the denormalized column.
			// A malformed body throws `ToolArgError`, which `dispatchTool` answers
			// as a tool error before anything is written.
			const shaped = shapeBody(args);
			if (shaped) {
				payload.body = shaped.body;
				payload.bodyType = shaped.bodyType;
			}
			// Pass-through strings: absent leaves the engine's own default (empty),
			// so only what the caller actually named is sent.
			const description = str(args, "description");
			if (description !== undefined) payload.description = description;
			// `elements` and the script sugar cannot both be given (elementsInput's
			// description says so): a caller who stated the whole list has already
			// said what belongs in it.
			const elementsGiven = elementsArg(args);
			const scriptEdits = readScriptEdits(args);
			if (elementsGiven !== undefined && scriptEdits.length > 0) {
				return errorResult(
					'Pass "elements" or "preRequestScript"/"postRequestScript", not both - add a "script.pre"/"script.post" entry to "elements" directly instead.'
				);
			}
			if (elementsGiven !== undefined) {
				payload.elements = elementsGiven;
			} else {
				// Scripts are `elements` on the wire (issue #1514). Nothing is
				// stored yet on a create, so the list is built outright rather
				// than merged.
				const elements: Record<string, unknown>[] = [];
				for (const [which, script] of scriptEdits) {
					if (script !== "") elements.push(scriptElement(which, script));
				}
				if (elements.length > 0) payload.elements = elements;
			}
			return callEngine(() => ctx.client.createRequest(payload, signal), echoShape(ctx));
		},
	},
	{
		name: "update_request",
		category: "write",
		invalidates: ["request"],
		description:
			"Correct a saved request: its name, URL, method, headers, body, auth, redirect policy, protocol, stream flag, certificate-verification setting, description or elements (extractors, assertions, timers, scripts). GUARDED: requires write access to be enabled in Vayu Settings. Only the fields you pass change - anything you leave out keeps its stored value. Passing `headers` replaces the whole header list, so send every header the request should end up with; passing `auth` replaces the whole auth block, so send the mode and its credentials together ({ mode: 'none' } clears it, { mode: 'inherit' } hands it back to the collection chain); passing `elements` replaces the whole elements list; passing a script replaces just that script's element, and an empty string clears it. `mockResponseMode`/`mockExampleId` set which saved example a mock server answers this request with (`mockExampleId: null` clears it) - get_mock_routes shows the effect once a mock is running." +
			" " +
			WITHHELD_AUTH_SENTENCE +
			" " +
			WITHHELD_HEADER_SENTENCE +
			" " +
			WITHHELD_URL_SENTENCE,
		annotations: {
			title: "Update saved request",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			requestId: z.string().describe("Saved request ID to update."),
			name: z.string().optional().describe("New display name."),
			url: z.string().optional().describe("New URL (may contain {{variables}})."),
			method: z.string().optional().describe("New HTTP method."),
			headers: z
				.record(z.string(), z.string())
				.optional()
				.describe("Replacement headers as a string map (replaces the stored list)."),
			body: z.string().optional().describe("New request body content."),
			file: fileRefInput,
			bodyType: z
				.string()
				.optional()
				.describe(
					"Body type for `body`: json, text, graphql, jsonrpc, xml, form-data, x-www-form-urlencoded, binary. Only meaningful alongside `body`, or alongside `file` for binary, which replaces the body with that file exactly as `create_request` describes - stored as a path the user has not chosen, sent only once they pick it in the editor or it lives under a folder allowed in Settings > Files. A jsonrpc `body` is enveloped engine-side exactly as `create_request` describes, and a graphql `body` travels by the same method-dependent rule that tool describes - the JSON envelope on POST, query parameters on GET; an xml `body` is stored and sent verbatim as application/xml. Form-data file parts are not supported here; a stored one is left alone unless `body` replaces the whole body."
				),
			description: z.string().optional().describe("New description."),
			auth: storedAuthInput(
				"this request",
				"Replaces the stored block whole - send the mode and its credentials together. Leave it out to keep what is stored."
			),
			...requestSettingsInput(),
			mockResponseMode: z
				.enum(["first", "fixed", "random"])
				.optional()
				.describe(
					"Which saved example a mock server answers with. 'fixed' requires mockExampleId. Takes effect the next time start_mock_server runs, like every other change to a saved example."
				),
			mockExampleId: z
				.string()
				.nullable()
				.optional()
				.describe(
					"The example 'fixed' mode names (an id from list_request_examples). Pass null to clear it."
				),
			elements: elementsInput("this request"),
			preRequestScript: storedScriptInput("pre", true),
			postRequestScript: storedScriptInput("post", true),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const requestId = requireStr(args, "requestId");
			/*
			 * The payload carries exactly what the caller named: `PUT /requests/:id`
			 * is a merge-patch (absent keeps, null resets), so a field omitted here
			 * is a field left alone. That is also why nothing is defaulted - a
			 * `method: "GET"` filler would silently rewrite the stored verb.
			 */
			const payload: Record<string, unknown> = {};
			for (const field of ["name", "url", "method", "description"] as const) {
				const value = str(args, field);
				if (value !== undefined) payload[field] = value;
			}
			const scriptEdits = readScriptEdits(args);
			if (args.headers && typeof args.headers === "object" && !Array.isArray(args.headers)) {
				payload.headers = toKeyValueEntries(args.headers);
			}
			// Auth and the five Settings fields ride the same rule as the strings
			// above: stated is written, absent is left alone. The block replaces
			// the stored one wholesale because the engine stores it as one JSON
			// column - there is no per-credential patch to offer.
			const auth = readAuthArg(args);
			if (auth) payload.auth = auth;
			applyRequestSettings(args, payload);
			const mockResponseMode = args.mockResponseMode as
				"first" | "fixed" | "random" | undefined;
			// `str()` treats `null` the same as absent (it only recognizes a
			// string), which is right for every other field here but wrong for
			// this one: `mockExampleId: null` is how a caller clears the target,
			// same as the engine's own null-vs-absent merge-patch rule, so it
			// needs its own presence check rather than `str()` alone.
			if ("mockExampleId" in args) {
				payload.mockExampleId =
					args.mockExampleId === null ? null : str(args, "mockExampleId");
			}
			if (mockResponseMode === "fixed" && !payload.mockExampleId) {
				return errorResult(
					'"mockResponseMode": "fixed" needs "mockExampleId" - pass the example it should serve.'
				);
			}
			if (mockResponseMode !== undefined) payload.mockResponseMode = mockResponseMode;
			// Both keys move together, the way create_request writes them: the
			// blob is what round-trips in the app, `bodyType` the denormalized
			// column beside it. Writing one without the other leaves the two
			// disagreeing about what the request sends.
			// A malformed body throws `ToolArgError`, which `dispatchTool` answers
			// as a tool error before anything is written.
			const shaped = shapeBody(args);
			if (shaped) {
				payload.body = shaped.body;
				payload.bodyType = shaped.bodyType;
			}
			const elementsGiven = elementsArg(args);
			if (elementsGiven !== undefined && scriptEdits.length > 0) {
				return errorResult(
					'Pass "elements" or "preRequestScript"/"postRequestScript", not both - add a "script.pre"/"script.post" entry to "elements" directly instead.'
				);
			}
			if (
				Object.keys(payload).length === 0 &&
				scriptEdits.length === 0 &&
				elementsGiven === undefined
			) {
				return errorResult(
					"Pass at least one field to change (name, url, method, headers, body, file, auth, followRedirects, maxRedirects, httpVersion, stream, description, mockResponseMode, mockExampleId, elements, preRequestScript or postRequestScript)."
				);
			}
			// Scripts are `elements` now (issue #1514), and `PUT /requests/:id`
			// replaces that list whole rather than patching inside it - so a
			// script edit is a read-merge-write, or it would drop every other
			// element the request holds. Read only when one was actually named:
			// an update that touches no script must not pay for a GET. An
			// explicit `elements` argument has already stated the whole list
			// the caller wants, so no fetch is needed there.
			if (scriptEdits.length > 0) {
				let stored: Record<string, unknown>;
				try {
					stored = ((await ctx.client.getRequest(requestId, signal)) ?? {}) as Record<
						string,
						unknown
					>;
				} catch (err) {
					return engineErrorResult(err);
				}
				let elements = stored.elements;
				for (const [which, script] of scriptEdits) {
					elements = upsertScriptElement(elements, which, script);
				}
				payload.elements = elements;
			}
			if (elementsGiven !== undefined) {
				payload.elements = elementsGiven;
			}
			return callEngine(
				() => ctx.client.updateRequest(requestId, payload, signal),
				echoShape(ctx)
			);
		},
	},
	{
		name: "delete_request",
		category: "write",
		invalidates: ["request"],
		description:
			"Delete a saved request. GUARDED: requires write access to be enabled in Vayu Settings, and confirmation: if the client supports elicitation the user is prompted with the request's name and URL; otherwise call once for a preview, then again with `confirmed: true`. It goes to Vayu's Trash rather than disappearing outright - list_trash shows it there, and restore_trash_entry puts it back, until the retention window (`trashRetentionDays`, 30 days by default) runs out.",
		annotations: {
			title: "Delete saved request",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			requestId: z.string().describe("Saved request ID to delete."),
			confirmed: confirmedInput("actually delete the request"),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const requestId = requireStr(args, "requestId");
			// Read it first so the person answering the prompt sees what is about to
			// go, rather than an id. A 404 here is the answer, not a failure to ask.
			let stored: Record<string, unknown>;
			try {
				const value = await ctx.client.getRequest(requestId, signal);
				stored =
					value && typeof value === "object" ? (value as Record<string, unknown>) : {};
			} catch (err) {
				if (err instanceof EngineRequestError && err.status === 404) {
					return errorResult(`No saved request with id "${requestId}".`);
				}
				return engineErrorResult(err);
			}
			const name =
				typeof stored.name === "string" && stored.name !== "" ? stored.name : requestId;
			// The URL is shown to whoever reads the prompt or the preview, and it can
			// carry a password or a credential query value (#1837).
			const shownUrl = secretsShape(ctx, (url) => withholdRequestUrl(url, stored.auth))(
				stored.url
			);
			const target = [stored.method, shownUrl].filter((v) => typeof v === "string").join(" ");
			const subject = target ? `"${name}" (${target})` : `"${name}"`;
			const unconfirmed = await confirmDestructive(args, ctx, {
				message: `Delete the saved request ${subject}?\n\nIt goes to Vayu's Trash, where it can be restored.`,
				acceptTitle: "Delete the request",
				acceptDescription: "Confirm to delete this saved request.",
				declined: "Request not deleted - the user declined.",
				preview:
					"AWAITING CONFIRMATION - nothing was deleted.\n\n" +
					`This would delete the saved request ${subject}. It would go to Vayu's Trash, where it can be restored.\n\n` +
					"This is a preview. To delete it, call delete_request again with confirmed: true and the same arguments.",
			});
			if (unconfirmed) return unconfirmed;
			return callEngine(() => ctx.client.deleteRequest(requestId, signal));
		},
	},
	{
		name: "list_trash",
		category: "read",
		invalidates: [],
		description:
			"List what delete_collection / delete_request have sent to Vayu's Trash and can still be restored, newest first. Answers ROOTS ONLY - the row a delete actually targeted, never what its cascade took with it: a deleted collection's whole subtree is one entry here, with `collections` and `requests` counting the sub-collections and saved requests that same delete took (always 0 for a request). Each entry also carries `kind` ('collection' | 'request'), `name`, `deletedAt` (Unix ms) and `parentId` (the collection's old parent, or the request's owning collection). Put one back with restore_trash_entry, or destroy it for good with purge_trash_entry. Rows are also purged automatically once older than the `trashRetentionDays` config entry (30 days by default; `0` keeps them forever - see get_engine_config).",
		annotations: {
			title: "List trash",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		handler: (_args, ctx, signal) => callEngine(() => ctx.client.listTrash(signal)),
	},
	{
		name: "restore_trash_entry",
		category: "write",
		// Both families: a restore can bring back either kind, and there is no
		// argument here that says which in advance - the same reasoning
		// move_item's pair carries.
		invalidates: ["collection", "request"],
		description:
			"Put a deleted collection or saved request back from Vayu's Trash, with everything its delete took along - a restored collection's whole subtree returns too, scoped to that one delete's cohort (see list_trash). GUARDED: requires write access to be enabled in Vayu Settings. This is NOT destructive - it restores data rather than removing it - so there is no confirmation step. A collection whose parent is gone, or is itself still in the trash, comes back at the top level instead of where it was (`reparentedToRoot: true` in the result); a request has no such fallback, so restoring one whose collection is itself deleted or gone is refused with a 409 naming the collection to restore first. An id the trash does not hold - a live row, or one already purged - is a 404.",
		annotations: {
			title: "Restore from Trash",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			id: z.string().describe("Trash entry ID to restore (from list_trash)."),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const id = requireStr(args, "id");
			let restored: Record<string, unknown>;
			try {
				const value = await ctx.client.restoreTrashEntry(id, signal);
				restored = isRecord(value) ? value : {};
			} catch (err) {
				// The engine's own message already names the fix (a wrong id, or
				// which collection to restore first) - surface it rather than
				// writing a second sentence that could disagree with it.
				if (
					err instanceof EngineRequestError &&
					(err.status === 404 || err.status === 409)
				) {
					return errorResult(trashRefusalMessage(err));
				}
				return engineErrorResult(err);
			}
			const result = jsonResult(echoShape(ctx)(restored));
			// A moved folder is worth telling the caller about - it is not where it
			// used to be, even though the restore itself succeeded.
			return restored.reparentedToRoot === true
				? withCaveat(
						result,
						"\n\nRestored at the top level: its original parent is gone or itself in the trash, so it came back as a tree root rather than where it was."
					)
				: result;
		},
	},
	{
		name: "purge_trash_entry",
		category: "write",
		invalidates: ["collection", "request"],
		description:
			"Permanently destroy one entry in Vayu's Trash, with its whole subtree - requests, and the examples they own. THERE IS NO UNDO: this is the Trash's own hard delete, on top of the soft delete delete_collection / delete_request already did, and once it runs the row is gone the way a delete used to be before Trash existed. GUARDED: requires write access to be enabled in Vayu Settings, and confirmation: if the client supports elicitation the user is prompted with the entry's name and what it holds; otherwise call once for a preview, then again with `confirmed: true`. An id the trash does not hold is a 404, which also stops a mistyped id from destroying anything live.",
		annotations: {
			title: "Purge from Trash",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			id: z.string().describe("Trash entry ID to destroy for good (from list_trash)."),
			confirmed: confirmedInput("actually purge this trash entry for good"),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const id = requireStr(args, "id");
			// Read what the purge destroys before asking, the same reasoning
			// delete_collection reads its cascade first: an unreadable entry is a
			// refusal, never a prompt carrying a name and counts nobody verified.
			let entry: TrashRow;
			try {
				entry = await readTrashEntry(ctx.client, id, signal);
			} catch (err) {
				if (err instanceof ToolArgError) return errorResult(err.message);
				return engineErrorResult(err);
			}
			const subject = describeTrashEntry(entry);
			const unconfirmed = await confirmDestructive(args, ctx, {
				message: `Permanently destroy ${subject}?\n\nThere is no undo.`,
				acceptTitle: "Purge from Trash",
				acceptDescription: "Confirm to destroy it for good.",
				declined: "Nothing purged - the user declined.",
				preview:
					"AWAITING CONFIRMATION - nothing was purged.\n\n" +
					`This would permanently destroy ${subject}. There is no undo.\n\n` +
					"This is a preview. To purge it, call purge_trash_entry again with confirmed: true and the same arguments.",
			});
			if (unconfirmed) return unconfirmed;
			return callEngine(() => ctx.client.purgeTrashEntry(id, signal));
		},
	},
	{
		name: "list_request_examples",
		category: "read",
		invalidates: [],
		description:
			"List a request's saved example responses - the responses stored beside it, in the order a mock server would serve them (the first match answers). Every row carries its name, status, headers, content type, `order` and `origin` (`import` for what an importer or an OpenAPI sync wrote, `user` for what was saved from a live response). " +
			`Bodies are bounded: one over ${MAX_INLINE_BODY_BYTES} bytes comes back cut with \`bodyClipped: true\` and its stored size in \`bodyBytes\`, and once the list has spent ${MAX_EXAMPLES_BODY_BYTES} bytes the remaining bodies are dropped with \`bodyOmitted: true\` (the row's scalars are always kept). \`bodiesOmitted\` counts them. The engine's own \`bodyTruncated\` is a different fact - it says the response was already cut when it was captured. ` +
			WITHHELD_HEADER_SENTENCE,
		annotations: {
			title: "List saved examples",
			readOnlyHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			requestId: z.string().describe("Saved request whose examples to list."),
		},
		handler: async (args, ctx, signal) => {
			const requestId = requireStr(args, "requestId");
			return callEngine(
				() => ctx.client.listRequestExamples(requestId, signal),
				(rows) => boundExampleBodies(secretsShape(ctx, withholdRowListSecrets)(rows))
			);
		},
	},
	{
		name: "create_request_example",
		category: "write",
		invalidates: ["request"],
		description:
			"Save an example response on a request - what a mock server for its collection answers with, and what the Examples tab shows. GUARDED: requires write access to be enabled in Vayu Settings. Vayu assigns the id and appends the example after the request's current ones; a request already holding the maximum (100) is refused by the engine. The example is marked as written by hand: an agent cannot claim an example came from an import, because an OpenAPI sync replaces imported examples and leaves the others alone." +
			" " +
			WITHHELD_HEADER_SENTENCE,
		annotations: {
			title: "Create saved example",
			readOnlyHint: false,
			destructiveHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			requestId: z.string().describe("Saved request to attach the example to."),
			name: z.string().describe("Display name for the example (e.g. '200 OK')."),
			status: z
				.number()
				.int()
				.min(100)
				.max(599)
				.optional()
				.describe("HTTP status the example answers with (default 200)."),
			headers: z
				.record(z.string(), z.string())
				.optional()
				.describe("Response headers as a string map."),
			body: z.string().optional().describe("Response body, stored verbatim."),
			contentType: z
				.string()
				.optional()
				.describe(
					"Content type of `body` (e.g. application/json). Stored beside the headers; a mock server sends it."
				),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const requestId = requireStr(args, "requestId");
			const payload = exampleWritePayload(args);
			payload.name = requireStr(args, "name");
			// Stated rather than left to the engine's default, which is `import`:
			// this row was written by an agent, and the sync that replaces
			// imported rows must not be handed one it did not write (#588, #722).
			payload.origin = "user";
			return callEngine(
				() => ctx.client.createRequestExample(requestId, payload, signal),
				echoShape(ctx)
			);
		},
	},
	{
		name: "update_request_example",
		category: "write",
		invalidates: ["request"],
		description:
			"Correct a saved example: its name, status, headers, body or content type. GUARDED: requires write access to be enabled in Vayu Settings. Only the fields you pass change; passing `headers` replaces the whole header list. Where the example came from is not editable - an imported example stays imported, which is what lets an OpenAPI sync tell the two apart." +
			" " +
			WITHHELD_HEADER_SENTENCE,
		annotations: {
			title: "Update saved example",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			requestId: z.string().describe("Request that owns the example."),
			exampleId: z.string().describe("Example ID to update."),
			name: z.string().optional().describe("New display name."),
			status: z.number().int().min(100).max(599).optional().describe("New HTTP status."),
			headers: z
				.record(z.string(), z.string())
				.optional()
				.describe(
					"Replacement response headers as a string map (replaces the stored list)."
				),
			body: z.string().optional().describe("New response body."),
			contentType: z.string().optional().describe("New content type for `body`."),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const requestId = requireStr(args, "requestId");
			const exampleId = requireStr(args, "exampleId");
			const payload = exampleWritePayload(args);
			if (Object.keys(payload).length === 0) {
				return errorResult(
					'Pass at least one field to change ("name", "status", "headers", "body" or "contentType").'
				);
			}
			return callEngine(
				() => ctx.client.updateRequestExample(requestId, exampleId, payload, signal),
				echoShape(ctx)
			);
		},
	},
	{
		name: "delete_request_example",
		category: "write",
		invalidates: ["request"],
		description:
			"Delete one saved example from a request. GUARDED: requires write access to be enabled in Vayu Settings, and confirmation: if the client supports elicitation the user is prompted with the example's name and what a mock server loses; otherwise call once for a preview, then again with `confirmed: true`. There is no undo, and a mock server for this collection stops answering with it once it is restarted.",
		annotations: {
			title: "Delete saved example",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			requestId: z.string().describe("Request that owns the example."),
			exampleId: z.string().describe("Example ID to delete."),
			confirmed: confirmedInput("actually delete the example"),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const requestId = requireStr(args, "requestId");
			const exampleId = requireStr(args, "exampleId");
			// Read the list first so the prompt names the example rather than an
			// id - the same rule delete_request follows. There is no by-id read
			// for one example, and the owner check the engine makes on every
			// nested path is exactly this scan: an id stored under another
			// request is "no such example" here too.
			let stored: Record<string, unknown> | undefined;
			try {
				const rows = await ctx.client.listRequestExamples(requestId, signal);
				stored = (Array.isArray(rows) ? rows : []).find(
					(row) => isRecord(row) && row.id === exampleId
				) as Record<string, unknown> | undefined;
			} catch (err) {
				return engineErrorResult(err);
			}
			if (!stored) {
				return errorResult(`No example with id "${exampleId}" on request "${requestId}".`);
			}
			const subject = describeExample(exampleId, stored);
			const consequence =
				"A mock server for this collection stops answering with it once it is restarted. This cannot be undone.";
			const unconfirmed = await confirmDestructive(args, ctx, {
				message: `Delete the saved example ${subject}?\n\n${consequence}`,
				acceptTitle: "Delete the example",
				acceptDescription: "Confirm to delete this saved example.",
				declined: "Example not deleted - the user declined.",
				preview:
					"AWAITING CONFIRMATION - nothing was deleted.\n\n" +
					`This would delete the saved example ${subject}. ${consequence}\n\n` +
					"This is a preview. To delete it, call delete_request_example again with confirmed: true and the same arguments.",
			});
			if (unconfirmed) return unconfirmed;
			return callEngine(() => ctx.client.deleteRequestExample(requestId, exampleId, signal));
		},
	},
	{
		name: "move_item",
		category: "write",
		/*
		 * Both families, and the pair is load-bearing rather than cautious. The
		 * `request` event narrows on the `collectionId` the call named, which for
		 * a move is the *destination* - the list the row left would stay stale on
		 * its own. `collection` is the coarse one (`collections.all` +
		 * `requests.all`), so it covers the source list, the two parents' orders,
		 * and the subtree a moved collection took with it.
		 */
		invalidates: ["collection", "request"],
		description:
			"Move a collection or a saved request into another collection - the row menu's 'Move to...', over MCP. GUARDED: requires write access to be enabled in Vayu Settings. It lands at the end of its new parent by default, or at the front with `position: 'first'`; positions in between stay a UI gesture, because naming one means doing the app's ordering arithmetic from the outside. A collection may move to the top level (`parentId: null`); a request always belongs to a collection. Refused, with nothing written, when a collection would move into itself or into its own subtree." +
			" " +
			WITHHELD_VARIABLE_SENTENCE +
			" " +
			WITHHELD_AUTH_SENTENCE +
			" " +
			WITHHELD_HEADER_SENTENCE +
			" " +
			WITHHELD_URL_SENTENCE,
		annotations: {
			title: "Move an item",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			type: z
				.enum(["collection", "request"])
				.describe("What is being moved: a collection (folder) or a saved request."),
			id: z.string().describe("ID of the collection or request to move."),
			parentId: z
				.string()
				.nullable()
				.optional()
				.describe(
					"Destination for a collection: another collection's id, or null for the top level. Required when `type` is 'collection'."
				),
			collectionId: z
				.string()
				.optional()
				.describe(
					"Destination collection for a request. Required when `type` is 'request'."
				),
			position: z
				.enum(MOVE_POSITIONS)
				.optional()
				.describe("Where it lands among its new siblings: 'last' (default) or 'first'."),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const type = requireStr(args, "type");
			if (type !== "collection" && type !== "request") {
				return errorResult('"type" must be "collection" or "request".');
			}
			const id = requireStr(args, "id");
			// Read off the raw value rather than through `str`, which answers
			// `undefined` for a non-string: a `position: 0` would then default to
			// "last" and land the row at the opposite end of the one it named.
			const position = args.position === undefined ? "last" : args.position;
			if (position !== "first" && position !== "last") {
				return errorResult('"position" must be "first" or "last".');
			}

			let batch: Record<string, unknown>;
			try {
				if (type === "collection") {
					// Stated, not inferred: `parentId` absent would have to mean
					// either "the top level" or "leave it where it is", and a move
					// that guessed wrong is a folder somewhere nobody asked for.
					if (!("parentId" in args)) {
						return errorResult(
							'Moving a collection needs "parentId" - another collection\'s id, or null for the top level.'
						);
					}
					const parentId = args.parentId === null ? null : str(args, "parentId");
					if (parentId === undefined) {
						return errorResult('"parentId" must be a collection id or null.');
					}
					const rows = readCollectionRows(await ctx.client.listCollections(signal));
					const subtree = collectionSubtree(rows, id);
					if (subtree === null) return errorResult(`No collection with id "${id}".`);
					// The UI's own refusal set, walked here so the answer names the
					// problem. The engine rejects the same batch under its lock -
					// that check is the one that is race-free and stays the
					// authority; this one exists so an agent is told "into its own
					// subtree" rather than handed a 400 about a move entry.
					if (parentId !== null && subtree.includes(parentId)) {
						return errorResult(
							parentId === id
								? `A collection cannot be moved into itself ("${id}").`
								: `"${id}" cannot be moved into "${parentId}" - that collection is inside it.`
						);
					}
					if (parentId !== null && !rows.some((row) => row.id === parentId)) {
						return errorResult(`No collection with id "${parentId}".`);
					}
					batch = moveBatch({
						type,
						movedId: id,
						position,
						owner: { parentId },
						siblings: rows.filter(
							(row) => collectionParent(row) === parentId && row.id !== id
						),
					});
				} else {
					const collectionId = str(args, "collectionId");
					if (collectionId === undefined) {
						return errorResult(
							'Moving a request needs "collectionId" - the collection it should end up in.'
						);
					}
					const siblings = readOrderedSiblings(
						await ctx.client.listRequests(collectionId, signal)
					).filter((row) => row.id !== id);
					batch = moveBatch({
						type,
						movedId: id,
						position,
						owner: { collectionId },
						siblings,
					});
				}
			} catch (err) {
				return engineErrorResult(err);
			}
			return callEngine(
				() => ctx.client.reorder(batch, signal),
				secretsShape(ctx, withholdReorderRows)
			);
		},
	},
	{
		name: "create_environment",
		category: "write",
		invalidates: ["environment"],
		description:
			"Create an environment - a named set of {{variables}} a request resolves against. Populate it in the same call, with plain values or with the secret/type/enabled flags. The environment is created inactive: activate_environment is what makes it the one requests resolve against. Vayu assigns the id and returns it. GUARDED: requires write access to be enabled in Vayu Settings. " +
			precedenceNote(
				"An environment's variables are the top scope tier: once this one is active they shadow every collection and global of the same name."
			) +
			" " +
			WITHHELD_VARIABLE_SENTENCE,
		annotations: {
			title: "Create environment",
			readOnlyHint: false,
			destructiveHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			name: z.string().describe("Display name for the environment."),
			description: z.string().optional().describe("Optional description."),
			variables: variablesInput("the new environment"),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const name = requireStr(args, "name");
			const patch = isRecord(args.variables) ? args.variables : undefined;
			if (args.variables !== undefined && patch === undefined) {
				return errorResult('"variables" must be an object mapping names to values.');
			}
			// Merged against nothing, which is what turns the string form into a
			// stored entry and enforces "a new variable carries a value" - on a
			// create every variable is new.
			const merged = mergeVariables({}, patch, [], ctx.config.revealSecretsToAgents);
			// No `id`: the engine assigns every id it stores and answers a body
			// carrying one with a 400 (issue #97), so the tool does not offer a
			// field it would only have to refuse.
			const payload: Record<string, unknown> = { name, variables: merged.variables };
			const description = str(args, "description");
			if (description !== undefined) payload.description = description;
			return callEngine(() => ctx.client.createEnvironment(payload, signal), echoShape(ctx));
		},
	},
	{
		name: "update_environment",
		category: "write",
		invalidates: ["environment"],
		description:
			"Set, re-flag or remove an environment's variables, and rename it. Merges: variables you do not name are left alone, and a named one keeps every flag you do not state - so rotating a secret leaves it masked and writing to a disabled variable leaves it disabled. Pass a variable as a string to set its value, or as an object to set any of value/secret/type/enabled. removeVariables deletes names outright, which blanking a value cannot do. GUARDED: requires write access to be enabled in Vayu Settings. " +
			precedenceNote(
				"An environment's variables are the top scope tier: while this environment is active they shadow every collection and global of the same name. Writing here to an inactive environment changes nothing a request resolves until activate_environment makes it current."
			) +
			" " +
			WITHHELD_VARIABLE_SENTENCE,
		annotations: {
			title: "Update environment",
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			environmentId: z.string().describe("Environment ID to update."),
			variables: variablesInput("this environment"),
			removeVariables: removeVariablesInput("this environment"),
			name: z.string().optional().describe("Optional new name for the environment."),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const environmentId = requireStr(args, "environmentId");
			const patch = isRecord(args.variables) ? args.variables : undefined;
			if (args.variables !== undefined && patch === undefined) {
				return errorResult('"variables" must be an object mapping names to values.');
			}
			const removals = removalNames(args);
			const rename = str(args, "name");
			if (patch === undefined && removals.length === 0 && rename === undefined) {
				return errorResult(
					'Pass at least one change: "variables", "removeVariables" or "name".'
				);
			}
			// Fetch the current env so we merge (the PUT replaces the whole blob)
			// and keep the existing name (which the engine requires).
			let existing: Record<string, unknown>;
			try {
				existing = ((await ctx.client.getEnvironment(environmentId, signal)) ??
					{}) as Record<string, unknown>;
			} catch (err) {
				return engineErrorResult(err);
			}
			const merged = mergeVariables(
				existing.variables,
				patch,
				removals,
				ctx.config.revealSecretsToAgents
			);
			// PUT carries the id in the path, so the body is the patch only. The
			// name is still sent because the engine treats it as having no
			// default - omitting it would keep the stored name, but sending the
			// caller's rename in the same call is the point of the `name` arg.
			const payload: Record<string, unknown> = {
				name: rename ?? (typeof existing.name === "string" ? existing.name : ""),
				variables: merged.variables,
			};
			const result = await callEngine(
				() => ctx.client.updateEnvironment(environmentId, payload, signal),
				echoShape(ctx)
			);
			return result.isError
				? result
				: withCaveat(result, absentRemovalCaveat(merged.absentRemovals));
		},
	},
	{
		name: "activate_environment",
		category: "write",
		invalidates: ["environment"],
		description:
			'Make an environment the active one - the set {{variables}} resolve against when a call names no environmentId of its own, and what the app\'s own switcher shows. Exactly one environment is active at a time: activating one deactivates the previous in the same write. Pass "none" to leave no environment active, the switcher\'s "No Environment" option. Tools that take an explicit environmentId (run_request, start_load_run, run_collection) are unaffected by this - it is the default, not an override. GUARDED: requires write access to be enabled in Vayu Settings. ' +
			precedenceNote(
				"This is the one call that changes which tier answers without changing any value: the newly active environment shadows every collection and global of the same name, so a name can start resolving differently with nothing else edited."
			) +
			" " +
			WITHHELD_VARIABLE_SENTENCE,
		annotations: {
			title: "Activate environment",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			environmentId: z
				.string()
				.describe('Environment ID to activate, or "none" to leave none active.'),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const environmentId = requireStr(args, "environmentId");
			if (environmentId !== "none") {
				// `isActive: true` is the whole switch: the DB layer clears the
				// previously active row in the same transaction
				// (`deactivate_other_environments_locked`), so a companion write
				// would be a second definition of the same rule. No `name` - absent
				// on a PUT means keep.
				return callEngine(
					() => ctx.client.updateEnvironment(environmentId, { isActive: true }, signal),
					echoShape(ctx)
				);
			}
			// There is no "no environment" row to write true to, so clearing is
			// spelled as deactivating whichever row holds the flag - the same shape
			// `useSetActiveEnvironmentMutation` sends. Which row that is has to be
			// read: the engine has no "deactivate all" verb.
			let active: Record<string, unknown> | undefined;
			try {
				const listed = await ctx.client.listEnvironments(signal);
				const rows = Array.isArray(listed) ? listed : [];
				active = rows.find((row) => isRecord(row) && row.isActive === true) as
					Record<string, unknown> | undefined;
			} catch (err) {
				return engineErrorResult(err);
			}
			const activeId = active && typeof active.id === "string" ? active.id : undefined;
			if (activeId === undefined) {
				// Successful and deliberately without effect, so it emits no
				// data-changed event - there is nothing for the renderer to refetch.
				return unchanged(
					textResult("No environment was active, so there was nothing to deactivate.")
				);
			}
			return callEngine(
				() => ctx.client.updateEnvironment(activeId, { isActive: false }, signal),
				echoShape(ctx)
			);
		},
	},
	{
		name: "delete_environment",
		category: "write",
		invalidates: ["environment"],
		description:
			"Delete an environment and every variable in it. GUARDED: requires write access to be enabled in Vayu Settings, and confirmation: if the client supports elicitation the user is prompted with the environment's name and how many variables go with it; otherwise call once for a preview, then again with `confirmed: true`. There is no undo, and a saved request that referenced those variables keeps its {{placeholders}} with nothing to resolve them.",
		annotations: {
			title: "Delete environment",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			environmentId: z.string().describe("Environment ID to delete."),
			confirmed: confirmedInput("actually delete the environment and its variables"),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const environmentId = requireStr(args, "environmentId");
			// Read it first so the prompt names the environment and its variable
			// count rather than an id - the read-before-prompt every delete here
			// does. `getEnvironment` resolves from the list (the engine has no
			// `GET /environments/:id`) and answers null for an id nothing matches.
			let environment: Record<string, unknown>;
			try {
				const found = await ctx.client.getEnvironment(environmentId, signal);
				if (!isRecord(found))
					return errorResult(`No environment with id "${environmentId}".`);
				environment = found;
			} catch (err) {
				return engineErrorResult(err);
			}
			const subject = describeEnvironment(environmentId, environment);
			const unconfirmed = await confirmDestructive(args, ctx, {
				message: `Delete ${subject}?\n\nEvery variable in it goes with it. This cannot be undone.`,
				acceptTitle: "Delete the environment",
				acceptDescription: "Confirm to delete this environment and its variables.",
				declined: "Environment not deleted - the user declined.",
				preview:
					"AWAITING CONFIRMATION - nothing was deleted.\n\n" +
					`This would delete ${subject}, along with every variable in it. This cannot be undone.\n\n` +
					"This is a preview. To delete it, call delete_environment again with confirmed: true and the same arguments.",
			});
			if (unconfirmed) return unconfirmed;
			return callEngine(() => ctx.client.deleteEnvironment(environmentId, signal));
		},
	},
	{
		name: "get_globals",
		category: "read",
		invalidates: [],
		description:
			"Read the global variables - used by every request whatever environment is active. An engine that has never had any answers an empty set rather than an error. " +
			WITHHELD_VARIABLE_SENTENCE +
			" " +
			precedenceNote(
				"Globals are the bottom tier, so a value read back here is not necessarily the one a request resolves: use resolve_variables to see which definition actually wins."
			),
		annotations: {
			title: "Get global variables",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		handler: (_args, ctx, signal) =>
			callEngine(() => ctx.client.getGlobals(signal), secretsShape(ctx, withholdRowSecrets)),
	},
	{
		name: "resolve_variables",
		category: "read",
		invalidates: [],
		description:
			'Answer which definition of a variable name actually wins in a given context, and list the ones it beat - the question get_globals and list_environments cannot, because each shows one tier in isolation. For every name it reports the winning value with the scope and source that supplied it, then every shadowed definition highest-precedence-first, each saying whether it was outranked by a higher tier or simply switched off (`enabled: false`). A switched-off row is the more common answer to "why is this not the value I set?", and a name whose every definition is disabled resolves to nothing at all rather than to an empty string. ' +
			precedenceNote(
				"Pass no environmentId to use the active environment, the same default a send takes; pass a collectionId to include its chain."
			) +
			" " +
			WITHHELD_VARIABLE_SENTENCE +
			" Reports what is stored: it resolves nothing on the wire and starts no run.",
		annotations: {
			title: "Resolve variables",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z
				.string()
				.optional()
				.describe(
					"Optional collection ID. Includes that collection's chain, merged root-first, between globals and the environment."
				),
			environmentId: z
				.string()
				.optional()
				.describe(
					'Optional environment ID. Omit for the active environment (the default a send takes); pass "none" to resolve as if no environment were active.'
				),
			names: z
				.array(z.string())
				.optional()
				.describe(
					"Optional variable names to report. Omit for every name defined anywhere in the context. A name nothing defines is reported as unresolved rather than omitted."
				),
		},
		handler: async (args, ctx, signal) => {
			const collectionId = str(args, "collectionId");
			const environmentId = str(args, "environmentId");
			const names = stringArray(args, "names");

			let scopes: OriginScopes;
			let context: Record<string, unknown>;
			try {
				scopes = await gatherVariableScopes(ctx, collectionId, environmentId, signal);
				context = describeScopes(scopes, collectionId, environmentId);
			} catch (err) {
				// A bad id is the caller's mistake and must not be reported as an
				// engine failure - the same split `pagedRead`'s callers keep.
				if (err instanceof ToolArgError) return errorResult(err.message);
				return engineErrorResult(err);
			}

			const variables = resolveVariableReports(
				scopes,
				names,
				ctx.config.revealSecretsToAgents
			);
			return structuredResult({
				context,
				variables,
				summary: {
					reported: variables.length,
					resolved: variables.filter((v) => v.resolved).length,
					shadowed: variables.filter((v) => v.shadowedBy.length > 0).length,
				},
			});
		},
	},
	{
		name: "update_globals",
		category: "write",
		invalidates: ["environment"],
		description:
			"Set, re-flag or remove global variables - the ones every request can resolve, whatever environment is active. Merges exactly as update_environment does: globals you do not name are left alone, and a named one keeps every flag you do not state. GUARDED: requires write access to be enabled in Vayu Settings. " +
			precedenceNote(
				"Globals are the bottom tier: any collection or active-environment definition of the same name shadows what you write here, so a request whose value does not change after this call is usually shadowed rather than unwritten - resolve_variables names the definition that won."
			) +
			" " +
			WITHHELD_VARIABLE_SENTENCE,
		annotations: {
			title: "Update global variables",
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			variables: variablesInput("the globals"),
			removeVariables: removeVariablesInput("the globals"),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const patch = isRecord(args.variables) ? args.variables : undefined;
			if (args.variables !== undefined && patch === undefined) {
				return errorResult('"variables" must be an object mapping names to values.');
			}
			const removals = removalNames(args);
			if (patch === undefined && removals.length === 0) {
				return errorResult('Pass at least one change: "variables" or "removeVariables".');
			}
			// `POST /globals` saves the singleton whole - it is the one resource
			// with no create/update split, so an absent `variables` there means
			// `{}`, not "keep". The read is what makes this a merge rather than a
			// replace.
			let stored: unknown;
			try {
				stored = await ctx.client.getGlobals(signal);
			} catch (err) {
				return engineErrorResult(err);
			}
			const merged = mergeVariables(
				isRecord(stored) ? stored.variables : undefined,
				patch,
				removals,
				ctx.config.revealSecretsToAgents
			);
			const result = await callEngine(
				() => ctx.client.saveGlobals({ variables: merged.variables }, signal),
				echoShape(ctx)
			);
			return result.isError
				? result
				: withCaveat(result, absentRemovalCaveat(merged.absentRemovals));
		},
	},
	{
		name: "get_cookies",
		category: "read",
		invalidates: [],
		description:
			"Read the design-mode cookie jars - one entry per environment that holds anything, plus the jar used when no environment is selected, each cookie with its name, value, domain, path, secure/httpOnly flags and expiry. This is how 'why is this request already authenticated' gets answered: run_request and run_collection_smoke send through these jars and store what comes back, and the same jars serve the user's own sends in that environment. " +
			WITHHELD_COOKIE_SENTENCE,
		annotations: {
			title: "Get cookie jars",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		handler: (_args, ctx, signal) =>
			callEngine(
				() => ctx.client.getCookies(signal),
				secretsShape(ctx, withholdCookieValues)
			),
	},
	{
		name: "clear_cookies",
		category: "write",
		invalidates: ["cookie"],
		description:
			"Drop stored cookies, so the next request starts a fresh session - the tool equivalent of Settings -> General -> Cookies. Omit environmentId to clear every jar, pass an id to clear that environment's, or pass null to clear the jar used when no environment is selected. Returns how many cookies were dropped. No confirmation: nothing saved is lost, only session state a re-login restores. GUARDED: requires write access to be enabled in Vayu Settings.",
		annotations: {
			title: "Clear cookie jars",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			environmentId: z
				.string()
				.nullable()
				.optional()
				.describe(
					'Scope to clear: an environment ID for that environment\'s jar, null for the no-environment jar, or omitted for every jar. Omitting and passing null are different calls - "all" and "the unnamed one".'
				),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			// Null, not falsy: `null` is a scope of its own here (the jar no
			// environment id can name), so it has to stay distinguishable from an
			// absent argument all the way to the query string.
			const stated = args.environmentId;
			if (stated !== undefined && stated !== null && typeof stated !== "string") {
				return errorResult(
					'"environmentId" must be an environment ID, null for the no-environment jar, or omitted for every jar.'
				);
			}
			const scope: string | null | undefined =
				stated === null ? null : str(args, "environmentId");
			return callEngine(() => ctx.client.clearCookies(scope, signal));
		},
	},
	{
		name: "run_collection_smoke",
		category: "execute",
		invalidates: ["run", "cookie", "variables"],
		description:
			"Execute a collection's own saved requests once each and return a pass/fail matrix (a request passes on a 2xx/3xx status with all its tests passing and, when the collection is bound to an OpenAPI document, a response matching the schema that document declares - a response the document declares no schema for is reported as unchecked and never fails the request; pass failOnSchemaError: false to keep that verdict on every row without letting it decide pass/fail). A row whose request ran assertions carries `tests` - `total`, `failed`, and the failing `name: message` lines (at most 10; `failed` is the true count) - so a request that failed on its tests says which, not just ok:false. Scope is the collection's DIRECT requests: nested sub-collections are not run, and the result discloses how many were left out - call this tool on each of them to cover them. Requests run one at a time, so a large collection takes as long as its requests do added together. Each request is composed exactly as the app would send it: {{variables}} resolved in the order " +
			VARIABLE_RESOLUTION_URI +
			" states, the request's stored auth applied (inheriting from the collection chain, incl. OAuth2), and its collection-chain + own pre/post scripts run. Each request's resolved host must be on the allowlist; requests whose host still cannot be verified (e.g. a variable did not resolve and allow-all is off) are skipped. Sends real traffic and, as the app's Send does, saves back any variables its scripts or extractors set (environment, globals, collection variables); it changes no other Vayu data. " +
			ENGINE_DEFAULT_HEADERS_SENTENCE +
			" " +
			WITHHELD_RUN_OUTPUT_SENTENCE +
			" " +
			WITHHELD_SMOKE_ROW_URL_SENTENCE,
		annotations: {
			title: "Run collection smoke test",
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: true,
		},
		inputSchema: {
			collectionId: z.string().describe("Collection whose requests to run."),
			environmentId: z
				.string()
				.optional()
				.describe("Environment for variable resolution during execution."),
			failOnSchemaError: failOnSchemaErrorInput({
				unit: "request",
				defaultsOn: true,
				guidance:
					"Set false to report the schema verdict on each row without letting it decide pass/fail - useful against a document known to lag its API.",
			}),
		},
		outputSchema: smokeResultSchema,
		handler: async (args, ctx, signal) => {
			const collectionId = requireStr(args, "collectionId");
			const environmentId = str(args, "environmentId");
			// Absent means the gate stays on - this tool's behaviour since #681.
			// Read once, before any traffic: it decides how every row is judged,
			// and a per-row read of one argument could only ever be wrong twice.
			const failOnSchemaError = args.failOnSchemaError !== false;
			let requests: unknown;
			try {
				requests = await ctx.client.listRequests(collectionId, signal);
			} catch (err) {
				return engineErrorResult(err);
			}
			const list = Array.isArray(requests) ? requests : [];
			// Read before any traffic flows: after the loop this call competes with
			// a cancellation the run itself may have raised, and the disclosure has
			// to survive that.
			const children = await childCollectionNames(ctx.client, collectionId, signal);
			const results: Array<Record<string, unknown>> = [];
			let passed = 0;
			let failed = 0;
			let skipped = 0;

			for (const item of list) {
				const req = (item ?? {}) as {
					id?: string;
					name?: string;
					method?: string;
					url?: string;
					auth?: unknown;
				};
				const name = String(req.name ?? req.id ?? "request");
				// Compose the request the same way the app's Send does - engine-side
				// (`POST /compose`): variables resolved, stored/inherited auth
				// applied, and the chain's + its own scripts attached.
				let outgoing: Record<string, unknown>;
				try {
					outgoing = await composeViaEngine(
						ctx.client,
						{ requestId: String(req.id ?? ""), environmentId },
						signal
					);
				} catch (err) {
					results.push({
						name,
						method: String(req.method ?? "GET"),
						url: smokeRowUrl(ctx, req.url, req.auth),
						ok: false,
						error: err instanceof Error ? err.message : String(err),
					});
					failed++;
					continue;
				}
				const method = String(outgoing.method ?? "GET");
				const url = String(outgoing.url ?? "");
				// Only what the row echoes is projected; the gate and the send read `url`.
				const shownUrl = smokeRowUrl(ctx, url, outgoing.auth ?? req.auth);

				const gate = checkAllowlist(url, ctx.config);
				if (!gate.ok) {
					results.push({
						name,
						method,
						url: shownUrl,
						ok: false,
						skipped: true,
						reason: gate.error,
					});
					skipped++;
					continue;
				}
				try {
					const resp = ((await ctx.client.executeRequest(
						withMcpOrigin(outgoing, ctx),
						signal
					)) ?? {}) as Record<string, unknown>;
					const code =
						typeof resp.status === "number"
							? resp.status
							: typeof resp.statusCode === "number"
								? resp.statusCode
								: 0;
					// One reading of the assertions decides `ok` *and* rides the
					// row (issue #733): a row that fails on tests has to be able
					// to say which, and a second walk here could disagree with
					// the list the agent is shown.
					const tests = readTestVerdict(resp);
					const testsOk = !tests || tests.failed === 0;
					// The contract's own verdict, folded in the way `testResults`
					// folds (issue #681): a response the document declares a
					// schema for and that does not match it is a failed request.
					// Only a *checked* verdict can fail one - `checked: false`
					// says the response could not be judged, which is not the
					// same as judged and wrong, and failing a smoke run on it
					// would make an undocumented status look like a broken API.
					//
					// `failOnSchemaError: false` unfolds it (issue #720): the
					// verdict still rides the row, it just stops deciding `ok`.
					const schema = readSchemaVerdict(resp);
					const schemaOk =
						!failOnSchemaError || !(schema?.checked === true && schema.valid === false);
					const ok = code >= 200 && code < 400 && testsOk && schemaOk;
					results.push({
						name,
						method,
						url: shownUrl,
						ok,
						statusCode: code,
						...(schema ? { schema } : {}),
						...(tests ? { tests } : {}),
					});
					if (ok) passed++;
					else failed++;
				} catch (err) {
					results.push({
						name,
						method,
						url: shownUrl,
						ok: false,
						error: err instanceof Error ? err.message : String(err),
					});
					failed++;
				}
			}

			// A row's `url`, `reason`, `error` and failing test lines are what the
			// composed request resolved to, secrets included, so the matrix is run
			// output (#1809); read after the sends, so a secret a script set is known.
			const withhold = await runOutputShape(ctx, signal);
			return withCaveat(
				structuredResult({
					collectionId,
					total: list.length,
					passed,
					failed,
					skipped,
					results: withhold(results),
				}),
				smokeScopeCaveat(children)
			);
		},
	},
	{
		name: "run_collection",
		category: "execute",
		invalidates: ["run", "cookie", "variables"],
		description:
			"Run a collection as the product means collections to be run: its saved requests executed as an ordered sequence, one step at a time, by the engine's design-mode runner. Unlike run_collection_smoke this is ONE run with a run id - steps share a cookie jar, `pm.execution` flow control (setNextRequest, skipRequest) works, pre-request scripts run, and passing `data` repeats the sequence once per row with {{data.column}} bound and pm.iterationData set. Pass recursive: true to include sub-collections, in the sidebar's order. The collection tree IS the sequence: there is no step list to give. Every step's resolved host must be on the allowlist - unlike the smoke matrix, which skips an off-allowlist request and runs the rest, a scenario is one run, so a single step the allowlist does not cover refuses the whole run and nothing is sent. Returns the run id immediately; the run continues engine-side and get_run_report reads its outcome. For a collection bound to an OpenAPI document, pass failOnSchemaError: true to make that contract a gate, as the app's Run Collection checkbox does - off by default, the verdict is reported without deciding pass/fail. Pass `thresholds` to judge the run against pass/fail budgets, the same way a load run can. Sends real traffic and, as the app's Run Collection does, saves back any variables its scripts or extractors set (environment, globals, collection variables); it changes no other Vayu data. For a load test over the same sequence, use start_load_run's `scenario` argument.",
		annotations: {
			title: "Run collection",
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: true,
		},
		inputSchema: {
			collectionId: z.string().describe("Collection whose requests make up the sequence."),
			environmentId: z
				.string()
				.optional()
				.describe(
					"Environment whose variables resolve {{templates}} in every step, and whose cookie jar the run uses."
				),
			recursive: scenarioRecursiveInput,
			// Positive: the engine reads the count as a pass total, so a zero is a
			// run with nothing to do and a negative is not a count at all. Named
			// rather than clamped, like every other count in this registry.
			iterations: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					"How many passes over the sequence (default 1, or the row count when `data` is given). With more passes than rows the row index wraps."
				),
			data: scenarioDataInput,
			// The Run Collection dialog's checkbox, which had no MCP writer at all
			// (issue #766). Design-mode only, because only this runner demotes a
			// step on a schema failure - see the refusal on `start_load_run`.
			failOnSchemaError: failOnSchemaErrorInput({
				unit: "step",
				defaultsOn: false,
				guidance:
					"Set true to make the bound contract a gate, the way the app's Run Collection checkbox does: a step whose response does not match its schema fails, and the run's report records that it was judged that way. Only a step that passed everything else is demoted - one already failing keeps the error that named it. Left off, the verdict still rides every step and the report's schemaValidation totals; it just does not decide pass/fail.",
			}),
			// Only `timers` - not `scripts` - from #1495's override block
			// (issue #1559): unlike a scenario load run, this design-mode
			// runner has no inline/deferred distinction for script.pre/
			// script.post to make, but it does run timer.pacing/timer.think
			// waits (`execute_scenario_run` wires `RunContext::timers_override`
			// exactly as the load path does - see `elementsTimersInput`'s doc
			// comment), so silencing them here is real, not a no-op control.
			elements: z
				.object({ timers: elementsTimersInput() })
				.optional()
				.describe(
					"Silence this run's timer.pacing/timer.think waits without editing the collection (`timers: \"off\"`); \"asConfigured\" (default) leaves each element's own configuration in effect. Only `timers` applies to a design-mode run - `scripts`'s inline-vs-deferred distinction is a load-run concept only, so it belongs on start_load_run's `scenario` branch instead."
				),
			// The engine now judges a design-mode run against declared budgets
			// exactly as it always has a load run (issue #1564), so this tool
			// takes the same `thresholds` argument `start_load_run` does.
			thresholds: thresholdsInput,
		},
		handler: async (args, ctx, signal) => {
			const collectionId = requireStr(args, "collectionId");
			const environmentId = str(args, "environmentId");
			const recursive = args.recursive === true;
			const iterations = typeof args.iterations === "number" ? args.iterations : undefined;
			const data = Array.isArray(args.data) ? (args.data as unknown[]) : undefined;

			let plannedSteps: number;
			try {
				plannedSteps = await preflightScenarioSteps(
					{ collectionId, recursive, environmentId },
					ctx,
					signal
				);
			} catch (err) {
				if (err instanceof ToolArgError) return errorResult(err.message);
				return engineErrorResult(err);
			}

			const payload: Record<string, unknown> = {
				scenario: scenarioBlock({ collectionId, data }, recursive, iterations),
				...(environmentId !== undefined ? { environmentId } : {}),
				// Top-level, beside `scenario` rather than inside it: that is where
				// `read_fail_on_schema_error` looks, and where the app's dialog puts
				// it. Omitted when off - the engine's default - so a run snapshot
				// carries the key exactly when it changed what "failed" meant, which
				// is what keeps a payload written before the flag existed reading the
				// way it always did.
				...(args.failOnSchemaError === true ? { failOnSchemaError: true } : {}),
				// Also top-level, beside `scenario`, for the same reason -
				// `validate_elements_run_override` reads it there on every
				// `POST /runs` payload regardless of mode.
				...(args.elements && typeof args.elements === "object"
					? { elements: args.elements }
					: {}),
			};
			// Forwarded verbatim - the keys are the engine's own metric names,
			// and they come back unchanged in get_run_report's
			// `thresholdValidation`. Zod has already bounded every value.
			if (args.thresholds && typeof args.thresholds === "object") {
				payload.thresholds = args.thresholds;
			}

			let started: unknown;
			try {
				started = await ctx.client.startRun(withMcpOrigin(payload, ctx), signal);
			} catch (err) {
				return engineErrorResult(err);
			}
			// The engine's 202 body is the answer; anything else is handed back as
			// it came rather than dressed up as a started run.
			if (!started || typeof started !== "object" || Array.isArray(started)) {
				return jsonResult(started);
			}
			return watchedRun(
				structuredResult({
					...(started as Record<string, unknown>),
					plannedSteps,
					nextStep:
						`The run executes engine-side. Read it with get_run_report(runId): the ` +
						`\`scenario\` section carries the iteration and pass/fail/skip totals plus ` +
						`\`stepsStored\`/\`stepsDropped\`, and \`results\` returns at most 100 step rows ` +
						`(non-passing steps are kept first). Each row's \`trace\` carries that step's ` +
						`request and response bodies inline, so a long plan against large responses ` +
						`makes for a large report - read the totals first and the rows when you need ` +
						`them. stop_run ends the run early.`,
				}),
				"collection",
				started
			);
		},
	},
	{
		name: "start_load_run",
		category: "load",
		invalidates: ["run"],
		description:
			"Start a load test against a URL, or against a saved request via `requestId` - which composes it exactly as the app does, including the collection chain's and its own test scripts, so a load run checks the same assertions a Send does. GUARDED: the host must be on the allowlist, and RPS/concurrency/duration must be within Vayu's caps. {{variables}} in the URL, headers, and body are resolved when an environmentId (and/or collectionId) is given; pass an `auth` block to authenticate the load (bearer/basic/apikey/oauth2, applied engine-side). Pass a `postRequestScript` - the same assertions you would give run_request - to validate responses under load; it runs against sampled responses. A pre-request script is not offered here for a single target: the engine runs one on a single request only, never on a load run. " +
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
				.string()
				.optional()
				.describe("constant_rps | constant_concurrency | ramp_up | iterations | capacity."),
			// Positive, because an agent's natural guess for "unlimited" is -1 or
			// 0, and the engine reads concurrency as an eager per-worker
			// pre-allocation count. It rejects those with a 400; failing here
			// names the field instead of surfacing an HTTP error.
			concurrency: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("Target in-flight requests."),
			// Positive for the same reason `concurrency` is: the ramp is seeded
			// with this count, so a negative casts to ~1.8e19 engine-side and a
			// zero start is a ramp that begins with no traffic at all.
			startConcurrency: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("Ramp start concurrency (ramp_up). Above `concurrency` ramps down."),
			duration: z
				.string()
				.optional()
				.describe(
					'Duration with an optional ms/s/m/h unit, e.g. "500ms", "30s", "5m", "2h"; a bare number is seconds (non-iterations modes).'
				),
			rampUpDuration: z
				.string()
				.optional()
				.describe("Ramp time (ramp_up), same units as `duration`."),
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
					"How long each concurrency level is held before it is judged (capacity), same units as `duration`."
				),
			// An iterations run stops on this count and reads no duration, so it
			// is the only thing bounding the run; `-1` would cast to ~1.8e19.
			iterations: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("Iteration count (iterations mode)."),
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
					'Data rows for a single-target run, one flat object per row (e.g. [{"id":"1"},{"id":"2"}]). One row is bound per request sent, claimed off a run-wide cursor that wraps, so a run longer than the set repeats it. The columns a collection declares for its data file are its `dataSchema.columns` in list_collections. Every {{data.column}} in the URL, headers, body and auth credentials binds per submission, and the post-request script reads that submission\'s row as pm.iterationData. A present-but-empty array is refused by the engine, as is `data` beside a `scenario` block - a collection run states its rows as scenario.data instead. The set is not persisted (only its count is recorded on the run), but a bound value travels in the request that carried it and is stored with the run\'s retained traces.'
				),
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
				return engineErrorResult(err);
			}
			const url = String(composed.payload.url ?? "");
			if (!url) {
				return errorResult(
					`Saved request "${str(args, "requestId")}" has no URL to load-test.`
				);
			}
			const gate = checkAllowlist(url, ctx.config);
			if (!gate.ok) return errorResult(gate.error!);

			// A monitored run contacts a second host, so it gets a second gate.
			// The scrape needs no duration cap of its own: the monitor thread is
			// joined when the run ends, so whatever bounds the run bounds it.
			const monitor = args.monitor as { url?: unknown } | undefined;
			if (monitor && typeof monitor === "object") {
				const monitorGate = checkMonitorHost(String(monitor.url ?? ""), ctx.config);
				if (!monitorGate.ok) return errorResult(monitorGate.error!);
			}

			// One mode string for both the guard and the payload: which strategy
			// the engine picks decides which cap applies, so a guard reading a
			// different mode than the run uses is a guard reading the wrong run.
			const mode = str(args, "mode") ?? DEFAULT_LOAD_MODE;
			const loadParams: LoadRunParams = {
				mode,
				targetRps: typeof args.targetRps === "number" ? args.targetRps : undefined,
				concurrency: typeof args.concurrency === "number" ? args.concurrency : undefined,
				startConcurrency:
					typeof args.startConcurrency === "number" ? args.startConcurrency : undefined,
				iterations: typeof args.iterations === "number" ? args.iterations : undefined,
				duration: (args.duration as string | number | undefined) ?? undefined,
				rampUpDuration: (args.rampUpDuration as string | number | undefined) ?? undefined,
				stepDuration: (args.stepDuration as string | number | undefined) ?? undefined,
			};
			const caps = checkLoadCaps(loadParams, ctx.config);
			if (!caps.ok) return errorResult(caps.error!);

			const payload: Record<string, unknown> = {
				...composed.payload,
				mode,
				// The run-level timers/scripts override (issue #1594), same as a
				// scenario's - `validate_elements_run_override` reads it on every
				// `POST /runs` payload regardless of mode, and a single target's
				// own `requestElements` now has a pipeline for it to reach.
				...(args.elements && typeof args.elements === "object"
					? { elements: args.elements }
					: {}),
			};
			for (const key of [
				"concurrency",
				"startConcurrency",
				"iterations",
				"targetRps",
				"maxInFlight",
				"sloMs",
				"maxStreamDurationMs",
				"maxStreamEvents",
			]) {
				if (typeof args[key] === "number") payload[key] = args[key];
			}
			// Forwarded only when present: the engine refuses a cap on a
			// non-streaming run, and refuses `stream` beside `transient`, so a
			// defaulted `false` here would turn "the caller said nothing" into
			// a claim the engine then has to judge (issue #576).
			if (typeof args.stream === "boolean") payload.stream = args.stream;
			for (const key of ["duration", "rampUpDuration", "stepDuration"]) {
				const v = str(args, key);
				if (v !== undefined) payload[key] = v;
			}
			// Forwarded verbatim, rows and all: the engine validates the set
			// before the run row exists and its refusal names the field, so a
			// second copy of those rules here could only drift (issue #993).
			if (Array.isArray(args.data)) payload.data = args.data;
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
			// An omitted duration is 60s engine-side, not "unbounded" and not
			// "capped" - so a cap under 60s has to be sent as an explicit field
			// or it never reaches the run.
			const cappedDuration = defaultDurationUnderCap(loadParams, ctx.config);
			if (cappedDuration !== null) payload.duration = cappedDuration;

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
			const summary = `Start a load test against ${shown.url} (mode: ${shown.mode})?`;

			const unconfirmed = await confirmDestructive(args, ctx, {
				message: `${summary}\n\nThis generates real traffic within Vayu's caps.`,
				acceptTitle: "Start the load test",
				acceptDescription: "Confirm to generate load now.",
				declined: "Load run not started - the user declined.",
				preview:
					"AWAITING CONFIRMATION - no run was started.\n\n" +
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
				return engineErrorResult(err);
			}
			return watchedRun(withCaveat(jsonResult(started), caveat), "load", started);
		},
	},
	{
		name: "stop_run",
		category: "load",
		invalidates: ["run"],
		description:
			"Stop a run that is still in progress: a load test, or a streaming Design-mode send that is holding its connection open. The run ends where it is and keeps what it already recorded rather than being discarded, so get_run_report and get_run_samples still answer for it afterwards. Read the status in the result: a stream that closes within the engine's 5 s settle budget comes back `stopped`, and one that has not settled yet comes back `running` with a message saying the stop was signalled - it is not a failure, and re-reading the run reports the end state. Calling it on a run that has already finished is not an error: the result reports the status it was already in. A run id the engine does not know is an error.",
		annotations: {
			title: "Stop run",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: { runId: z.string().describe("Run ID to stop.") },
		handler: (args, ctx, signal) =>
			callEngine(() => ctx.client.stopRun(requireStr(args, "runId"), signal)),
	},
	{
		name: "set_run_baseline",
		category: "write",
		invalidates: ["run"],
		description:
			"Pin a run as the baseline for its saved request, or unpin it. The baseline is the known-good run later runs are compared against: once pinned, compare_runs can be called with only `targetRunId` and resolves this run as the base. It is also the one run history retention will not expire. One pin per request - pinning another run moves it. A run of an unsaved request has no request to be the baseline of, so pinning it changes what nothing reads. GUARDED: requires write access to be enabled in Vayu Settings. " +
			WITHHELD_RUN_OUTPUT_SENTENCE,
		annotations: {
			title: "Pin run as baseline",
			readOnlyHint: false,
			// It rewrites one flag on one row and is undone by calling it again
			// with the opposite value - the opposite of the deletes this hint
			// exists to warn about.
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			runId: z.string().describe("Run ID to pin or unpin."),
			baseline: z.boolean().describe("true pins this run as the baseline, false unpins it."),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const runId = requireStr(args, "runId");
			if (typeof args.baseline !== "boolean") {
				throw new ToolArgError('"baseline" is required and must be true or false.');
			}
			const baseline = args.baseline;
			return callEngineForRunOutput(
				ctx,
				() => ctx.client.setRunBaseline(runId, baseline, signal),
				{ signal }
			);
		},
	},
	{
		name: "delete_run",
		category: "write",
		invalidates: ["run"],
		description:
			"Delete a run and everything recorded against it - its report, metrics, captured samples and step traces. GUARDED: requires write access to be enabled in Vayu Settings, and confirmation: if the client supports elicitation the user is prompted with what the run was, otherwise call once for a preview and again with `confirmed: true`. There is no undo. A run still executing is stopped first and deleted once its worker has settled; if it does not settle in time nothing is deleted and the call says to retry.",
		annotations: {
			title: "Delete run",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			runId: z.string().describe("Run ID to delete."),
			confirmed: confirmedInput("actually delete the run"),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const runId = requireStr(args, "runId");
			// Read it first so the person answering the prompt sees which run is
			// about to go, not an id - the same reason delete_request does.
			let stored: Record<string, unknown>;
			try {
				const value = await ctx.client.getRun(runId, signal);
				if (!isRecord(value)) return errorResult(`No run with id "${runId}".`);
				stored = value;
			} catch (err) {
				if (err instanceof EngineRequestError && err.status === 404) {
					return errorResult(`No run with id "${runId}".`);
				}
				return engineErrorResult(err);
			}
			// The run row is run output: its snapshot `url` can carry a credential,
			// and the preview is read by the model.
			const withheld = (await runOutputShape(ctx, signal))(stored);
			const subject = describeRun(runId, isRecord(withheld) ? withheld : {});
			const unconfirmed = await confirmDestructive(args, ctx, {
				message: `Delete ${subject}?\n\nIts report, metrics and captured samples go with it. This cannot be undone.`,
				acceptTitle: "Delete the run",
				acceptDescription: "Confirm to delete this run and everything recorded against it.",
				declined: "Run not deleted - the user declined.",
				preview:
					"AWAITING CONFIRMATION - nothing was deleted.\n\n" +
					`This would delete ${subject}, along with its report, metrics and captured samples. This cannot be undone.\n\n` +
					"This is a preview. To delete it, call delete_run again with confirmed: true and the same arguments.",
			});
			if (unconfirmed) return unconfirmed;
			try {
				return jsonResult(await ctx.client.deleteRun(runId, signal));
			} catch (err) {
				// The engine refuses rather than half-deletes a run whose worker is
				// still writing (409). That is a "try again in a moment", not a
				// failure of the request - say which one it is.
				if (err instanceof EngineRequestError && err.status === 409) {
					return errorResult(
						`Run ${runId} is still stopping and was NOT deleted. It has been asked to stop - call delete_run again once it reports a terminal status (check with list_runs).`
					);
				}
				return engineErrorResult(err);
			}
		},
	},
	{
		name: "get_live_metrics",
		category: "read",
		invalidates: [],
		description:
			"Get a snapshot of the most recent live metrics ticks for a run (RPS, latency percentiles, error rate, status mix). Returns the last N ticks; does not stream.",
		annotations: {
			title: "Get live metrics",
			readOnlyHint: true,
			idempotentHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			runId: z.string().describe("Run ID to sample."),
			limit: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("How many recent ticks to return (default 10). Must be 1 or more."),
		},
		handler: (args, ctx, signal) => {
			const runId = requireStr(args, "runId");
			// Guarded here as well as in the schema: the SDK validates arguments
			// before dispatch, but the handler is the layer that knows a
			// non-positive limit reaches `slice(-limit)` and inverts the bound.
			const limit = optionalPositiveInt(args, "limit", 10);
			return callEngine(() =>
				ctx.client.getLiveMetricsSnapshot(runId, limit, undefined, signal)
			);
		},
	},
	{
		name: "compare_runs",
		category: "read",
		invalidates: [],
		description:
			"Compare two completed runs and return the deltas in latency percentiles, throughput, error rate, and status-code mix, each labelled with which direction is an improvement. Use to answer 'did this change regress performance?'. Omit baseRunId to compare against the run pinned as the baseline for the same saved request. compressionNegotiationDiffers true means the two runs did not negotiate a compressed response the same way, so the byte and latency deltas are not a clean comparison - check the runs' config before reading a regression into them.",
		annotations: {
			title: "Compare runs",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			baseRunId: z
				.string()
				.optional()
				.describe(
					"Baseline run ID (e.g. main). Omit to use the run pinned as baseline for the target's saved request."
				),
			targetRunId: z.string().describe("Comparison run ID (e.g. the change)."),
		},
		outputSchema: runComparisonSchema,
		handler: async (args, ctx, signal) => {
			const targetRunId = requireStr(args, "targetRunId");
			try {
				const baseRunId =
					str(args, "baseRunId") || (await resolveBaseline(targetRunId, ctx, signal));
				const [base, target] = await Promise.all([
					ctx.client.getRunReport(baseRunId, signal),
					ctx.client.getRunReport(targetRunId, signal),
				]);
				const comparison = compareReports(
					baseRunId,
					targetRunId,
					base as Record<string, unknown>,
					target as Record<string, unknown>
				);
				return structuredResult(comparison as unknown as Record<string, unknown>);
			} catch (err) {
				// A baseline that could not be resolved is an argument problem the
				// caller can fix, not an engine failure - it must not be reported
				// as one.
				if (err instanceof ToolArgError) return errorResult(err.message);
				return engineErrorResult(err);
			}
		},
	},
	{
		name: "list_client_certificates",
		category: "read",
		invalidates: [],
		description:
			'List the client certificates (mutual TLS) Vayu presents, one per host and optional port: `host` (or `*.example.com`), `port` (null for every port), `certPath`, `keyPath` ("" for a PKCS#12 bundle), `certFormat` and `hasPassphrase`. The passphrase itself is never returned. Read this when a host answers with a TLS handshake failure, or diagnose_connection reports `tls_failed`: a host with no entry sends no certificate. Entries are added in Vayu Settings.',
		annotations: {
			title: "List client certificates",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		handler: (_args, ctx, signal) =>
			callEngine(() => ctx.client.listClientCertificates(signal)),
	},
	{
		name: "diagnose_connection",
		category: "execute",
		invalidates: [],
		description:
			"Test whether Vayu can reach a URL under the proxy, custom CA and client-certificate settings in force, and say which hop failed. Sends one HEAD with certificate verification on, redirects off and a 10-second deadline, and returns `outcome` (ok, proxy_failed, tls_failed, timed_out, failed), the proxy mode and URL used, the client certificate that answered for the host (\"\" when none), and on failure the engine's error code and libcurl's message. Use it when requests fail with connection or TLS errors, before concluding the API is down. Never returns a response body or headers. " +
			WITHHELD_DIAGNOSE_SENTENCE +
			" GUARDED: the URL's host must be on Vayu's MCP allowlist.",
		annotations: {
			title: "Diagnose a connection",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: true,
		},
		inputSchema: {
			url: z
				.string()
				.describe("The http or https URL to test, fully resolved - no {{variables}}."),
		},
		handler: async (args, ctx, signal) => {
			const url = requireStr(args, "url");
			const gate = checkAllowlist(url, ctx.config);
			if (!gate.ok) return errorResult(gate.error!);
			let answer: unknown;
			try {
				answer = await ctx.client.diagnoseConnection(url, signal);
			} catch (err) {
				return engineErrorResult(err);
			}
			const outcome = asRecord(answer).outcome;
			const hint =
				typeof outcome === "string" ? CONNECTION_OUTCOME_HINTS[outcome] : undefined;
			return withCaveat(
				jsonResult(secretsShape(ctx, withholdDiagnoseCredentials)(answer)),
				hint ? `\n\n${hint}` : ""
			);
		},
	},
	{
		name: "fetch_oauth2_token",
		category: "execute",
		invalidates: ["oauth"],
		description:
			"Acquire an OAuth 2.0 token for a client_credentials or password config and cache it engine-side, so the next run_request / start_load_run carrying the same config authenticates without a round trip - and so a token problem surfaces here, named, instead of as a wall of 401s inside a run. Pass `force: true` to refresh a token that is cached but stale. The interactive authorization_code grant is refused: it needs a browser and a loopback redirect the app owns, so authorize it there once and the cache this tool reads is the same one. GUARDED: the token endpoint's host must be on Vayu's MCP allowlist. The access token itself is never returned - what comes back is the cache entry's shape (key, type, scope, expiry, whether a refresh token came with it), because the engine applies the token to requests and nothing an agent does with the bearer needs its bytes.",
		annotations: {
			title: "Fetch OAuth 2.0 token",
			readOnlyHint: false,
			// It contacts a third party and writes a credential into the engine's
			// cache, replacing whatever was there for that key.
			destructiveHint: true,
			openWorldHint: true,
		},
		inputSchema: {
			config: oauth2ConfigInput,
			force: z
				.boolean()
				.optional()
				.describe(
					"Refresh even when a valid token is cached. The engine uses the stored refresh token when the config allows it and falls back to a fresh grant. Default false - a cached, unexpired token is returned as-is."
				),
		},
		handler: async (args, ctx, signal) => {
			const config = isRecord(args.config) ? args.config : undefined;
			if (!config) return errorResult('"config" must be an OAuth 2.0 config object.');
			const grantType = str(config, "grantType");
			if (grantType === "authorization_code") {
				return errorResult(OAUTH2_INTERACTIVE_REFUSAL);
			}
			// Both URLs the engine may post to. The refresh URL defaults to the
			// token URL engine-side, so it is only checked when it names a
			// different host - a gate that read one of the two would be a gate a
			// config can walk around.
			for (const key of ["accessTokenUrl", "refreshTokenUrl"]) {
				const url = str(config, key);
				if (url === undefined || url === "") continue;
				const gate = checkAllowlist(url, ctx.config);
				if (!gate.ok) return errorResult(`${key}: ${gate.error!}`);
			}
			const payload: Record<string, unknown> = { config };
			if (args.force === true) payload.force = true;
			return callEngine(
				() => ctx.client.fetchOAuth2Token(payload, signal),
				(answer) => projectOAuth2Token(answer)
			);
		},
	},
	{
		name: "get_oauth2_token_status",
		category: "read",
		invalidates: [],
		description:
			"Ask whether a token is cached for a cache key, and whether it has expired - the read behind 'is this flow failing because the token went stale?'. The cache key is the `cacheKey` fetch_oauth2_token returned; the engine derives it from the token URL, client id, credentials id and (for password grants) the username, so configs differing only in scope share one entry. An absent entry is an answer (`found: false`), not an error. The access token is never returned, only the shape of the entry - see fetch_oauth2_token.",
		annotations: {
			title: "OAuth 2.0 token status",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: { cacheKey: oauth2CacheKeyInput },
		handler: (args, ctx, signal) =>
			callEngine(
				() => ctx.client.getOAuth2TokenStatus(requireStr(args, "cacheKey"), signal),
				(answer) => projectOAuth2Status(answer)
			),
	},
	{
		name: "clear_oauth2_token",
		category: "write",
		invalidates: ["oauth"],
		description:
			"Drop the cached token for a cache key, so the next request that uses that config acquires a fresh one - the tool equivalent of the auth tab's Clear button. Use it when a provider has revoked or rotated credentials and the cache is still serving the old token. Idempotent: clearing a key nothing is cached under reports `deleted: false` rather than failing. No confirmation - nothing saved is lost, only a credential a re-fetch restores. GUARDED: requires write access to be enabled in Vayu Settings.",
		annotations: {
			title: "Clear OAuth 2.0 token",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: { cacheKey: oauth2CacheKeyInput },
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			return callEngine(() =>
				ctx.client.clearOAuth2Token(requireStr(args, "cacheKey"), signal)
			);
		},
	},
	{
		name: "start_mock_issuer",
		category: "execute",
		// #502's Services drawer reads the issuer list and #756 added the
		// `service` entity; #757 is where the issuer tools take it, so an
		// MCP-started issuer appears without waiting out the drawer's poll.
		invalidates: ["service"],
		description:
			"Start a local OAuth 2.0 mock issuer and return its id, token URL, authorize URL and signing key. Use it to test an auth flow offline: start an issuer, point a request's oauth2 auth at the returned tokenUrl, run it with run_request, and assert on what the target received - no real identity provider, so no 2FA prompts, provider rate limits or account lockouts in the loop. It needs no allowlist entry: the engine binds every issuer to 127.0.0.1 and takes no host for it, so it is unreachable off this machine. The access token is an HS256 JWT signed with the returned signingKey - hand that key to the service under test and it can verify the mock's tokens. Set a short expiresInSeconds (with issueRefreshTokens) to exercise the 401-then-refresh path, and failureMode to exercise retry handling. At most 8 issuers run at once; stop yours with stop_mock_issuer when you are done.",
		annotations: {
			title: "Start mock OAuth issuer",
			readOnlyHint: false,
			// It binds a loopback listener and mints tokens for it: it destroys no
			// saved data and reaches nothing off the machine.
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			port: z
				.number()
				.int()
				.min(0)
				.max(65535)
				.optional()
				.describe("Port to bind on 127.0.0.1. Default 0 - the engine picks a free one."),
			expiresInSeconds: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					"Lifetime of a minted access token, in seconds (default 3600). Set it low to make a token expire mid-test."
				),
			claims: z
				.record(z.string(), z.unknown())
				.optional()
				.describe(
					'Extra JWT claims, e.g. {"sub": "alice", "roles": ["admin"]}. iss, iat, exp and jti are always the issuer\'s own; sub, client_id and scope are filled in only when you do not set them.'
				),
			clients: z
				.array(
					z.object({
						clientId: z.string().min(1).describe("Client id this issuer accepts."),
						clientSecret: z
							.string()
							.optional()
							.describe("Secret that client must then present."),
					})
				)
				.optional()
				.describe(
					"Clients the issuer accepts. Omit (the default) to accept any client id."
				),
			failureMode: z
				.enum(MOCK_ISSUER_FAILURE_MODES)
				.optional()
				.describe(
					'How /token misbehaves: "none" (default), "slow" (answers after slowMs), "server_error" (500), "invalid_client" (401).'
				),
			slowMs: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe('Delay before /token answers, in milliseconds. Only "slow" reads it.'),
			issueRefreshTokens: z
				.boolean()
				.optional()
				.describe(
					"Return a refresh_token alongside the access token, so a refresh grant can be tested. A refresh rotates its token - the presented one is spent."
				),
		},
		handler: (args, ctx, signal) =>
			callEngine(() => ctx.client.startMockIssuer(mockIssuerStartPayload(args), signal)),
	},
	{
		name: "list_mock_issuers",
		category: "read",
		invalidates: [],
		description:
			"List the OAuth 2.0 mock issuers running right now, each with its id, urls, signing key, port, token expiry, failure mode and configured client count. Use it to find an issuer started earlier in the session, or to confirm one was stopped.",
		annotations: {
			title: "List mock OAuth issuers",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		handler: (_args, ctx, signal) => callEngine(() => ctx.client.listMockIssuers(signal)),
	},
	{
		name: "stop_mock_issuer",
		category: "execute",
		invalidates: ["service"],
		description:
			"Stop a running OAuth 2.0 mock issuer and free its port. Tokens it already minted stay valid until they expire - nothing verifies them against the issuer once it is gone. An unknown id is an error, not a silent success.",
		annotations: {
			title: "Stop mock OAuth issuer",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			issuerId: z.string().describe("Issuer ID to stop (from start_mock_issuer)."),
		},
		handler: (args, ctx, signal) =>
			callEngine(() => ctx.client.stopMockIssuer(requireStr(args, "issuerId"), signal)),
	},
	{
		name: "update_mock_issuer",
		category: "execute",
		invalidates: ["service"],
		description:
			"Change how a running OAuth 2.0 mock issuer's /token endpoint behaves, live: its failure mode and its slow-mode delay. Use it to walk a client through a sequence - mint a token against a healthy issuer, flip it to server_error to see the retry, flip it back - without stopping the issuer, which would invalidate the token URL the request under test is already pointed at and change the signing key. This is a merge-patch: a field you omit keeps its current value. Only these two settings can change under a running issuer; the port, client list, claims and refresh-token setting are fixed when it starts, and asking to change one is an error telling you to start a new issuer.",
		annotations: {
			title: "Update mock OAuth issuer",
			readOnlyHint: false,
			// It rewrites two settings of a loopback listener; nothing recorded is
			// lost and the same patch applied twice is the same issuer.
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			issuerId: z.string().describe("Issuer ID to update (from start_mock_issuer)."),
			failureMode: z
				.enum(MOCK_ISSUER_FAILURE_MODES)
				.optional()
				.describe(
					'How /token should misbehave from now on: "none" (healthy), "slow" (answers after slowMs), "server_error" (500), "invalid_client" (401). Omit to leave it unchanged.'
				),
			slowMs: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe(
					'New delay before /token answers, in milliseconds (engine cap 60000). Only "slow" reads it. Omit to leave it unchanged.'
				),
		},
		handler: (args, ctx, signal) => {
			const issuerId = requireStr(args, "issuerId");
			const patch = mockIssuerPatchPayload(args);
			if (Object.keys(patch).length === 0) {
				// The engine accepts an empty patch and changes nothing, so a
				// success here would report a call that did not do what it was
				// asked - the `update_inbox_response` precedent.
				throw new ToolArgError('Name at least one of "failureMode" or "slowMs" to change.');
			}
			return callEngine(() => ctx.client.updateMockIssuer(issuerId, patch, signal));
		},
	},
	{
		name: "start_mock_server",
		category: "execute",
		invalidates: ["service"],
		description:
			"Start a local mock server that answers a collection's saved examples, and return its id and base URL. Use it to stand up the API a client under test expects without that API existing: point the client at the returned url and every request whose method and path match a saved request in the collection gets that request's example back - status, headers and body. A route whose request has no saved example answers 501, and a path that matches nothing answers 404, so the returned routeCount and routesWithoutExample are what say whether the mock is usable; get_mock_routes lists them. latencyMs and errorRatePct are how a client's timeout and retry handling get exercised - errorRatePct injects synthesized 500s at that rate. It needs no allowlist entry: the engine binds every mock to 127.0.0.1 and takes no host for it, so it is unreachable off this machine. Stop it with stop_mock_server when you are done; a mock keeps its port until then.",
		annotations: {
			title: "Start mock server",
			readOnlyHint: false,
			// A loopback listener over data it only reads: it destroys nothing and
			// reaches nothing off the machine.
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z
				.string()
				.describe(
					"Collection whose saved examples the mock serves (from list_collections). Its sub-collections are included."
				),
			port: z
				.number()
				.int()
				.min(0)
				.max(65535)
				.optional()
				.describe("Port to bind on 127.0.0.1. Default 0 - the engine picks a free one."),
			latencyMs: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe(
					"Artificial delay before every answer, in milliseconds (default 0). Use it to make a client's timeout handling fire."
				),
			errorRatePct: z
				.number()
				.int()
				.min(0)
				.max(100)
				.optional()
				.describe(
					"Percentage of answers replaced with a synthesized 500 (default 0). 0 and 100 are exact; in between it is a per-request roll."
				),
		},
		handler: async (args, ctx, signal) => {
			const payload = mockServerStartPayload(args);
			let started: unknown;
			try {
				started = await ctx.client.startMockServer(payload, signal);
			} catch (err) {
				return engineErrorResult(err);
			}
			// The caveat rides on the result rather than being left in the JSON:
			// "the mock started" and "the mock can answer" are different answers,
			// and only the second one is what the agent asked for. Read off the
			// engine's reply, which is why this is `pagedRead`'s shape rather
			// than a plain `callEngine`.
			return withCaveat(jsonResult(started), mockServerCaveat(started));
		},
	},
	{
		name: "list_mock_servers",
		category: "read",
		invalidates: [],
		description:
			"List the mock servers running right now, each with its id, the collection it serves and that collection's name, its base URL and port, its latency and error-rate knobs, and how many routes it has. A stopped mock is gone rather than listed - its record dies with its listener - so this is also how to confirm one stopped.",
		annotations: {
			title: "List mock servers",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		handler: (_args, ctx, signal) => callEngine(() => ctx.client.listMockServers(signal)),
	},
	{
		name: "get_mock_routes",
		category: "read",
		invalidates: [],
		description:
			"List the routes one mock server is serving: method, path template, the saved request behind each, and whether that request has an example (hasExample false means the route answers 501). This is how 'the mock answers 404' gets diagnosed without sending a request per guess. The table is a snapshot taken when the mock started and cannot change under it - editing the collection means restarting the mock - so a second read answers the same thing. Each row also carries `mode` (the request's mockResponseMode), `exampleName` (which saved example it currently answers with, when resolvable), and `hits` (how many times this route has been served since the mock started) - the last one does change under repeated reads, unlike the rest of the table.",
		annotations: {
			title: "Get mock server routes",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			mockId: z.string().describe("Mock server ID (from start_mock_server)."),
		},
		handler: (args, ctx, signal) =>
			callEngine(() => ctx.client.getMockServerRoutes(requireStr(args, "mockId"), signal)),
	},
	{
		name: "get_mock_activity",
		category: "read",
		invalidates: [],
		description:
			"What one mock server has served, newest first: method, path, the matched request and example (or unmatched/no-example), status, and whether the response was an injected failure. Discarded when the mock stops, like get_mock_routes' table - a fresh get_mock_activity right after start_mock_server is always empty. " +
			WITHHELD_MOCK_ACTIVITY_SENTENCE,
		annotations: {
			title: "Get mock server activity",
			readOnlyHint: true,
			idempotentHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			mockId: z.string().describe("Mock server ID (from start_mock_server)."),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.describe("At most this many entries (default 50, max 200)."),
		},
		handler: async (args, ctx, signal) => {
			const limit = args.limit as number | undefined;
			const mockId = requireStr(args, "mockId");
			return callEngine(
				() => ctx.client.getMockServerActivity(mockId, limit ?? 50, signal),
				await runOutputShape(ctx, signal)
			);
		},
	},
	{
		name: "stop_mock_server",
		category: "execute",
		invalidates: ["service"],
		description:
			"Stop a running mock server and free its port. Unlike a webhook inbox there is nothing left to read afterwards - a mock records nothing, so its record goes with its listener and it disappears from list_mock_servers. Requests sent to the URL after this are refused by the machine. An unknown id is an error, not a silent success.",
		annotations: {
			title: "Stop mock server",
			readOnlyHint: false,
			// Nothing recorded is lost: a mock serves stored examples and keeps no
			// state of its own.
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			mockId: z.string().describe("Mock server ID to stop (from start_mock_server)."),
		},
		handler: (args, ctx, signal) =>
			callEngine(() => ctx.client.stopMockServer(requireStr(args, "mockId"), signal)),
	},
	{
		name: "start_webhook_inbox",
		category: "execute",
		invalidates: ["service"],
		description:
			"Start a local webhook inbox and return its id and URL. It records every request sent to it - method, path, query, headers, body, caller address - so an agent can point a webhook at the URL, trigger it, and then assert on what actually arrived with get_inbox_captures. It needs no allowlist entry: the inbox listens on this machine's loopback interface only, which MCP does not let you change, so it is unreachable from off the machine. Give it a canned `response` to make the sender see a specific status, body, headers or delay - the reply every captured request gets, changeable later with update_inbox_response. Stop it with stop_webhook_inbox when you are done (the captures survive a stop), or delete_webhook_inbox to remove it and them.",
		annotations: {
			title: "Start webhook inbox",
			readOnlyHint: false,
			// It binds a loopback listener and records what arrives: it destroys
			// no saved data and reaches nothing off the machine.
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			port: z
				.number()
				.int()
				.min(0)
				.max(65535)
				.optional()
				.describe(
					"Port to listen on, on this machine's loopback interface. Default 0 - the engine picks a free one. The interface itself is not configurable over MCP."
				),
			response: z
				.object({
					status: z
						.number()
						.int()
						.min(100)
						.max(599)
						.optional()
						.describe("Status code the inbox answers with (default 200)."),
					body: z.string().optional().describe("Response body the inbox answers with."),
					headers: z
						.record(z.string(), z.string())
						.optional()
						.describe(
							'Response headers, e.g. {"Content-Type": "application/json"}. Replaces the current set rather than merging into it.'
						),
					delayMs: z
						.number()
						.int()
						.nonnegative()
						.optional()
						.describe(
							"Milliseconds to wait before answering, for testing a sender's timeout handling. The engine caps this at 30000."
						),
				})
				.optional()
				.describe(
					"The canned reply every request to this inbox receives. Omit for the engine's default (200, empty body)."
				),
		},
		handler: (args, ctx, signal) =>
			callEngine(() => ctx.client.startInbox(inboxStartPayload(args), signal)),
	},
	{
		name: "list_webhook_inboxes",
		category: "read",
		invalidates: [],
		description:
			"List the webhook inboxes this engine has started, running and stopped alike, each with its id, URL, port, whether it is still listening, how many requests it has captured, and its canned response. A stopped inbox stays listed with its captures readable until it is deleted, so this is also how to find an inbox started earlier in the session.",
		annotations: {
			title: "List webhook inboxes",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		handler: (_args, ctx, signal) => callEngine(() => ctx.client.listInboxes(signal)),
	},
	{
		name: "stop_webhook_inbox",
		category: "execute",
		invalidates: ["service"],
		description:
			"Stop a webhook inbox's listener and free its port. This is NOT a delete: the inbox stays listed and everything it captured stays readable with get_inbox_captures - use delete_webhook_inbox to remove the record and its captures. Requests sent to the URL after this are refused by the machine, not recorded. An unknown id is an error, not a silent success.",
		annotations: {
			title: "Stop webhook inbox",
			readOnlyHint: false,
			// Nothing recorded is lost - the captures outlive the listener.
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			inboxId: z.string().describe("Inbox ID to stop (from start_webhook_inbox)."),
		},
		handler: (args, ctx, signal) =>
			callEngine(() => ctx.client.stopInbox(requireStr(args, "inboxId"), signal)),
	},
	{
		name: "delete_webhook_inbox",
		category: "write",
		invalidates: ["service"],
		description:
			"Delete a webhook inbox: stop its listener if it is still running, drop the record, and destroy every request it captured. GUARDED: requires write access to be enabled in Vayu Settings, and confirmation - if the client supports elicitation the user is prompted with how many captures go with it, otherwise call once for a preview and again with `confirmed: true`. There is no undo, and the captures are the part that cannot be recreated. To keep them, use stop_webhook_inbox instead.",
		annotations: {
			title: "Delete webhook inbox",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			inboxId: z.string().describe("Inbox ID to delete."),
			confirmed: confirmedInput("actually delete the inbox and its captures"),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const inboxId = requireStr(args, "inboxId");
			// Read the list first so the prompt states the real capture count and
			// the URL, not an id - the same read-before-prompt `delete_collection`
			// and `delete_run` do. `GET /inbox` is the only read that answers for
			// a single inbox: the engine has no `GET /inbox/:id`.
			let inbox: Record<string, unknown>;
			try {
				const listed = await ctx.client.listInboxes(signal);
				const rows = isRecord(listed) && Array.isArray(listed.data) ? listed.data : [];
				const found = rows.find((row) => isRecord(row) && row.inboxId === inboxId);
				if (!isRecord(found)) return errorResult(`No webhook inbox with id "${inboxId}".`);
				inbox = found;
			} catch (err) {
				return engineErrorResult(err);
			}
			const subject = describeInbox(inboxId, inbox);
			const unconfirmed = await confirmDestructive(args, ctx, {
				message: `Delete ${subject}?\n\nEverything it captured is destroyed with it. This cannot be undone.`,
				acceptTitle: "Delete the inbox",
				acceptDescription: "Confirm to delete this inbox and every request it captured.",
				declined: "Inbox not deleted - the user declined.",
				preview:
					"AWAITING CONFIRMATION - nothing was deleted.\n\n" +
					`This would delete ${subject}, along with every request it captured. This cannot be undone; stop_webhook_inbox frees the port and keeps them.\n\n` +
					"This is a preview. To delete it, call delete_webhook_inbox again with confirmed: true and the same arguments.",
			});
			if (unconfirmed) return unconfirmed;
			return callEngine(() => ctx.client.deleteInbox(inboxId, signal));
		},
	},
	{
		name: "get_inbox_captures",
		category: "read",
		invalidates: [],
		description:
			"Read what a webhook inbox recorded, newest first. Each row is the whole captured request - method, path, query string, headers, body and the caller's address - so this is the assertion half of a webhook test: start an inbox, trigger the sender, read the captures. An inbox that has received nothing returns an empty page, not an error. " +
			`A body the engine cut at its capture cap carries \`bodyTruncated\` beside \`bodyBytes\`, the true original size. BOUNDED: ${DEFAULT_INBOX_CAPTURE_LIMIT} captures per call by default, ${MAX_INBOX_CAPTURE_LIMIT} at most - a larger \`limit\` is refused, not clamped - and each body is cut to ${MAX_INLINE_BODY_BYTES / 1024} KB for this result. \`pagination\` says how many exist; read the rest with \`offset\`. There is no live stream over MCP: poll this after triggering the sender. ` +
			WITHHELD_RUN_OUTPUT_SENTENCE,
		annotations: {
			title: "Get inbox captures",
			readOnlyHint: true,
			// The newest-first page moves as captures arrive, exactly as
			// `get_live_metrics` does - the same reason that one is not idempotent.
			idempotentHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			inboxId: z.string().describe("Inbox ID whose captures to read."),
			limit: z
				.number()
				.int()
				.positive()
				.max(MAX_INBOX_CAPTURE_LIMIT)
				.optional()
				.describe(
					`How many captures to return (default ${DEFAULT_INBOX_CAPTURE_LIMIT}, max ${MAX_INBOX_CAPTURE_LIMIT}).`
				),
			offset: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe("How many captures to skip, for paging (default 0)."),
		},
		handler: async (args, ctx, signal) => {
			const inboxId = requireStr(args, "inboxId");
			const limit = optionalPageLimit(
				args,
				"limit",
				DEFAULT_INBOX_CAPTURE_LIMIT,
				MAX_INBOX_CAPTURE_LIMIT
			);
			const offset = optionalOffset(args, "offset");
			const withhold = await runOutputShape(ctx, signal);
			return pagedRead(
				() => ctx.client.getInboxCaptures(inboxId, limit, offset, signal),
				"captures",
				(page) => boundInboxCaptures(withhold(page))
			);
		},
	},
	{
		name: "clear_inbox_captures",
		category: "write",
		invalidates: ["service"],
		description:
			"Delete every request a webhook inbox has captured, keeping the listener running on the same URL. Use it to start a fresh assertion window between triggers. GUARDED: requires write access to be enabled in Vayu Settings; unlike delete_webhook_inbox it needs no confirmation, because the inbox survives and the next trigger records again. The captures themselves do not come back.",
		annotations: {
			title: "Clear inbox captures",
			readOnlyHint: false,
			// It destroys recorded data, which is what this hint is for - the
			// listener surviving does not make the captures recoverable.
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			inboxId: z.string().describe("Inbox ID whose captures to clear."),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const inboxId = requireStr(args, "inboxId");
			return callEngine(() => ctx.client.clearInboxCaptures(inboxId, signal));
		},
	},
	{
		name: "update_inbox_response",
		category: "execute",
		invalidates: ["service"],
		description:
			"Change what a running webhook inbox answers, live: status, body, headers or delay. The next request to arrive gets the new reply - nothing restarts and no captures are lost - so one inbox can answer 200 for the first trigger and 500 for the next, which is how a sender's retry or error handling gets exercised. This is a merge-patch: fields you omit keep their current value, and `headers` replaces the whole header set rather than merging into it.",
		annotations: {
			title: "Update inbox response",
			readOnlyHint: false,
			// It rewrites the canned reply of a listener and destroys nothing;
			// calling it again with the same block is a no-op.
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			inboxId: z.string().describe("Inbox ID whose canned response to change."),
			status: z
				.number()
				.int()
				.min(100)
				.max(599)
				.optional()
				.describe("New status code. Omit to leave it unchanged."),
			body: z.string().optional().describe("New response body. Omit to leave it unchanged."),
			headers: z
				.record(z.string(), z.string())
				.optional()
				.describe(
					"New response header set, replacing the current one entirely. Omit to leave it unchanged."
				),
			delayMs: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe(
					"New delay before answering, in milliseconds (engine cap 30000). Omit to leave it unchanged."
				),
		},
		handler: (args, ctx, signal) => {
			const inboxId = requireStr(args, "inboxId");
			const response = inboxResponsePayload(args);
			if (Object.keys(response).length === 0) {
				// An empty merge-patch is accepted by the engine and changes
				// nothing, which would report success for a call that did not do
				// what it was asked. Say which fields exist instead.
				throw new ToolArgError(
					'Name at least one of "status", "body", "headers" or "delayMs" to change.'
				);
			}
			return callEngine(() => ctx.client.updateInboxResponse(inboxId, response, signal));
		},
	},
];

/** Look up a tool by name. Only `dispatchTool` needs this, so it stays local. */
function findTool(name: string): McpTool | undefined {
	return TOOLS.find((t) => t.name === name);
}

/** IPC-safe metadata for every tool, for the Settings tool list. */
export function toolCatalog(): McpToolInfo[] {
	return TOOLS.map((t) => ({
		name: t.name,
		description: t.description,
		category: t.category,
	}));
}

/**
 * Dispatch a `tools/call`. Converts argument errors into tool errors so the
 * agent gets a readable message instead of a protocol failure.
 *
 * The single dispatch path: `server.ts` routes every registered tool callback
 * through here, so the disabled-tool rejection below is the same code the tests
 * exercise. (The SDK validates arguments against the Zod `inputSchema` first,
 * and registration already skips disabled tools - this rejection is what
 * answers a client that calls one anyway.)
 */
export async function dispatchTool(
	name: string,
	args: Record<string, unknown>,
	ctx: ToolContext,
	signal?: AbortSignal
): Promise<ToolResult> {
	const tool = findTool(name);
	if (!tool) return errorResult(`Unknown tool: ${name}`);
	// Tools the user switched off in Settings are rejected (and are also omitted
	// from tools/list, so a well-behaved client won't call them).
	if (ctx.config.disabledTools.includes(name)) {
		return errorResult(`Tool "${name}" is disabled in Vayu Settings → MCP.`);
	}
	let result: ToolResult;
	try {
		result = await tool.handler(args, ctx, signal);
	} catch (err) {
		if (err instanceof ToolArgError || err instanceof MaskingIncompleteError) {
			return errorResult(err.message);
		}
		return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
	}
	// One record per served call, whichever transport served it (#1558) - the
	// one place both the Electron-hosted host and the stdio CLI route through.
	ctx.log?.debug("mcp", "Served tool call", { tool: name });
	// Only a call that succeeded changed anything. A tool that returned an error
	// result may still have got as far as the engine, but it cannot say so, and
	// an invalidation storm on every rejected call would be worse than the one
	// stale list a genuinely-partial failure leaves behind. A confirmation
	// preview is the third case: successful, and deliberately without effect.
	if (!result.isError && !NOTHING_CHANGED.has(result)) notifyDataChanged(tool, args, ctx, result);
	return result;
}

/**
 * Tell the renderer what a successful call changed, one event per declared
 * entity. The scope hints come from the call's own arguments: every tool in the
 * registry spells these two the same way, so reading them here is what keeps a
 * new write tool from having to remember an emit of its own.
 *
 * Notification failure must not fail a write the engine has already applied -
 * the same rule `update_engine_config`'s best-effort read-back follows - so a
 * throwing listener is logged and swallowed rather than turned into a tool
 * error the agent would read as "the write did not happen".
 */
function notifyDataChanged(
	tool: McpTool,
	args: Record<string, unknown>,
	ctx: ToolContext,
	result: ToolResult
): void {
	if (!ctx.onDataChanged || tool.invalidates.length === 0) return;
	const collectionId = str(args, "collectionId");
	const requestId = str(args, "requestId");
	const runId = str(args, "runId");
	const inboxId = str(args, "inboxId");
	const mockId = str(args, "mockId");
	// Rides the `run` event alone: that a run started is a fact about the run
	// family, and `run_collection`'s other entity is the cookie jar, which has no
	// use for it.
	const startedRun = STARTED_RUNS.get(result);
	for (const entity of tool.invalidates) {
		try {
			ctx.onDataChanged({
				entity,
				...(collectionId !== undefined ? { collectionId } : {}),
				...(requestId !== undefined ? { requestId } : {}),
				...(runId !== undefined ? { runId } : {}),
				...(inboxId !== undefined ? { inboxId } : {}),
				...(mockId !== undefined ? { mockId } : {}),
				...(entity === "run" && startedRun !== undefined ? { startedRun } : {}),
			});
		} catch (err) {
			ctx.log?.warn("mcp", `Failed to notify "${entity}" change`, {
				tool: tool.name,
				error: String(err),
			});
		}
	}
}
