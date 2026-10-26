/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file runs.tools.ts
 * @brief Acting on runs: stop, baseline, delete, live metrics and comparison. The
 *        stored-run reads sit with the other reads in `reads.tools.ts`.
 */

import { z } from "zod";
import { EngineRequestError } from "../engine-client.js";
import { compareReports } from "../compare.js";
import { RUN_ERROR_DEFINITION_POINTER } from "../error-definition.js";
import { defaultMcpExportFormat, MCP_EXPORT_FORMAT_IDS } from "../run-export-formats.js";
import { runOutputShape, withheldPointer } from "../withhold.js";
import type { McpTool } from "./contract.js";
import {
	callEngine,
	callEngineForRunOutput,
	callEngineForRunText,
	confirmDestructive,
	confirmedInput,
	bool,
	engineErrorResult,
	errorResult,
	isRecord,
	jsonResult,
	optionalPositiveInt,
	requireStr,
	str,
	structuredResult,
	ToolArgError,
	writesDisabled,
} from "./kit.js";
import { ID_KINDS, unknownIdText } from "./failure.js";
import { describeRun, resolveBaseline, runTypeRefusal } from "./run-housekeeping.js";
import { runComparisonSchema } from "./output-schemas.js";
import { GUARDED_WRITE_SENTENCE } from "../remedy.js";

/** The Export menu's HTML report: a file for a person, which an agent can neither save nor use. */
const HTML_FORMAT = "html";

const EXPORT_FORMAT_CHOICES: [string, ...string[]] = [HTML_FORMAT, ...MCP_EXPORT_FORMAT_IDS];

/** The `format` argument, refusing HTML and anything the engine does not write for an agent. */
function exportFormat(args: Record<string, unknown>): string {
	const format = str(args, "format") ?? defaultMcpExportFormat;
	if (format === HTML_FORMAT) {
		throw new ToolArgError(
			`"html" is not available here: save it from the Export menu in Vayu's History. ` +
				`An agent cannot save a file, and the HTML would cost context for nothing. ` +
				`Use one of: ${MCP_EXPORT_FORMAT_IDS.join(", ")}.`
		);
	}
	if (!MCP_EXPORT_FORMAT_IDS.includes(format)) {
		throw new ToolArgError(
			`"format" must be one of: ${[...MCP_EXPORT_FORMAT_IDS, HTML_FORMAT].join(", ")}.`
		);
	}
	return format;
}

/** The document an export answered with, out of the engine's `{ text, fileName, ... }` envelope. */
function exportedDocument(answer: unknown): string {
	if (!isRecord(answer) || typeof answer.text !== "string") {
		throw new Error("The engine's export answer carried no document text.");
	}
	return answer.text;
}

/**
 * The answer to the engine's `live_expired` 404 (#2779): the run is stored and
 * only its live buffer is gone, which the engine's own sentence and its HTTP
 * path hint do not say in a form an agent can act on. The 60 s is the engine's
 * `liveRetentionMs` default (`run_manager.cpp`), which a user can change.
 */
const LIVE_EXPIRED_TEXT =
	"The live buffer for this run expired (kept 60 s after it ends); the run still exists - read get_run_report(runId).";

