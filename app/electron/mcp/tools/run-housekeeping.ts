/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file run-housekeeping.ts
 * @brief Reading runs back: the `list_runs` filters, the page bounds of the
 *        per-run reads, the delete prompts' wording, baseline resolution and
 *        the run-type refusal `compare_runs` shares with its prompt.
 */

import {
	DEFAULT_RUN_PAGE_LIMIT,
	MAX_ENGINE_PAGE_LIMIT,
	type RunListQuery,
} from "../engine-client.js";
import type { RunComparison } from "../compare.js";
import type { ToolContext, ToolResult } from "./contract.js";
import {
	engineErrorResult,
	isRecord,
	jsonResult,
	optionalOffset,
	optionalPageLimit,
	str,
	ToolArgError,
	withCaveat,
} from "./kit.js";

/**
 * Run types and statuses `list_runs` filters on, spelled as the engine parses
 * them (`parse_run_type` / `parse_run_status`, engine `types.hpp`) and matching
 * the renderer's own `Run` union in `app/src/types/domain.ts`.
 *
 * Restated here rather than imported because `electron/` shares no module graph
 * with `app/src/` - the same reason `HTTP_VERSIONS` has its own copy. Declared
 * as Zod enums so an unrecognised value is a refusal: `GET /runs` *ignores* a
 * filter it cannot parse, so a typo would otherwise answer the unfiltered page
 * and read as "nothing matched anywhere".
 */
export const RUN_TYPES = ["design", "load", "scenario"] as const;
export const RUN_STATUSES = ["pending", "running", "completed", "failed", "stopped"] as const;

/**
 * Default page for `get_run_samples` - small, because a sample carries a real
 * response body (bounded engine-side by `maxSampleBodyBytes`) and 500 of them is
 * a context window, not a page. The engine's own default here is 50.
 */
export const DEFAULT_RUN_SAMPLE_LIMIT = 25;

/**
 * Default and ceiling for the two per-tick series reads.
 *
 * The engine defaults these to 5000 rows and caps them at 50000 - sized for the
 * dashboard's charts, which draw every point and show a human the shape. An
 * agent reads them as JSON through a context window, so both are far past what
 * a tool result can carry, and the #319 lesson (`get_live_metrics` returning
 * whatever a run had accumulated) is that the bound belongs on this side of the
 * boundary. Refused rather than clamped, so an agent asking for more is told.
 */
export const DEFAULT_RUN_SERIES_LIMIT = 100;
export const MAX_RUN_SERIES_LIMIT = 1_000;

/**
 * What a bounded page did *not* return, in words.
 *
 * The `{data, pagination}` envelope already carries `total` and `hasMore`, but a
 * bound an agent has to reconstruct from two numbers is one it can miss - the
 * same disclose-in-band rule the smoke matrix and the report's trace budget
 * follow. Empty when the page is the whole answer: a caveat on a complete read
 * is noise that teaches an agent to skip the caveats that matter.
 */
function pageCaveat(value: unknown, noun: string): string {
	if (!isRecord(value)) return "";
	const pagination = value.pagination;
	if (!isRecord(pagination) || pagination.hasMore !== true) return "";
	const offset = typeof pagination.offset === "number" ? pagination.offset : 0;
	const returned = typeof pagination.returned === "number" ? pagination.returned : 0;
	const total = typeof pagination.total === "number" ? String(pagination.total) : "more";
	return (
		`\n\nBounded read: ${returned} of ${total} ${noun}, starting at offset ${offset}. ` +
		`Read the next page with offset: ${offset + returned}.`
	);
}

/**
 * A run named in words, for the prompt that asks a human to delete it.
 *
 * The same rule `delete_request` follows: a confirmation carrying only an opaque
 * id is not one a person can answer. Every part is optional because a run row is
 * only as descriptive as the snapshot it stored - a malformed one serializes to
 * an empty summary engine-side rather than failing - so this degrades to the id
 * instead of printing "undefined".
 */
export function describeRun(runId: string, run: Record<string, unknown>): string {
	const snapshot = isRecord(run.configSnapshot) ? run.configSnapshot : {};
	const kind = typeof run.type === "string" && run.type !== "" ? `${run.type} run` : "run";
	const parts: string[] = [];
	if (typeof snapshot.url === "string" && snapshot.url !== "") parts.push(snapshot.url);
	if (typeof snapshot.comment === "string" && snapshot.comment !== "") {
		parts.push(`"${snapshot.comment}"`);
	}
	if (typeof run.status === "string" && run.status !== "") parts.push(run.status);
	// `startTime` is epoch milliseconds (engine `Run::start_time`, an int64), so
	// it is rendered rather than printed - a human confirming a delete cannot
	// read 1755454800000 as "this morning".
	if (typeof run.startTime === "number" && Number.isFinite(run.startTime) && run.startTime > 0) {
		parts.push(`started ${new Date(run.startTime).toISOString()}`);
	}
	if (run.baseline === true) parts.push("pinned as a baseline");
	return parts.length > 0 ? `the ${kind} ${runId} (${parts.join(", ")})` : `the ${kind} ${runId}`;
}

/**
 * A webhook inbox named in words, for the prompt that asks a human to delete it.
 *
 * The capture count is the part that has to be there: a stopped inbox holding
 * 40 recorded webhooks and one holding none are the same call with very
 * different consequences, and only this sentence tells them apart. It is stated
 * even at zero, because "captures 0 requests" is the reassurance that makes the
 * prompt answerable - an absent count reads as unknown, not as none.
 */
