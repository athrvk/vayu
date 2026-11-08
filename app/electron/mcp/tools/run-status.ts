/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file run-status.ts
 * @brief Whether a run is still going: the `get_run` projection, the partial
 *        marker on a report read mid-run and the `nextStep` the start tools hand
 *        back (#2436).
 */

import { parseDurationSeconds } from "../safety.js";
import type { LoadShape } from "./compose.js";
import type { ToolResult } from "./contract.js";
import { isRecord, jsonResult, structuredResult } from "./kit.js";
import { RUN_STATUSES } from "./run-housekeeping.js";

type RunStatus = (typeof RUN_STATUSES)[number];

/** The statuses after which a run's row and report no longer change. */
const TERMINAL_RUN_STATUSES = [
	"completed",
	"failed",
	"stopped",
] as const satisfies readonly RunStatus[];

const TERMINAL_SET: ReadonlySet<unknown> = new Set(TERMINAL_RUN_STATUSES);

/** Statuses of a run whose numbers are still accumulating: every status that is not terminal. */
const UNFINISHED_RUN_STATUSES = RUN_STATUSES.filter((status) => !TERMINAL_SET.has(status));

const UNFINISHED_SET: ReadonlySet<unknown> = new Set(UNFINISHED_RUN_STATUSES);

export type RunStatusClass = "terminal" | "unfinished" | "unknown";

/**
 * The one reading of a run's status that `get_run` and `get_run_report` share.
 * "unknown" is a status outside `RUN_STATUSES` (or none at all): the engine never
 * emits one today, and both readers treat it as unfinished and say so, so an agent
 * never reads a run it cannot classify as a finished one.
 */
export function classifyRunStatus(status: unknown): RunStatusClass {
	if (TERMINAL_SET.has(status)) return "terminal";
	if (UNFINISHED_SET.has(status)) return "unfinished";
	return "unknown";
}

function orList(items: readonly string[], wrap: (item: string) => string = (item) => item): string {
	const words = items.map(wrap);
	if (words.length < 2) return words.join("");
	return `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
}

const backticked = (item: string): string => `\`${item}\``;

/** "pending, running, completed, failed or stopped", for the tool descriptions. */
export const RUN_STATUS_WORDS = orList(RUN_STATUSES);

/** "completed, failed or stopped". */
export const TERMINAL_STATUS_WORDS = orList(TERMINAL_RUN_STATUSES);

/** "`pending` or `running`". */
export const UNFINISHED_STATUS_WORDS = orList(UNFINISHED_RUN_STATUSES, backticked);

/** How a status the classifier did not recognise is named in a sentence. */
function unrecognisedStatusLabel(status: unknown): string {
	return typeof status === "string" ? JSON.stringify(status) : "missing";
}

const MIN_POLL_SECONDS = 2;
const MAX_POLL_SECONDS = 10;
const FALLBACK_POLL_SECONDS = 5;

/**
 * How often to read a run's status: a tenth of its planned duration, kept
 * between 2 and 10 seconds. An iterations run has no planned length and a
 * duration that does not parse is not worth a guess, so both get the 5 s
 * fallback. Every tool that tells an agent to poll takes the interval from here.
 */
export function runPollSeconds(mode: unknown, duration: unknown): number {
	if (mode === "iterations") return FALLBACK_POLL_SECONDS;
	const seconds = parseConfiguredDuration(duration);
	if (seconds === null) return FALLBACK_POLL_SECONDS;
	return Math.round(Math.min(MAX_POLL_SECONDS, Math.max(MIN_POLL_SECONDS, seconds / 10)));
}

function parseConfiguredDuration(duration: unknown): number | null {
	if (typeof duration !== "string" && typeof duration !== "number") return null;
	return parseDurationSeconds(duration);
}

/**
 * The `nextStep` a start tool returns: which read answers "is it finished", how
 * often to ask, and that the report is only a verdict once the run is terminal.
 */
export function startedRunNextStep(mode: unknown, duration: unknown): string {
	return (
		`Read the run's state with get_run(runId) about every ${runPollSeconds(mode, duration)} s: ` +
		`it is finished when \`terminal\` is true (status ${TERMINAL_STATUS_WORDS}). ` +
		`Read get_run_report(runId) once it is - a report read earlier is partial and carries no ` +
		`budget verdict. stop_run ends the run early.`
	);
}

function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nextStepFor(status: unknown, pollSeconds: number): string {
	const statusClass = classifyRunStatus(status);
	if (statusClass === "unknown") {
		return (
			`status ${unrecognisedStatusLabel(status)} is not one Vayu recognises; treat the run as ` +
			`unfinished: read again in ${pollSeconds} s, or stop_run`
		);
	}
	if (statusClass === "unfinished") {
		return `still running; read again in ${pollSeconds} s, or stop_run`;
	}
	if (status === "completed") return "read get_run_report(runId)";
	if (status === "failed") {
		return "get_run_report has what was recorded before the failure; summary.summaryMissing or summary.partial marks counts that were not fully saved";
	}
	return "get_run_report has the partial numbers; a stopped run carries no verdict";
}

/**
 * `get_run`'s answer from the engine's run row, run through the withhold pass
 * first (a snapshot can carry credentials, so only fields named here leave).
 *
 * `terminal` comes from the status (a status Vayu does not recognise is not
 * terminal and adds `unknownStatus: true`, absent otherwise) and `endTime` is null while the run is going:
 * the engine emits null for a run that has not finished (#2953), and this reads
 * the status first as well, so an engine that predates that still yields null
 * (its stored `endTime` is `startTime` until the run ends). `progress` exists
 * only for a duration-bound run whose duration parses; anywhere else it is null
 * rather than an estimate.
 */
export function projectRunStatus(row: unknown, now: number = Date.now()): unknown {
	if (!isRecord(row)) return row;
	const snapshot = isRecord(row.configSnapshot) ? row.configSnapshot : {};
	const statusClass = classifyRunStatus(row.status);
	const terminal = statusClass === "terminal";
	const startTime = finiteNumber(row.startTime);
	const endTime = terminal ? finiteNumber(row.endTime) : null;
	const reference = terminal ? endTime : now;
	const elapsedMs =
		startTime !== null && reference !== null ? Math.max(0, reference - startTime) : null;

	const plannedSeconds =
		snapshot.mode === "iterations" ? null : parseConfiguredDuration(snapshot.duration);
	const plannedDurationMs = plannedSeconds === null ? null : plannedSeconds * 1000;
	const progress =
		plannedDurationMs === null || elapsedMs === null
			? null
			: Math.min(1, Math.max(0, elapsedMs / plannedDurationMs));

	return {
		id: row.id ?? null,
		type: row.type ?? null,
		status: row.status ?? null,
		terminal,
		...(statusClass === "unknown" ? { unknownStatus: true } : {}),
		startTime,
		endTime,
		elapsedMs,
		plannedDurationMs,
		progress,
		mode: snapshot.mode ?? null,
		concurrency: snapshot.concurrency ?? null,
		targetRps: snapshot.targetRps ?? null,
		duration: snapshot.duration ?? null,
		requestId: row.requestId ?? null,
		baseline: row.baseline ?? null,
		nextStep: nextStepFor(row.status, runPollSeconds(snapshot.mode, snapshot.duration)),
	};
}

export const PARTIAL_REPORT_NOTE =
	"This run has not finished. `summary` is partial, no budget verdict exists yet, and the zeros " +
	"are not results. Read again once get_run(runId).terminal is true.";

/**
 * The note on a report whose run status is outside `RUN_STATUSES`. `get_run`
 * never reports such a run terminal, so the way out it names is `stop_run`.
 */
export function unrecognisedStatusNote(status: unknown): string {
	return (
		`This run's status (${unrecognisedStatusLabel(status)}) is not one Vayu recognises, so the run ` +
		"is treated as unfinished: `summary` may be partial, no budget verdict can be trusted, and the " +
		"zeros are not results. Read get_run(runId) again, or stop_run."
	);
}

/**
 * Mark a report read while its run is not known to be finished. The marker is
 * absent for a terminal run, so `partial` present is the whole signal; the status
 * read is `metadata.status`, the same field the report states the run's state in.
 * A report with metadata but no recognised status is marked too, with
 * `unknownStatus: true` beside it (absent otherwise, never false). A report with
 * no metadata object at all has nothing to judge and is returned as it came.
 */
export function markPartialReport(report: unknown): unknown {
	if (!isRecord(report) || !isRecord(report.metadata)) return report;
	const status = report.metadata.status;
	switch (classifyRunStatus(status)) {
		case "terminal":
			return report;
		case "unfinished":
			return { ...report, partial: true, note: PARTIAL_REPORT_NOTE };
		case "unknown":
			return {
				...report,
				partial: true,
				unknownStatus: true,
				note: unrecognisedStatusNote(status),
			};
	}
}

/**
 * A load run's start answer: the engine's 202 body with `nextStep` and the
 * resolved `shape` the run was started with (#2437) added, so the run id
 * arrives beside the instruction to follow it and what it will do. A body that
 * is not an object is handed back as it came, as the start tools do for any
 * answer they cannot read a run from.
 */
export function startedRunResult(started: unknown, shape: LoadShape): ToolResult {
	if (!isRecord(started)) return jsonResult(started);
	return structuredResult({
		...started,
		nextStep: startedRunNextStep(shape.mode, shape.duration),
		shape,
	});
}