export const RUN_TOOLS: McpTool[] = [
	{
		name: "stop_run",
		category: "load",
		invalidates: ["run"],
		notFound: { ...ID_KINDS.run, idArg: "runId" },
		description:
			"Stop a run that is still in progress: a load test, a collection run, or a streaming Design-mode send holding its connection open. The run ends where it is and keeps what it already recorded, so get_run_report and get_run_samples still answer for it. Read the status in the result: a stream or collection run that has not settled within the engine's 5 s budget comes back `running` with a message saying the stop was signalled - not a failure; re-reading the run reports the end state. A collection run's result then carries no `summary`: read get_run_report(runId) for its counts. A run that already finished is not an error: the result reports its status. An unknown run id is an error.",
		annotations: {
			title: "Stop run",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: { runId: z.string().describe("Run ID to stop.") },
		handler: (args, ctx, signal) =>
			callEngine(ctx, () => ctx.client.stopRun(requireStr(args, "runId"), signal)),
	},
	{
		name: "set_run_baseline",
		category: "write",
		invalidates: ["run"],
		notFound: { ...ID_KINDS.run, idArg: "runId" },
		description: (config) =>
			"Pin a run as the baseline for its saved request, or unpin it. The baseline is the known-good run later runs are compared against: once pinned, compare_runs can be called with only `targetRunId` and resolves this run as the base. It is also the one run history retention will not expire. One pin per request - pinning another run moves it. A run of an unsaved request has no request to be the baseline of, so pinning it changes what nothing reads. " +
			GUARDED_WRITE_SENTENCE +
			"." +
			withheldPointer(config, "recorded"),
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
		notFound: { ...ID_KINDS.run, idArg: "runId" },
		description:
			"Delete a run and everything recorded against it - its report, metrics, captured samples and step traces. " +
			GUARDED_WRITE_SENTENCE +
			", and confirmation: if the client supports elicitation the user is prompted with what the run was, otherwise call once for a preview and again with `confirmed: true`. There is no undo, and a run pinned as a baseline is deleted too when named here. A run still executing is stopped first and deleted once its worker has settled; if it does not settle in time nothing is deleted and the call says to retry.",
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
				if (!isRecord(value)) {
					return errorResult(unknownIdText(ID_KINDS.run, runId), "not_found");
				}
				stored = value;
			} catch (err) {
				return engineErrorResult(err, ctx);
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
						`Run ${runId} is still stopping and was NOT deleted. It has been asked to stop - call delete_run again once it reports a terminal status (check with list_runs).`,
						"transient"
					);
				}
				return engineErrorResult(err, ctx);
			}
		},
	},
	{
		name: "get_live_metrics",
		category: "read",
		retry: "safe",
		invalidates: [],
		notFound: { ...ID_KINDS.run, idArg: "runId" },
		notFoundByCode: { live_expired: LIVE_EXPIRED_TEXT },
		description:
			"Get a snapshot of the most recent live metrics ticks for a run (RPS, latency percentiles, error rate, status mix). Returns the last N ticks; does not stream. The live buffer is kept 60 s after a run ends (by default); after that the call is refused as expired, and get_run_report holds the run's numbers. A tick's latencyP50Ms / latencyP95Ms / latencyP99Ms cover its window (about 100 ms) and are null when its latencySamples is 0: nothing completed in it, which is a stall, not a 0 ms answer. A tick that closes a second (about one a second) also carries statusSeconds, [{second, span, counts: [2xx, 3xx, 4xx, 5xx, error]}]: the responses that completed in each second it closed, second counted from load start, and [] when it closed none; the other ticks carry no statusSeconds. For a scenario load run the ticks that carry statusSeconds also carry scenario, {iterations, iterationsCompleted, iterationsAbandoned, stepsExecuted, steps: [{index, name, executed, errors}]}: the sequence so far, without latency. A capacity run's ticks also carry capacity, {level, levelElapsedMs, levelsJudged, stopReason?}: the concurrency being measured and where the search stands, with stopReason once it has ended. " +
			RUN_ERROR_DEFINITION_POINTER,
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
			return callEngine(ctx, () =>
				ctx.client.getLiveMetricsSnapshot(runId, limit, undefined, signal)
			);
		},
	},
	{
		name: "compare_runs",
		category: "read",
		invalidates: [],
		notFound: { ...ID_KINDS.run, idArg: ["baseRunId", "targetRunId"] },
		description:
			"Compare two completed runs and return the deltas in latency percentiles, throughput, error rate, and status-code mix, each labelled with which direction is an improvement. Use to answer 'did this change regress performance?'. Omit baseRunId to compare against the run pinned as the baseline for the same saved request. Two runs of different types (list_runs' type) are refused, not compared. Read comparability before the deltas: each entry (code, message, base, target) is a way the two runs were not the same experiment - run type, mode, virtual users, target rate, duration (more than 2x apart), status (a stopped run against a completed one), HTTP version, data file, request, compression negotiation, or whether Expect: 100-continue was allowed (expect_continue). An empty list means like for like. When it is not empty, say so before calling anything a regression: a short stopped run always looks slower and lower-throughput than a long one. compressionNegotiationDiffers is the compression entry on its own. " +
			RUN_ERROR_DEFINITION_POINTER,
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
				const refusal = runTypeRefusal(comparison);
				if (refusal) return errorResult(refusal, "input");
				return structuredResult(comparison as unknown as Record<string, unknown>);
			} catch (err) {
				// A baseline that could not be resolved is an argument problem the
				// caller can fix, not an engine failure - it must not be reported
				// as one.
				if (err instanceof ToolArgError) return errorResult(err.message, err.failureClass);
				return engineErrorResult(err, ctx);
			}
		},
	},
	{
		name: "export_run_report",
		category: "read",
		invalidates: [],
		notFound: { ...ID_KINDS.run, idArg: ["runId", "baseRunId"] },
		description: (config) =>
			"Export a finished load run as one self-contained document: the same report the Export menu in Vayu's History saves, returned as its text (Markdown as Markdown, JSON as JSON) rather than wrapped in a result object. It holds the run's aggregates (latency percentiles, throughput, error rate, status-code mix), its budgets and their verdicts, the configuration it ran under and, with `baseRunId` or `baseline: true`, a comparison against a second run. It does NOT hold traces, captured samples, per-tick series or request values - call get_run_samples for the samples and get_run_report for the live report data. Not offered for Design-mode or collection-sequence runs, and refused while the run is still executing. The `html` format is the Export menu's alone and is refused here. " +
			RUN_ERROR_DEFINITION_POINTER +
			withheldPointer(config, "recorded"),
		annotations: {
			title: "Export run report",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			runId: z.string().describe("Run ID to export. Must be a finished load run."),
			format: z
				.enum(EXPORT_FORMAT_CHOICES)
				.optional()
				.describe(
					`Document format (default ${defaultMcpExportFormat}). "html" is refused: save it from the Export menu in Vayu's History.`
				),
			baseRunId: z
				.string()
				.optional()
				.describe("Run to compare against: fills the document's comparison section."),
			baseline: z
				.boolean()
				.optional()
				.describe(
					"true compares against the run pinned as baseline for this run's saved request. Not together with baseRunId."
				),
		},
		handler: async (args, ctx, signal) => {
			const runId = requireStr(args, "runId");
			const format = exportFormat(args);
			if (str(args, "baseRunId") && bool(args, "baseline")) {
				throw new ToolArgError('Pass "baseRunId" or "baseline", not both.');
			}
			let baseRunId = str(args, "baseRunId");
			if (bool(args, "baseline")) {
				try {
					baseRunId = await resolveBaseline(runId, ctx, signal);
				} catch (err) {
					if (err instanceof ToolArgError)
						return errorResult(err.message, err.failureClass);
					return engineErrorResult(err, ctx);
				}
			}
			return callEngineForRunText(
				ctx,
				async () =>
					exportedDocument(
						await ctx.client.exportRunReport(
							runId,
							{ format, series: "none", baseRunId },
							signal
						)
					),
				{ signal }
			);
		},
	},
];
