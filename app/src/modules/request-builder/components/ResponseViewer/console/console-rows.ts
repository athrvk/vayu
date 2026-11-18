/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Console's rows: the parsed lines with each script request placed among
 * them (#3633).
 *
 * Scripts are synchronous and `pm.sendRequest` blocks, so execution order is
 * time order and the lines need no timestamp. A summary line that indexes its
 * record (`scriptRequest`) becomes the request row in the line's own place. A
 * record no line points at - the console was off, or its cap dropped the line -
 * goes after the last row its script wrote. "Its script" is the source and the
 * level: a collection script runs before a folder's, which runs before the
 * request's, so a record lands after the last row of its own level or an
 * earlier one.
 */

import type { ConsoleLogEntry, ElementScope, ScriptRequestRecord } from "@/types";
import { parseConsoleLogs, type LogSource, type ParsedLog } from "./parse-logs";

export interface ScriptRequestConsoleRow {
	source: LogSource;
	scope?: ElementScope;
	record: ScriptRequestRecord;
	/** The summary line this row stands in for; absent for an unlinked record. */
	line?: ParsedLog;
}

export type ConsoleRow = ParsedLog | ScriptRequestConsoleRow;

export function isScriptRequestRow(row: ConsoleRow): row is ScriptRequestConsoleRow {
	return "record" in row;
}

/** Run order of the levels; an absent scope is the request's own. */
const SCOPE_RANK: Record<ElementScope, number> = { collection: 0, folder: 1, request: 2 };

const rankOf = (scope: ElementScope | undefined) => SCOPE_RANK[scope ?? "request"] ?? 2;

/** Read as `parseConsoleLogs` reads a line's source, so a row and its line agree. */
const sourceOf = (record: ScriptRequestRecord): LogSource =>
	record.source === "pre" ? "pre" : "test";

/**
 * Where an unlinked record goes: after the last row of its source whose level
 * ran no later than its own, else before the first row of its source.
 */
function insertionIndex(rows: readonly ConsoleRow[], row: ScriptRequestConsoleRow): number {
	const rank = rankOf(row.scope);
	for (let i = rows.length - 1; i >= 0; i--) {
		const other = rows[i];
		if (other.source === row.source && rankOf(other.scope) <= rank) return i + 1;
	}
	const first = rows.findIndex((other) => other.source === row.source);
	return first === -1 ? rows.length : first;
}

export function consoleRows(
	parsed: readonly ParsedLog[],
	records: readonly ScriptRequestRecord[] | undefined
): ConsoleRow[] {
	if (!records?.length) return [...parsed];

	const linked = new Set<number>();
	const rows: ConsoleRow[] = parsed.map((line) => {
		const index = line.scriptRequest;
		// A second line naming the same record, or an index past the list, is
		// drawn as the plain line it is rather than dropped.
		if (index === undefined || linked.has(index) || !records[index]) return line;
		linked.add(index);
		return { source: line.source, scope: line.scope, record: records[index], line };
	});

	records.forEach((record, index) => {
		if (linked.has(index)) return;
		const row: ScriptRequestConsoleRow = {
			source: sourceOf(record),
			scope: record.scope,
			record,
		};
		rows.splice(insertionIndex(rows, row), 0, row);
	});
	return rows;
}

/**
 * How many rows the Console draws: every line, plus each record no line
 * stands in for. A linked record is counted once, by its line.
 */
export function consoleRowCount(
	logs: ReadonlyArray<ConsoleLogEntry | string>,
	records: readonly ScriptRequestRecord[] | undefined
): number {
	return consoleRows(parseConsoleLogs(logs), records).length;
}

/**
 * Whether a row matches the Console's filter. A request row is found by its
 * method, URL, status and error code, and by its summary line's own text, so
 * nothing the line matched before it became a row stops matching.
 */
export function rowMatches(row: ConsoleRow, needle: string): boolean {
	if (!isScriptRequestRow(row)) return row.message.toLowerCase().includes(needle);
	const { record, line } = row;
	return [
		record.request.method,
		record.request.url,
		String(record.status),
		record.error_type,
		line?.message,
	].some((field) => field?.toLowerCase().includes(needle));
}
