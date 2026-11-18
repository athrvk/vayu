/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the Logs tab does with one line of a log file (#3635): tell a record
 * from a line that is not one, draw its extra fields, turn it back into the text
 * that Copy line and Export write, and estimate what holding it costs.
 */

import type { LogEntry, LogFileRecord, UnparsedLogLine } from "@/types/electron";

/** A record always carries a string `ts`, so a field named `unparsed` cannot pass for this. */
export function isUnparsedEntry(entry: LogEntry): entry is UnparsedLogLine {
	return "unparsed" in entry && !("ts" in entry);
}

/**
 * The keys the `key=value` text leaves out: the table's columns, and `pid` and
 * `tid`, which `electron/log.ts`'s text renderer leaves out too (the opened
 * row's JSON shows them).
 */
const COLUMN_KEYS = new Set(["ts", "level", "src", "cat", "msg", "pid", "tid"]);

/** The record's fields that have no column, as `key=value` pairs. */
export function fieldsText(record: LogFileRecord): string {
	return Object.entries(record)
		.filter(([key]) => !COLUMN_KEYS.has(key))
		.map(
			([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`
		)
		.join(" ");
}

/** The line as the file holds it: a record as one JSON object, an unparsed line as its raw text. */
export function entryLine(entry: LogEntry): string {
	return isUnparsedEntry(entry) ? entry.raw : JSON.stringify(entry);
}

const sizes = new WeakMap<LogEntry, number>();

/**
 * What a held line costs, as a documented estimate and not a measurement: two
 * bytes per UTF-16 code unit of its line, the count `estimateResponseBytes`
 * (`stores/response-store.ts`) uses for a body. Cached per object, so a bound
 * that is re-checked on every batch stringifies a line once.
 */
export function entryBytes(entry: LogEntry): number {
	let bytes = sizes.get(entry);
	if (bytes === undefined) {
		bytes = entryLine(entry).length * 2;
		sizes.set(entry, bytes);
	}
	return bytes;
}

const keys = new WeakMap<LogEntry, number>();
let nextKey = 0;

/** A stable React key for a held line: the lines have no id of their own. */
export function entryKey(entry: LogEntry): number {
	let key = keys.get(entry);
	if (key === undefined) {
		key = nextKey++;
		keys.set(entry, key);
	}
	return key;
}
