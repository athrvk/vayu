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
import { RUN_ERROR_DEFINITION_SENTENCE } from "../error-definition.js";
import { runOutputShape, WITHHELD_RUN_OUTPUT_SENTENCE } from "../withhold.js";
import type { McpTool } from "./contract.js";
import {
	callEngine,
	callEngineForRunOutput,
	confirmDestructive,
	confirmedInput,
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
import { describeRun, resolveBaseline } from "./run-housekeeping.js";
import { runComparisonSchema } from "./output-schemas.js";

export const RUN_TOOLS: McpTool[] = [
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
			"Get a snapshot of the most recent live metrics ticks for a run (RPS, latency percentiles, error rate, status mix). Returns the last N ticks; does not stream. " +
			RUN_ERROR_DEFINITION_SENTENCE,
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
			"Compare two completed runs and return the deltas in latency percentiles, throughput, error rate, and status-code mix, each labelled with which direction is an improvement. Use to answer 'did this change regress performance?'. Omit baseRunId to compare against the run pinned as the baseline for the same saved request. Read comparability before the deltas: each entry (code, message, base, target) is a way the two runs were not the same experiment - mode, virtual users, target rate, duration (more than 2x apart), status (a stopped run against a completed one), HTTP version, data file, request, or compression negotiation. An empty list means like for like. When it is not empty, say so before calling anything a regression: a short stopped run always looks slower and lower-throughput than a long one. compressionNegotiationDiffers is the compression entry on its own. " +
			RUN_ERROR_DEFINITION_SENTENCE,
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
];
