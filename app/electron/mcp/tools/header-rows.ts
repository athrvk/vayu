/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @brief A `headers` argument written over a stored header list: the rows or
 *        the map a write tool takes, and the stored value a withheld row keeps.
 */

import { foldHeaderName, withholdsHeaderRow } from "../withhold.js";
import { isRecord, ToolArgError } from "./kit.js";
import { toKeyValueEntries } from "./scenario-runs.js";

/**
 * The members of a stored header row besides `key`, `value` and `enabled`, all
 * strings: a `description` and a `type` (a Postman import's), and a `source`,
 * which marks the row an app setting wrote (`body-mode`, `stream`) or the
 * engine's repair pass disabled (`legacy-default`). The app's Body panel reads
 * `source` to tell its own Content-Type row from one the user typed, so a row
 * written back without it changes what the app does with it.
 */
export const HEADER_ROW_EXTRA_MEMBERS = ["description", "source", "type"] as const;

type HeaderRowExtras = { [member in (typeof HEADER_ROW_EXTRA_MEMBERS)[number]]?: string };

/** One header row as the engine stores it. */
export interface HeaderRow extends HeaderRowExtras {
	key: string;
	value: string;
	enabled: boolean;
}

/** A row written back as the read showed a withheld one: it keeps the stored value (#3550). */
interface KeptHeaderRow extends HeaderRowExtras {
	key: string;
	valueWithheld: true;
	enabled: boolean;
}

export type HeaderRowArg = HeaderRow | KeptHeaderRow;

export function keepsStoredValue(row: HeaderRowArg): row is KeptHeaderRow {
	return "valueWithheld" in row;
}

/**
 * A `headers` argument as rows: an ordered `{key, value, enabled?}` array, or a string map (#3422).
 * The array is taken row for row, in order, a repeated key kept (a response with several
 * `Set-Cookie` lines is several rows, which a map cannot hold). `enabled` defaults to true. The
 * members of {@link HEADER_ROW_EXTRA_MEMBERS} a row carries are forwarded as given. A row with
 * `valueWithheld: true` and no `value` is the row a read withheld, written back: it stands for the
 * stored value (`restoreWithheldHeaderRows`). The map is the short spelling, one enabled row per
 * name. Rows are `{key, value}` rather than `run_request`'s `{name, value}` lines because these are
 * the rows the engine stores and the reads return.
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
		return { key: row.key, value: row.value, enabled, ...readRowExtras(row, at) };
	}
	if (typeof row.key === "string" && row.value === undefined && row.valueWithheld === true) {
		return { key: row.key, valueWithheld: true, enabled, ...readRowExtras(row, at) };
	}
	throw new ToolArgError(
		`${at} needs a string "key" and a string "value", or "valueWithheld": true to keep the stored value.`
	);
}

/** The extra members @p row carries, each of which must be a string. */
function readRowExtras(row: Record<string, unknown>, at: string): HeaderRowExtras {
	const extras: HeaderRowExtras = {};
	for (const member of HEADER_ROW_EXTRA_MEMBERS) {
		const value = row[member];
		if (value === undefined) continue;
		if (typeof value !== "string") {
			throw new ToolArgError(`${at} has a "${member}" that is not a string.`);
		}
		extras[member] = value;
	}
	return extras;
}

/**
 * @p rows with each withheld row given the stored value it stands for: the row of @p stored with
 * the same name, folded as the credential rules fold it, at the same occurrence counted over every
 * row of that name on each side. Order, `enabled`, repeats and any other member the row carries are
 * the call's. A withheld row with no such stored row is refused, naming the header, before anything
 * is written; with nothing stored (a create), every withheld row is.
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
		const { valueWithheld: _kept, ...carried } = row;
		return { ...carried, value };
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
			: `only ${occurrence} "${key}" header${occurrence === 1 ? " is" : "s are"} stored`;
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
	written: ReadonlyArray<Pick<HeaderRow, "key">>
): string[] {
	return withheldRowsAtSlot(stored, auth, written, (row) => row === undefined);
}

/**
 * The names of the rows of @p stored whose value the read withheld (under the
 * stored row's @p auth) and that the write leaves holding it (#3654): with no
 * @p written list the stored one stays as it is, and with one only a row written
 * back withheld keeps the stored value. A row given a value, or left out, is
 * not one: the credential it held is replaced or gone.
 */
export function credentialRowsKept(
	stored: unknown,
	auth: unknown,
	written: ReadonlyArray<HeaderRowArg> | undefined
): string[] {
	if (written === undefined) {
		return withheldRowsAtSlot(stored, auth, [], () => true);
	}
	return withheldRowsAtSlot(
		stored,
		auth,
		written,
		(row) => row !== undefined && keepsStoredValue(row)
	);
}

/**
 * The names of the withheld rows of @p stored whose slot, the row of @p written
 * at the same folded name and occurrence (undefined when there is none), passes
 * @p atSlot.
 */
function withheldRowsAtSlot<Row extends Pick<HeaderRow, "key">>(
	stored: unknown,
	auth: unknown,
	written: ReadonlyArray<Row>,
	atSlot: (row: Row | undefined) => boolean
): string[] {
	const slots = new Map<string, Row[]>();
	for (const row of written) {
		const name = foldHeaderName(row.key);
		slots.set(name, [...(slots.get(name) ?? []), row]);
	}
	const seen = new Map<string, number>();
	const names = new Set<string>();
	for (const row of storedRows(stored)) {
		const name = foldHeaderName(row.key);
		const occurrence = seen.get(name) ?? 0;
		seen.set(name, occurrence + 1);
		if (withholdsHeaderRow(row, auth) && atSlot(slots.get(name)?.[occurrence])) {
			names.add(row.key);
		}
	}
	return [...names];
}

/** The caveat line naming @p names, the headers a write removed unread; empty for none. */
export function droppedHeadersCaveat(names: string[]): string {
	if (names.length === 0) return "";
	const quoted = names.map((name) => `"${name}"`).join(", ");
	return `This write removed the stored ${quoted} header${names.length > 1 ? "s" : ""}, whose value this session cannot read. To keep such a header, pass \`headers\` as rows and repeat its row exactly as read, \`enabled\` and any \`source\` included, with \`valueWithheld: true\` and no \`value\`.`;
}