export function describeInbox(inboxId: string, inbox: Record<string, unknown>): string {
	const parts: string[] = [];
	if (typeof inbox.url === "string" && inbox.url !== "") parts.push(inbox.url);
	parts.push(inbox.running === true ? "running" : "stopped");
	const captures = typeof inbox.captureCount === "number" ? inbox.captureCount : 0;
	parts.push(`${captures} captured request${captures === 1 ? "" : "s"}`);
	return `the webhook inbox ${inboxId} (${parts.join(", ")})`;
}

/**
 * The `GET /runs` query a `list_runs` call describes.
 *
 * Only the filters the caller actually stated travel. An omitted one must not
 * reach the URL as `type=undefined`: the engine ignores a filter it cannot
 * parse, so that spelling happens to behave like "unfiltered" today - by way of
 * the same rule that silently swallows a typo. Sending nothing is the honest
 * form, and leaves the schema as the only thing rejecting a bad value.
 */
export function runListQuery(args: Record<string, unknown>): RunListQuery {
	const query: RunListQuery = {
		limit: optionalPageLimit(args, "limit", DEFAULT_RUN_PAGE_LIMIT, MAX_ENGINE_PAGE_LIMIT),
		offset: optionalOffset(args, "offset"),
	};
	for (const key of ["type", "status", "requestId", "collectionId", "q"] as const) {
		const value = str(args, key);
		if (value !== undefined) query[key] = value;
	}
	if (typeof args.baseline === "boolean") query.baseline = args.baseline;
	return query;
}

/**
 * A paginated engine read whose result says what it left behind.
 * {@link callEngine} with a `shape` cannot do this: the caveat is text beside
 * the JSON, not a rewrite of it.
 *
 * `shape` is the same seam {@link callEngine} offers, and it runs before the
 * caveat is computed - a page whose rows carry bodies is bounded here, and the
 * caveat still describes the page the engine answered rather than the cut one
 * (it reads `pagination`, which a body bound does not touch).
 */
export async function pagedRead(
	ctx: ToolContext,
	fn: () => Promise<unknown>,
	noun: string,
	shape?: (value: unknown) => unknown
): Promise<ToolResult> {
	let answer: unknown;
	try {
		answer = await fn();
	} catch (err) {
		return engineErrorResult(err, ctx);
	}
	const caveat = pageCaveat(answer, noun);
	return withCaveat(jsonResult(shape ? shape(answer) : answer), caveat);
}

/**
 * The run pinned as baseline for whatever saved request @p targetRunId ran -
 * `compare_runs`'s answer when the caller named no base, tool and prompt alike:
 * the prompt asked for both ids while the tool resolved one, so the same
 * question reached the agent two ways (issue #760). Exported for the prompt
 * rather than copied into it, since a second resolution rule would be a second
 * definition of "the baseline".
 *
 * Resolution is the engine's, not a scan here: `GET /runs?baseline=true&
 * requestId=...` is ordered newest-first, so "the baseline" is its first row.
 * That is the same question the history view's vs-baseline strip asks, so an
 * agent and the UI compare a run against the same pin.
 *
 * Every way this can fail to find one throws a message naming the fix, because
 * the alternative - silently comparing against some other run - is a wrong
 * answer presented as a right one. A run that has no saved request behind it
 * (an ad-hoc load run) has nothing to resolve *through*, which is a different
 * problem from a request with no pin, and says so.
 */
export async function resolveBaseline(
	targetRunId: string,
	ctx: ToolContext,
	signal?: AbortSignal
): Promise<string> {
	const run = (await ctx.client.getRun(targetRunId, signal)) as Record<string, unknown> | null;
	const requestId = run && typeof run.requestId === "string" ? run.requestId : null;
	if (!requestId) {
		throw new ToolArgError(
			`Run ${targetRunId} did not run a saved request, so it has no baseline to resolve. ` +
				`Pass "baseRunId" explicitly.`
		);
	}

	const page = (await ctx.client.listBaselineRuns(requestId, signal)) as {
		data?: Array<Record<string, unknown>>;
	} | null;
	const baseline = page?.data?.[0];
	const baseRunId = baseline && typeof baseline.id === "string" ? baseline.id : null;
	if (!baseRunId) {
		throw new ToolArgError(
			`No run is pinned as the baseline for request ${requestId}. Pin one in Vayu's ` +
				`history sidebar, or pass "baseRunId" explicitly.`
		);
	}
	if (baseRunId === targetRunId) {
		throw new ToolArgError(
			`Run ${targetRunId} is itself the baseline for request ${requestId}; there is ` +
				`nothing to compare it against. Pass "baseRunId" to compare it with another run.`
		);
	}
	return baseRunId;
}

/**
 * Why @p comparison must not be answered with its deltas, or `null` when it
 * can be (#2438). Runs of different types measure different things, so a load
 * test's throughput against a collection run's is not a regression either way.
 * Shared by the `compare_runs` tool and prompt so neither hands a model deltas
 * the other refuses. `compareReports` itself keeps the `run_type` entry: the
 * History strip and the run-report export show it rather than refusing.
 */
export function runTypeRefusal(comparison: RunComparison): string | null {
	const mismatch = comparison.comparability.find((entry) => entry.code === "run_type");
	if (!mismatch) return null;
	return (
		`Run ${comparison.baseRunId} (${mismatch.base}) and run ${comparison.targetRunId} ` +
		`(${mismatch.target}) are different types of run, whose figures measure different ` +
		`things, so they were not compared. Compare runs of the same type; list_runs takes a ` +
		`"type" filter (${RUN_TYPES.map((type) => `"${type}"`).join(", ")}).`
	);
}
