/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file reads.tools.ts
 * @brief The registry's opening reads: engine health, the collection, request,
 *        environment and run lists, the stored-run reads and the engine config.
 */

import { z } from "zod";
import { DEFAULT_RUN_PAGE_LIMIT, MAX_ENGINE_PAGE_LIMIT } from "../engine-client.js";
import {
	RUN_ERROR_DEFINITION_POINTER,
	RUN_ERROR_DEFINITION_SENTENCE,
} from "../error-definition.js";
import { precedenceNote } from "../variable-origins.js";
import {
	DATA_CONTRACT_SENTENCE,
	presentCollections,
	withCurrentDataFileHashes,
} from "../collection-shape.js";
import {
	runOutputShape,
	secretsShape,
	withheldPointer,
	withholdConfigCredentials,
	withholdRowListSecrets,
	withholdRowSecrets,
} from "../withhold.js";
import type { McpTool, ToolContext } from "./contract.js";
import {
	callEngine,
	callEngineForRunOutput,
	callEngineStructured,
	engineErrorResult,
	errorResult,
	isRecord,
	optionalOffset,
	optionalPageLimit,
	requireStr,
	structuredResult,
} from "./kit.js";
import { ID_KINDS } from "./failure.js";
import {
	boundRunReport,
	MAX_INLINE_BODY_BYTES,
	MAX_REPORT_TRACE_BYTES,
} from "./inline-body-bounds.js";
import {
	DEFAULT_RUN_SAMPLE_LIMIT,
	DEFAULT_RUN_SERIES_LIMIT,
	MAX_RUN_SERIES_LIMIT,
	PAGE_CURSOR_SENTENCE,
	pagedRead,
	RUN_STATUSES,
	RUN_TYPES,
	runListQuery,
} from "./run-housekeeping.js";
import { markPartialReport, projectRunStatus } from "./run-status.js";
import {
	fieldsInput,
	listPageInputs,
	listPageQuery,
	listPageSentence,
	mapPageRows,
	projectPageRows,
	wantsFullRows,
} from "./list-page.js";
import {
	appFocusSchema,
	collectionPageSchema,
	engineConfigSchema,
	engineHealthSchema,
	isEngineHealthShape,
	requestPageSchema,
	requestRowSchema,
	runPageSchema,
	runReportSchema,
	runSamplePageSchema,
	runSeriesPageSchema,
	runStatusSchema,
} from "./output-schemas.js";

/** What a `list_requests` summary row keeps of the stored request. */
const REQUEST_SUMMARY_KEYS = [
	"id",
	"collectionId",
	"name",
	"method",
	"url",
	"order",
	"updatedAt",
] as const;

/** What a `list_collections` summary row keeps: no variables, auth or data contract. */
const COLLECTION_SUMMARY_KEYS = ["id", "name", "parentId", "order"] as const;

/** A paged list of stored rows, each withheld as {@link withholdRowSecrets} withholds one. */
function withholdRowPage(page: unknown): unknown {
	return mapPageRows(page, withholdRowSecrets);
}

/**
 * A page of collections presented as `vayu://collections` presents the whole
 * list, `dataFile.hash` read from the file as it is now. Full rows only: the
 * summary drops what this adds, so it would hash every data file for nothing.
 */
async function presentCollectionPage(page: unknown, ctx: ToolContext): Promise<unknown> {
	if (!isRecord(page) || !Array.isArray(page.data)) return page;
	const data = await withCurrentDataFileHashes(presentCollections(page.data, ctx), ctx);
	return { ...page, data };
}

