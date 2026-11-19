/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the session Console's toolbar narrows the list to (#3634): a row type,
 * a console level and a text query, as one predicate over a ring row.
 *
 * The list applies it to every row in the ring before it takes its window, as
 * the response pane's `ConsoleOutput` does, so a match far above what is drawn
 * is found without being scrolled to.
 */

import type { ConsoleLevel } from "@/types";
import type { ConsoleRow } from "@/stores/console-store";

/** A collection-run step is a request the run sent, so it is listed with the Sends. */
export type ConsoleTypeFilter = "all" | "requests" | "scriptRequests" | "lines";

/** A level names console lines only: a row without one is not shown while a level is chosen. */
export type ConsoleLevelFilter = "all" | ConsoleLevel;

export interface ConsoleFilter {
	type: ConsoleTypeFilter;
	level: ConsoleLevelFilter;
	/** As typed; trimmed and lowercased by {@link consoleRowMatcher}. */
	query: string;
}

export const NO_CONSOLE_FILTER: ConsoleFilter = { type: "all", level: "all", query: "" };

const TYPE_OF_KIND: Record<ConsoleRow["kind"], Exclude<ConsoleTypeFilter, "all">> = {
	send: "requests",
	step: "requests",
	scriptRequest: "scriptRequests",
	line: "lines",
};

/** Whether any control narrows the list; a whitespace-only query does not. */
export function narrowsConsole(filter: ConsoleFilter): boolean {
	return filter.type !== "all" || filter.level !== "all" || filter.query.trim() !== "";
}

/** The text a query is matched against: method, URL, status and message, and a step's name. */
function searchableText(row: ConsoleRow): (string | undefined)[] {
	switch (row.kind) {
		case "line":
			return [row.message];
		case "step":
			return [row.method, row.url, statusText(row.status), row.name];
		case "send":
			return [row.method, row.url, statusText(row.status), row.errorCode];
		case "scriptRequest":
			return [row.method, row.url, statusText(row.status), row.errorCode, row.line];
	}
}

/** `0` is no status (a failure before an answer), so it is not text a query can find. */
function statusText(status: number): string | undefined {
	return status > 0 ? String(status) : undefined;
}

/** The predicate @p filter describes, with the query folded once rather than per row. */
export function consoleRowMatcher(filter: ConsoleFilter): (row: ConsoleRow) => boolean {
	const query = filter.query.trim().toLowerCase();
	const { type, level } = filter;
	return (row) => {
		if (type !== "all" && TYPE_OF_KIND[row.kind] !== type) return false;
		if (level !== "all" && (row.kind !== "line" || row.level !== level)) return false;
		if (query === "") return true;
		return searchableText(row).some((field) => field?.toLowerCase().includes(query));
	};
}

/** The rows to list under @p filter: the same array when nothing narrows it. */
export function filterConsoleRows(
	rows: readonly ConsoleRow[],
	filter: ConsoleFilter
): readonly ConsoleRow[] {
	if (!narrowsConsole(filter)) return rows;
	return rows.filter(consoleRowMatcher(filter));
}
