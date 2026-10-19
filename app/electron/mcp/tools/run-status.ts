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

/** The statuses after which a run's row and report no longer change. */
const TERMINAL_RUN_STATUSES: ReadonlySet<unknown> = new Set(["completed", "failed", "stopped"]);

/** Statuses of a run whose numbers are still accumulating. */
const UNFINISHED_RUN_STATUSES: ReadonlySet<unknown> = new Set(["pending", "running"]);

export function isTerminalRunStatus(status: unknown): boolean {
	return TERMINAL_RUN_STATUSES.has(status);
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
		`it is finished when \`terminal\` is true (status completed, failed or stopped). ` +
		`Read get_run_report(runId) once it is - a report read earlier is partial and carries no ` +
		`budget verdict. stop_run ends the run early.`
	);
}

function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nextStepFor(status: unknown, pollSeconds: number): string {
	if (!isTerminalRunStatus(status)) {
		return `still running; read again in ${pollSeconds} s, or stop_run`;
	}
	if (status === "completed") return "read get_run_report(runId)";
	if (status === "failed") return "get_run_report has the numbers recorded before the failure";
	return "get_run_report has the partial numbers; a stopped run carries no verdict";
}

/**
 * `get_run`'s answer from the engine's run row, run through the withhold pass
 * first (a snapshot can carry credentials, so only fields named here leave).
 *
 * `terminal` comes from the status and `endTime` is null while the run is going:
 * the engine seeds `endTime` to `startTime` for a row that has not finished, so
 * a non-zero `endTime` says nothing. `progress` exists only for a duration-bound
 * run whose duration parses; anywhere else it is null rather than an estimate.
 */
export function projectRunStatus(row: unknown, now: number = Date.now()): unknown {
	if (!isRecord(row)) return row;
	const snapshot = isRecord(row.configSnapshot) ? row.configSnapshot : {};
	const terminal = isTerminalRunStatus(row.status);
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
 * Mark a report read while its run is still going. The marker is absent for a
 * terminal run, so `partial` present is the whole signal; the status read is
 * `metadata.status`, the same field the report states the run's state in.
 */
export function markPartialReport(report: unknown): unknown {
	if (!isRecord(report) || !isRecord(report.metadata)) return report;
	if (!UNFINISHED_RUN_STATUSES.has(report.metadata.status)) return report;
	return { ...report, partial: true, note: PARTIAL_REPORT_NOTE };
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