export const READ_TOOLS: McpTool[] = [
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
				return engineErrorResult(err, ctx);
			}
		},
	},
	{
		name: "get_app_focus",
		category: "read",
		invalidates: [],
		description:
			'Which tab and environment the user has open in the Vayu window right now, for "this request", "the run I have open" or "my current environment". Returns `activeTab` (`type`, `entityId`, `label`; `entityId` is the request, collection, run, inbox or mock server id by `type`, null for a tab with no entity), `run` (`{ runId }`, set only when the open tab is a run) and `activeEnvironment` (`id`, `name`); each is null when nothing of that kind is open. Names and ids only, never a variable value: read the entity with its own tool (get_request for a request). A `label` is a saved name or a kind word such as "Request", never text taken from a URL. The copy is the app window\'s last report, so it can lag a click by a moment. An error saying the Vayu window is not connected means there is no app window to ask - the standalone stdio server has none, and the app may not be open yet - so ask the user for a Vayu reference line instead.',
		annotations: {
			title: "Get the app's open tab and environment",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		outputSchema: appFocusSchema,
		handler: async (_args, ctx) => {
			const focus = ctx.appFocus?.();
			if (!focus) {
				return errorResult(
					"The Vayu window is not connected, so there is no open tab or environment to report. " +
						"Ask the user for a Vayu reference line instead.",
					"policy"
				);
			}
			const { activeTab, activeEnvironment } = focus;
			const runId = activeTab?.type === "run" ? activeTab.entityId : null;
			return structuredResult({
				activeTab,
				run: runId === null ? null : { runId },
				activeEnvironment,
			});
		},
	},
	{
		name: "list_collections",
		category: "read",
		invalidates: [],
		description: (config) =>
			`List request collections (folders that organize saved requests). ${listPageSentence("collections", "name")} Each row is a summary (${COLLECTION_SUMMARY_KEYS.join(", ")}); \`fields: "full"\` returns whole rows, adding the collection's own \`variables\` blob and \`auth\` block (a request resolves against the whole chain from the root down) and the data-file fields below. ` +
			DATA_CONTRACT_SENTENCE +
			" " +
			precedenceNote(
				"Collection variables sit between globals and the active environment, and a nested collection outranks its ancestors."
			) +
			" " +
			PAGE_CURSOR_SENTENCE +
			withheldPointer(config),
		annotations: {
			title: "List collections",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: { ...listPageInputs("collections"), fields: fieldsInput },
		outputSchema: collectionPageSchema,
		handler: (args, ctx, signal) => {
			const query = listPageQuery(args);
			const full = wantsFullRows(args);
			return pagedRead(
				ctx,
				async () => {
					const page = await ctx.client.listCollectionsPage(query, signal);
					return full ? presentCollectionPage(page, ctx) : page;
				},
				"collections",
				(page) => {
					const withheld = secretsShape(ctx, withholdRowPage)(page);
					return full ? withheld : projectPageRows(withheld, COLLECTION_SUMMARY_KEYS);
				}
			);
		},
	},
	{
		name: "list_requests",
		category: "read",
		invalidates: [],
		description: (config) =>
			`List the saved requests directly inside one collection. ${listPageSentence("requests", "name")} Each row is a summary (${REQUEST_SUMMARY_KEYS.join(", ")}); \`fields: "full"\` returns each whole stored request (headers, params, body, auth, elements...); get_request reads one. In a full row a stored column the engine cannot hand back - one that will not parse, or one past its 10 MB field cap - comes back as an empty value rather than failing the row. A sub-collection's requests are not included; list them by calling this again with the sub-collection id that list_collections returns. A stored request that cannot be serialized is omitted and not counted, so a short list is not proof the collection is small. ` +
			PAGE_CURSOR_SENTENCE +
			withheldPointer(config),
		annotations: {
			title: "List requests",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z.string().describe("Collection ID to list."),
			...listPageInputs("requests"),
			fields: fieldsInput,
		},
		outputSchema: requestPageSchema,
		handler: (args, ctx, signal) => {
			const collectionId = requireStr(args, "collectionId");
			const query = listPageQuery(args);
			const full = wantsFullRows(args);
			return pagedRead(
				ctx,
				() => ctx.client.listRequestsPage(collectionId, query, signal),
				"requests",
				(page) => {
					// Withheld whole, then projected: the url's masking reads the row's auth.
					const withheld = secretsShape(ctx, withholdRowPage)(page);
					return full ? withheld : projectPageRows(withheld, REQUEST_SUMMARY_KEYS);
				}
			);
		},
	},
	{
		name: "get_request",
		category: "read",
		invalidates: [],
		notFound: { ...ID_KINDS.request, idArg: "requestId" },
		description: (config) =>
			'Read one saved request by its id, the (req_...) of a Vayu reference line, without walking list_collections and list_requests. The row is the *whole* stored request, the shape list_requests returns with `fields: "full"`. An id that names no saved request is an error naming the id and list_requests.' +
			withheldPointer(config),
		annotations: {
			title: "Get a request",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			requestId: z
				.string()
				.describe("Saved request ID, the (req_...) of a Vayu reference line."),
		},
		outputSchema: requestRowSchema,
		handler: (args, ctx, signal) =>
			callEngineStructured(
				ctx,
				() => ctx.client.getRequest(requireStr(args, "requestId"), signal),
				secretsShape(ctx, withholdRowSecrets)
			),
	},
	{
		name: "list_environments",
		category: "read",
		invalidates: [],
		description: (config) =>
			"List all environments (named sets of variables like baseUrl, apiKey). The row with `isActive: true` is the one requests resolve against when a call names no environmentId. " +
			precedenceNote(
				"An environment's variables are the top scope tier: they shadow every collection and global of the same name."
			) +
			withheldPointer(config),
		annotations: {
			title: "List environments",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		handler: (_args, ctx, signal) =>
			callEngine(
				ctx,
				() => ctx.client.listEnvironments(signal),
				secretsShape(ctx, withholdRowListSecrets)
			),
	},
	{
		name: "list_runs",
		category: "read",
		invalidates: [],
		description: (config) =>
			"List past runs (single Design-mode requests, collection runs and load tests), " +
			`newest first - the only order the engine lists in. Returns a {data, pagination} envelope of at most ${DEFAULT_RUN_PAGE_LIMIT} runs by default (${MAX_ENGINE_PAGE_LIMIT} max); each row carries a compact summary (requestName/url/method/mode/duration/concurrency/comment), not the full config snapshot. A finished load test's row also carries \`resultSummary\` {rps, p95Ms, errorRate, verdict}: errorRate is a percentage 0-100 over HTTP responses, verdict is "passed" or "failed" and absent when the run declared no budgets, and any key the run did not record is absent. A capacity run also carries \`capacity\` {stopReason, maxHealthyConcurrency, kneeConcurrency}: the levels the search held and gave out at, either absent when the search found none, and its rps, p95Ms and errorRate average every level. A scenario load run that made an exact assertion (assert.*, required extract.*, inline pm.test) also carries \`assertionsPassed\` and \`assertionsFailed\`, never folded into errorRate (a run of 200s that failed them reads errorRate 0); both are omitted for every other run; a design run's row carries {statusCode, latencyMs} there instead. verdict is the stored budget verdict even for a stopped run, whose partial data the app shows as "Not judged", and errorRate uses the same failure definition as the report's summary.errorRate, over the stored status-code distribution, and is absent when no distribution is stored. A data-driven run's summary names the file its rows came from, never its path: \`dataFileName\`, \`dataFileHash\` (SHA-256 of its bytes) and \`dataFileCastNumbers\` (true only when the file was read with 'Read numbers as numbers') on a single-request run, \`summary.scenario.dataFileName\` / \`dataFileHash\` / \`dataFileCastNumbers\` on a collection run - compare the hash with \`dataFile.hash\` in a full list_collections row before re-running with the same file. ` +
			"Filter to find a specific run instead of paging blocks of history: by saved request, by collection (collection runs only - a design or load run stores none), by type, by status, by text over the stored config, or to pinned baselines only. " +
			"`pagination.total` and `hasMore` describe the filtered set, so a filtered page says how much more of that filter there is. " +
			PAGE_CURSOR_SENTENCE +
			withheldPointer(config, "recorded"),
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
		outputSchema: runPageSchema,
		handler: async (args, ctx, signal) => {
			// Built before the call, not inside it: an argument the caller got
			// wrong must reach dispatch as a ToolArgError - inside `pagedRead`'s
			// try it would be reported as an engine failure.
			const query = runListQuery(args);
			return pagedRead(
				ctx,
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
		notFound: { ...ID_KINDS.run, idArg: "runId" },
		description: (config) =>
			"Get the report for a run; a run still in progress returns a partial report marked `partial: true`. A finished run's report carries summary, latency percentiles (p50/p95/p99), status codes, errors, and timing breakdown - ideal input for analyzing performance. `metadata.status` is the run's state; while it is `pending` or `running`, the report also carries `partial: true` and a `note`, `summary` holds what has accumulated so far, no budget verdict exists yet, and the zeros are not results. Both keys are absent for a finished run. Read get_run(runId) for whether it is done. " +
			"A failed load run may carry `summary.partial: true` (the engine stopped before saving the final totals: the counts, `errorRate`, `statusCodes`, `avgRps`, duration and bytes are the last saved figures, a floor under the real totals, while `latency` is all zeros and `peakConcurrency` and `avgQueueWaitMs` are 0, none recorded) or `summary.summaryMissing: true` (no summary was saved, so the counts are not whole-run totals); both are absent otherwise, never false, and neither is the top-level `partial`, which means the run is still going. " +
			`${RUN_ERROR_DEFINITION_SENTENCE} ` +
			"A run may also carry `warnings`, even when it finished and its numbers look fine: a request sent with an unresolved `{{token}}`, a step whose pre-request script load mode never runs, a raised per-host connection limit, or requests re-sent on a new connection after the server dropped a reused one. Each entry carries `code`, a human-readable `message`, and its code's counts. Absent for a run with nothing to report. " +
			"`slowRequests.count` is the exact number of completions past the threshold; `slowRequests.tracesStored` is how many were kept as sample traces, so it can be smaller than `count`. " +
			"A run of a collection bound to an OpenAPI document also carries `coverage`: which of the contract's operations the run exercised, which of their declared responses it saw, and any statuses the document never declared. Absent - never zeros - for a run that was not measured against a contract. " +
			"`results` is a selection of the stored rows, not a uniform sample: at most 100 for a single-request run, every stored step for a scenario run. When the run stored more than the cap, rows with a failing status (outside 2xx/3xx, including status 0 for no response) are chosen first, successes fill the remainder, and the chosen rows are listed in time order. `resultsStored` is how many rows the run stored and `resultsCap` the cap applied; `resultsStored > resultsCap` is the only sign that `results` is a selection. Absent on an older engine. " +
			`Stored bodies on each row's trace (request and response) are capped at ${MAX_INLINE_BODY_BYTES} bytes for this result: a capped one carries \`bodyTruncated: true\` beside \`bodyBytes\`, the full size, and a capped \`rawRequest\` carries \`rawRequestTruncated\`. A body in full is still available in Vayu's own run history. A response node with \`bodyEncoding: "base64"\` holds a body that is not UTF-8 text as standard base64 in \`body\`: decode it, never read it as text; its cap and \`bodyBytes\` count decoded bytes, and a cut keeps whole 4-character groups. Without the key the body is text. ` +
			`The traces together are capped at ${MAX_REPORT_TRACE_BYTES} bytes, since a multi-step run's rows add up past any per-body cap: rows beyond the budget keep every scalar (status, latency, step identity) and carry \`traceOmitted: true\` instead of their trace, with \`tracesOmitted\` and \`traceBudgetBytes\` on the report saying how many. Non-passing steps keep their traces first, matching the engine's own rule for \`stepsStored\`, so a failure is the last thing dropped. An omitted row's trace is still in Vayu's own run history.` +
			withheldPointer(config, "recorded"),
		annotations: {
			title: "Get run report",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: { runId: z.string().describe("Run ID to fetch.") },
		outputSchema: runReportSchema,
		handler: (args, ctx, signal) => {
			const runId = requireStr(args, "runId");
			return callEngineForRunOutput(ctx, () => ctx.client.getRunReport(runId, signal), {
				bound: (report) => markPartialReport(boundRunReport(report)),
				structured: true,
				signal,
			});
		},
	},
	{
		name: "get_run",
		category: "read",
		invalidates: [],
		notFound: { ...ID_KINDS.run, idArg: "runId" },
		description: (config) =>
			"Read a run's state: whether it is still going, how far along it is, and what to do next. Returns `id`, `type`, `status` (pending, running, completed, failed or stopped), `terminal` (true once the status is completed, failed or stopped), `startTime`, `endTime` (null while the run is not terminal), `elapsedMs`, `mode`, `concurrency`, `targetRps`, `duration`, `requestId`, `baseline` and `nextStep`. A duration-bound run also carries `plannedDurationMs` and `progress` (0 to 1, elapsed over planned); both are null for an iterations run, a design run or a duration that does not parse, never an estimate. `nextStep` names the poll interval for a run in progress. A stopped run carries no budget verdict. Cheap enough to poll: it never carries the trace, results or the rest of the stored config - get_run_report has those. An id that names no run is an error naming it." +
			withheldPointer(config, "recorded"),
		annotations: {
			title: "Get run status",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: { runId: z.string().describe("Run ID to read, as a start tool returned it.") },
		outputSchema: runStatusSchema,
		handler: (args, ctx, signal) => {
			const runId = requireStr(args, "runId");
			return callEngineForRunOutput(ctx, () => ctx.client.getRun(runId, signal), {
				bound: (row) => projectRunStatus(row),
				structured: true,
				signal,
			});
		},
	},
	{
		name: "get_run_samples",
		category: "read",
		invalidates: [],
		notFound: { ...ID_KINDS.run, idArg: "runId" },
		description: (config) =>
			"Get the response samples a load run captured - the actual headers and bodies of individual exchanges, which the report's aggregates do not carry. A load run keeps 1 in 100 responses, up to 1000 per run, unless `start_load_run` set `responseSamplePeriod` (1 keeps every response) or `maxResponseSamples` (0 keeps none); a run that captured nothing returns an empty page, not an error. " +
			`Each sample carries \`resultId\`, so it joins against the report's \`results[].id\`. A binary body is reported as \`binary: true\` rather than as text, and a body the engine cut at its own capture cap carries \`bodyTruncated\`. BOUNDED: ${DEFAULT_RUN_SAMPLE_LIMIT} samples per call by default, ${MAX_ENGINE_PAGE_LIMIT} at most - a larger \`limit\` is refused, not clamped. ` +
			PAGE_CURSOR_SENTENCE +
			withheldPointer(config, "recorded"),
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
		outputSchema: runSamplePageSchema,
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
				ctx,
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
		notFound: { ...ID_KINDS.run, idArg: "runId" },
		description:
			"Get a completed run's per-tick time series: RPS, latency percentiles, error rate and status mix, one row per tick, oldest first. This is the stored history the app's charts are drawn from - use it to see how a run behaved over time, where get_run_report gives the totals and get_live_metrics the last few ticks of a run still going. A run with no ticks (a design run, or a load run that never started) returns an empty page, not an error. A tick's latency_p50_ms / latency_p95_ms / latency_p99_ms cover its second, and are absent from a second in which nothing completed: a stall, not a 0 ms answer. A run stored by an older engine has 0 there instead. A tick's status_seconds, [{second, span, counts: [2xx, 3xx, 4xx, 5xx, error]}], is the responses that completed in the seconds that tick closed, second counted from load start; counts / span is responses per second, and [] means it closed none. A tick stored before the field existed has none. " +
			`${RUN_ERROR_DEFINITION_POINTER} ` +
			`BOUNDED: ${DEFAULT_RUN_SERIES_LIMIT} ticks per call by default, ${MAX_RUN_SERIES_LIMIT} at most - a larger \`limit\` is refused, not clamped, and the engine's own 5000-row default is far past what a tool result can carry. ` +
			PAGE_CURSOR_SENTENCE,
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
		outputSchema: runSeriesPageSchema,
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
				ctx,
				() => ctx.client.getRunTimeSeries(runId, limit, offset, signal),
				"ticks"
			);
		},
	},
	{
		name: "get_run_monitor",
		category: "read",
		invalidates: [],
		notFound: { ...ID_KINDS.run, idArg: "runId" },
		description:
			"Get the server vitals scraped during a run - the target's own CPU, memory and load, sampled on the monitor's cadence rather than the tick cadence, so these rows do not line up with get_run_timeseries row for row. Answers 'was the target saturated?' beside the client-side latency the report shows. Only a run started with a `monitor` block has any; any other run returns an empty page, not an error. " +
			`BOUNDED the same way as get_run_timeseries: ${DEFAULT_RUN_SERIES_LIMIT} samples by default, ${MAX_RUN_SERIES_LIMIT} at most, refused above that. ` +
			PAGE_CURSOR_SENTENCE,
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
		outputSchema: runSeriesPageSchema,
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
				ctx,
				() => ctx.client.getRunMonitorSeries(runId, limit, offset, signal),
				"monitor samples"
			);
		},
	},
	{
		name: "get_engine_config",
		category: "read",
		invalidates: [],
		description: (config) =>
			"Get the engine's tunable configuration entries (workers, timeouts, connection limits, buffer sizes, etc.), each with its current value, default, type, and allowed range. Read this before update_engine_config rather than assuming a key exists or what it accepts - the ranges here are what that call validates against. The values are what the engine has saved, which is not always what it is running: a key changed since the last restart reads as its new value here while the running engine still uses the old one." +
			withheldPointer(config),
		annotations: {
			title: "Get engine config",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		outputSchema: engineConfigSchema,
		handler: (_args, ctx, signal) =>
			callEngineStructured(
				ctx,
				() => ctx.client.getConfig(signal),
				secretsShape(ctx, withholdConfigCredentials)
			),
	},
];
