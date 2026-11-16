/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file header-rows.ts
 * @brief A `headers` argument written over a stored header list: the rows or
 *        the map a write tool takes, and the stored value a withheld row keeps.
 */

import { foldHeaderName, withholdsHeaderRow } from "../withhold.js";
import { isRecord, ToolArgError } from "./kit.js";
import { toKeyValueEntries } from "./scenario-runs.js";

/** One header row as the engine stores it. */
export interface HeaderRow {
	key: string;
	value: string;
	enabled: boolean;
}

/** A row written back as the read showed a withheld one: it keeps the stored value (#3550). */
interface KeptHeaderRow {
	key: string;
	valueWithheld: true;
	enabled: boolean;
}

export type HeaderRowArg = HeaderRow | KeptHeaderRow;

export function keepsStoredValue(row: HeaderRowArg): row is KeptHeaderRow {
	return "valueWithheld" in row;
}

/**
 * A `headers` argument as rows: an ordered `{key, value, enabled?}` array, or
 * a string map (#3422).
 *
 * The array is taken row for row, in order, a repeated key kept - a response
 * with several `Set-Cookie` lines is several rows, which a map cannot hold.
 * `enabled` defaults to true. A row with `valueWithheld: true` and no `value`
 * is the row a read withheld, written back: it stands for the stored value
 * (`restoreWithheldHeaderRows`). The map is the short spelling, one enabled
 * row per name. Rows are `{key, value}` rather than `run_request`'s
 * `{name, value}` lines because these are the rows the engine stores and the
 * reads return.
 */
export function readHeaderRows(headers: unknown): HeaderRowArg[] {
	if (Array.isArray(headers)) return headers.map(readHeaderRow);
	if (isRecord(headers)) return toKeyValueEntries(headers);
	throw new ToolArgError(
		'"headers" must be an array of {key, value} rows or an object mapping header names to values.'
	);
}

function readHeaderRow(row: unknown, index: number): HeaderRowArg {
	const at = `"headers" row ${index}`;
	if (!isRecord(row)) throw new ToolArgError(`${at} must be an object with "key" and "value".`);
	if (row.enabled !== undefined && typeof row.enabled !== "boolean") {
		throw new ToolArgError(`${at} has an "enabled" that is not true or false.`);
	}
	const enabled = row.enabled ?? true;
	if (typeof row.key === "string" && typeof row.value === "string") {
		return { key: row.key, value: row.value, enabled };
	}
	if (typeof row.key === "string" && row.value === undefined && row.valueWithheld === true) {
		return { key: row.key, valueWithheld: true, enabled };
	}
	throw new ToolArgError(
		`${at} needs a string "key" and a string "value", or "valueWithheld": true to keep the stored value.`
	);
}

/**
 * @p rows with each withheld row given the stored value it stands for: the
 * row of @p stored with the same name, folded as the credential rules fold
 * it, at the same occurrence counted over every row of that name on each
 * side. Order, `enabled` and repeats are the call's. A withheld row with no
 * such stored row is refused, naming the header, before anything is written;
 * with nothing stored (a create), every withheld row is.
 */
export function restoreWithheldHeaderRows(stored: unknown, rows: HeaderRowArg[]): HeaderRow[] {
	const storedValues = valuesByName(stored);
	const seen = new Map<string, number>();
	return rows.map((row, index) => {
		const name = foldHeaderName(row.key);
		const occurrence = seen.get(name) ?? 0;
		seen.set(name, occurrence + 1);
		if (!keepsStoredValue(row)) return row;
		const value = storedValues.get(name)?.[occurrence];
		if (value === undefined)
			throw new ToolArgError(unmatchedRowText(row.key, index, occurrence));
		return { key: row.key, value, enabled: row.enabled };
	});
}

/** @p headers as rows for a list with nothing stored behind it, so a withheld row is refused. */
export function newHeaderRows(headers: unknown): HeaderRow[] {
	return restoreWithheldHeaderRows(undefined, readHeaderRows(headers));
}

function unmatchedRowText(key: string, index: number, occurrence: number): string {
	const stored =
		occurrence === 0
			? `no "${key}" header is stored`
			: `only ${occurrence} "${key}" headers are stored`;
	return `"headers" row ${index} ("${key}") has "valueWithheld": true and no "value", but ${stored} for it to keep. Give the row a "value", or leave it out.`;
}

/** Each stored row's value, per folded name, in order. */
function valuesByName(rows: unknown): Map<string, string[]> {
	const values = new Map<string, string[]>();
	for (const row of storedRows(rows)) {
		const name = foldHeaderName(row.key);
		values.set(name, [
			...(values.get(name) ?? []),
			typeof row.value === "string" ? row.value : "",
		]);
	}
	return values;
}

function storedRows(rows: unknown): Array<Record<string, unknown> & { key: string }> {
	if (!Array.isArray(rows)) return [];
	return rows.filter(
		(row): row is Record<string, unknown> & { key: string } =>
			isRecord(row) && typeof row.key === "string"
	);
}

/**
 * The names of the rows of @p stored whose value the read withheld (under the
 * stored row's @p auth) and @p written leaves out, by name and occurrence.
 */
export function droppedWithheldHeaders(
	stored: unknown,
	auth: unknown,
	written: HeaderRow[]
): string[] {
	const writtenCount = new Map<string, number>();
	for (const row of written) {
		const name = foldHeaderName(row.key);
		writtenCount.set(name, (writtenCount.get(name) ?? 0) + 1);
	}
	const seen = new Map<string, number>();
	const dropped = new Set<string>();
	for (const row of storedRows(stored)) {
		const name = foldHeaderName(row.key);
		const occurrence = seen.get(name) ?? 0;
		seen.set(name, occurrence + 1);
		if (withholdsHeaderRow(row, auth) && occurrence >= (writtenCount.get(name) ?? 0)) {
			dropped.add(row.key);
		}
	}
	return [...dropped];
}

/** The caveat line naming @p names, the headers a write removed unread; empty for none. */
export function droppedHeadersCaveat(names: string[]): string {
	if (names.length === 0) return "";
	const quoted = names.map((name) => `"${name}"`).join(", ");
	return `This write removed the stored ${quoted} header${names.length > 1 ? "s" : ""}, whose value this session cannot read. To keep such a header, pass \`headers\` as rows and repeat its row as read ({key, valueWithheld: true}).`;
}
