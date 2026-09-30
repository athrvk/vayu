/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Postman-style path variables (issue #1764): a `:name` segment in the URL,
 * with its value in a params row marked `in: "path"`.
 *
 * The URL keeps `:name` verbatim; the engine substitutes the enabled rows at
 * compose time. This file is the app's one statement of which segments count,
 * and of the substitution the snippets (`services/codegen`) and the Params
 * tab's "Sends" line need to agree with the engine on, pinned to it by
 * `engine/tests/fixtures/path-variable-conformance.json`.
 */

import type { KeyValueEntry, KeyValueItem } from "@/types";
import { generateId } from "@/lib/id";

/**
 * A path segment that is a path variable: `:` then a name running to the first
 * `.` (the rest of the segment is a suffix kept on the wire, so `:id.json`
 * sends `7.json`). Any other character is allowed in the name; `:` alone and
 * `:.x` are not variables. Postman's `parsePathVariable`, and the engine's
 * `path_variable_segments` (`engine/src/core/path_template.cpp`).
 */
export const PATH_VARIABLE_SEGMENT = /^:([^.]+)/;

/**
 * One `:name` path variable in a URL: where the `:name` text sits (the colon
 * included, a `.suffix` after the name excluded) and the name it spells.
 */
export interface PathVariableSegment {
	offset: number;
	length: number;
	name: string;
}

/**
 * The end of the `{{...}}` token starting at `at`, or -1 when none starts
 * there: `postman-url-encoder`'s `/{{[^{}]*}}/`.
 */
function tokenEnd(text: string, at: number): number {
	if (!text.startsWith("{{", at)) return -1;
	for (let scan = at + 2; scan < text.length; scan++) {
		if (text[scan] === "{") return -1;
		if (text[scan] === "}") return text.startsWith("}}", scan) ? scan + 2 : -1;
	}
	return -1;
}

/**
 * `text` with every `{{...}}` token's characters replaced by `_`, the same
 * length, so offsets into it are offsets into `text` and a separator inside a
 * token is no longer one.
 */
function maskTokens(text: string): string {
	let out = "";
	let copied = 0;
	for (let at = 0; at < text.length;) {
		const end = tokenEnd(text, at);
		if (end === -1) {
			at++;
			continue;
		}
		out += text.slice(copied, at) + "_".repeat(end - at);
		copied = at = end;
	}
	return out + text.slice(copied);
}

const isSlash = (c: string | undefined) => c === "/" || c === "\\";

/**
 * Every `:name` segment of the URL's path, in order, repeats included - the
 * engine's `path_variable_segments`, step for step.
 *
 * Leading whitespace is skipped; a `{{variable}}` token is opaque; the fragment
 * (from the first `#`) and then the query (from the first `?`) are cut off; a
 * backslash is a `/`; `scheme://` and the slashes after it are skipped (`file:`
 * keeps one); and the path is what follows the first `/` after that. So a port
 * (`host:8080`) and a `:` in the query or the fragment are never variables.
 */
export function pathVariableSegments(url: string): PathVariableSegment[] {
	const found: PathVariableSegment[] = [];
	const view = maskTokens(url);

	let begin = view.search(/[^ \t\r\n\f\v]/);
	if (begin === -1) return found;
	const hash = view.indexOf("#", begin);
	let end = hash === -1 ? view.length : hash;
	const query = view.indexOf("?", begin);
	if (query !== -1) end = Math.min(query, end);

	const scheme = view.indexOf("://", begin);
	if (scheme !== -1 && scheme + 3 <= end) {
		let after = scheme + 3;
		while (after < end && isSlash(view[after])) after++;
		// `file:///path` keeps one slash: the path starts at it.
		if (after > scheme + 3 && view.slice(begin, scheme).toLowerCase() === "file") after--;
		begin = after;
	}
	let cursor = begin;
	while (cursor < end && !isSlash(view[cursor])) cursor++;
	// Everything before the first slash is the authority; no slash, no path.
	while (cursor < end) {
		const start = cursor + 1;
		let stop = start;
		while (stop < end && !isSlash(view[stop])) stop++;
		const match = PATH_VARIABLE_SEGMENT.exec(url.slice(start, stop));
		if (match) found.push({ offset: start, length: 1 + match[1].length, name: match[1] });
		cursor = stop;
	}
	return found;
}

/** The path-variable names in the URL, first occurrence order, each once. */
export function pathVariableNames(url: string): string[] {
	return [...new Set(pathVariableSegments(url).map((segment) => segment.name))];
}

export function isPathRow(row: Pick<KeyValueEntry, "in">): boolean {
	return row.in === "path";
}

/** The rows the query string is built from: everything that is not a path row. */
export function queryRowsOf<T extends Pick<KeyValueEntry, "in">>(rows: readonly T[]): T[] {
	return rows.filter((row) => !isPathRow(row));
}

export function pathRowsOf<T extends Pick<KeyValueEntry, "in">>(rows: readonly T[]): T[] {
	return rows.filter(isPathRow);
}

const newPathRow = (name: string): KeyValueItem => ({
	id: generateId(),
	key: name,
	value: "",
	enabled: true,
	in: "path",
});

/** Fresh path rows (empty values) for a URL that arrives with no rows of its own. */
export function pathRowsFromUrl(url: string): KeyValueItem[] {
	return pathVariableNames(url).map(newPathRow);
}

/**
 * The path row that answers `name`: the last enabled one with that key, as the
 * engine's `find_path_variable_row` picks it. Postman's `VariableList` answers
 * with the last entry whatever its `disabled` flag (its UI has no toggle for a
 * path variable); Vayu has one, so a disabled row answers nothing. An
 * `enabled` that is absent (or not a boolean) counts as enabled.
 */
function answeringRow<T extends KeyValueEntry>(rows: readonly T[], name: string): T | undefined {
	for (let i = rows.length - 1; i >= 0; i--) {
		const row = rows[i];
		if (isPathRow(row) && row.key === name && row.enabled !== false) return row;
	}
	return undefined;
}

/** Two name lists as the same `:name` segments, in the same order. */
function sameNames(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((name, i) => name === b[i]);
}

/**
 * The path rows after the URL changed from `previousUrl` to `url`, carried
 * over from `existing`.
 *
 * An edit that leaves the URL's `:name` segments as they were - the query, the
 * host, a literal path segment - changes no row: a declared row whose segment
 * is not in the URL (a Postman `url.variable` entry nothing uses) is data the
 * edit did not touch, and it is still exported.
 *
 * An edit that changes them makes the rows follow the URL, as Postman's own
 * editor does: a name still in the URL keeps its row (value, description,
 * enabled, id, and any member an import carried), a name new to it gets an
 * empty row, and a row whose name is not in it is dropped. One exception keeps
 * a value across a rename: when exactly one name left and exactly one arrived
 * (typing `:userId` over `:id` one keystroke at a time), the row that left is
 * renamed rather than replaced. Any other combination pairs nothing, since a
 * row matched to a name by position alone would send one variable's value
 * (a secret, say) as another's. The result follows the URL's order.
 *
 * Unlike a query row, a disabled path row is still in the URL (the segment is
 * there whether or not the value is sent), so it is matched like any other.
 * Several rows with one key collapse to the one that answers it at send time
 * (the last enabled, else the last), so the value that was sent survives.
 */
export function syncPathRows(
	existing: readonly KeyValueItem[],
	url: string,
	previousUrl: string
): KeyValueItem[] {
	const names = pathVariableNames(url);
	const previous = pathVariableNames(previousUrl);
	if (sameNames(names, previous)) return [...existing];

	const byName = new Map<string, KeyValueItem>();
	for (const row of existing) {
		const held = byName.get(row.key);
		if (!held || row.enabled !== false || held.enabled === false) byName.set(row.key, row);
	}
	const left = previous.filter((name) => !names.includes(name));
	const arrived = names.filter((name) => !previous.includes(name));
	const renamed = left.length === 1 && arrived.length === 1 ? byName.get(left[0]) : undefined;

	return names.map((name) => {
		const kept = byName.get(name);
		if (kept) return kept;
		if (renamed && name === arrived[0]) return { ...renamed, key: name };
		return newPathRow(name);
	});
}

/**
 * The rows the Path variables table shows: every stored path row as it is,
 * then an empty row for each `:name` of the URL that has none.
 *
 * Derived on every render and never written by rendering, so opening a
 * request whose URL names a variable its rows do not (one stored before
 * #1764, or imported with no `url.variable` entry) shows the row without
 * marking the request edited; the first edit in the table writes it back. The
 * derived row's id is its name, so it keeps its identity across renders.
 */
export function displayPathRows(existing: readonly KeyValueItem[], url: string): KeyValueItem[] {
	const held = new Set(existing.map((row) => row.key));
	const missing = pathVariableNames(url).filter((name) => !held.has(name));
	return [
		...existing,
		...missing.map((name) => ({ ...newPathRow(name), id: `path-variable:${name}` })),
	];
}

const encoder = new TextEncoder();

/**
 * The ASCII bytes of `postman-url-encoder` 3.0.8's `PATH_ENCODE_SET`
 * (`encoder/encode-set.js`) beyond the C0 controls and DEL: the fragment
 * set's space `"` `<` `>` and backtick, then the path set's own `#` `?` `{`
 * `}`. Every byte above `~` is in it too; nothing else is.
 */
const PATH_ENCODE_ASCII = new Set([...' "<>`#?{}'].map((char) => char.charCodeAt(0)));

const inPathEncodeSet = (byte: number) => byte < 0x20 || byte > 0x7e || PATH_ENCODE_ASCII.has(byte);

/** Each byte of `text` (UTF-8) in Postman's path encode set as `%XX` (uppercase). */
function percentEncodePath(text: string): string {
	let out = "";
	for (const byte of encoder.encode(text)) {
		out += inPathEncodeSet(byte)
			? `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
			: String.fromCharCode(byte);
	}
	return out;
}

/**
 * `value` percent-encoded as Postman writes a path variable's value into the
 * path, with every `{{variable}}` token in it kept verbatim - the engine's
 * `encode_path_variable_value`. Postman joins the raw value and encodes the
 * path with `PATH_ENCODE_SET`, so a `/` makes more segments, `@ : , ; = & + %`
 * and the rest of the reserved set are sent as typed (a `%XX` is not encoded
 * twice), and `?` / `#` are `%3F` / `%23`, so a value never ends the path. A
 * token is kept whole, so a snippet shows the name a run answers rather than
 * `%7B%7B`.
 */
export function encodePathVariableValue(value: string): string {
	let out = "";
	let plain = 0;
	for (let at = 0; at < value.length;) {
		const end = tokenEnd(value, at);
		if (end === -1) {
			at++;
			continue;
		}
		out += percentEncodePath(value.slice(plain, at)) + value.slice(at, end);
		plain = at = end;
	}
	return out + percentEncodePath(value.slice(plain));
}

/**
 * The URL with each `:name` segment replaced by its row's value - what the
 * engine sends (`substitute_path_variables`).
 *
 * Only an enabled path row answers, and among several with one key the last
 * enabled one does. `resolve` turns its value into send-time text (`{{var}}`
 * resolution; the identity where the snippet stays templated); a value that
 * resolves to nothing leaves the segment literal (`:id` goes out as written,
 * as Postman sends it). Otherwise the resolved value is written through
 * `encodePathVariableValue` in place of `:name`, and a `.suffix` stays.
 */
export function substitutePathVariables(
	url: string,
	rows: readonly KeyValueEntry[],
	resolve: (value: string) => string = (value) => value
): string {
	if (rows.length === 0) return url;
	let out = "";
	let copied = 0;
	for (const segment of pathVariableSegments(url)) {
		const row = answeringRow(rows, segment.name);
		if (!row) continue;
		const resolved = resolve(typeof row.value === "string" ? row.value : "");
		if (!resolved) continue;
		out += url.slice(copied, segment.offset) + encodePathVariableValue(resolved);
		copied = segment.offset + segment.length;
	}
	return out + url.slice(copied);
}

/**
 * The `params` member an inline `POST /compose` request carries: the path rows
 * alone, in the stored shape (no editor `id`; every other member, `type` and
 * `description` included, kept), so the engine fills the `:name` segments of
 * the editor's URL, which may be ahead of the saved row. The query rows are
 * not sent - the URL already holds them.
 *
 * Always sent, `[]` included: the engine falls back to the *stored* rows when
 * the key is absent, and a row the editor removed must not answer from there.
 */
export function composePathParams(rows: readonly KeyValueEntry[]): KeyValueEntry[] {
	return pathRowsOf(rows).map((row) => {
		const {
			id: _id,
			system: _system,
			...entry
		} = row as KeyValueEntry & {
			id?: unknown;
			system?: unknown;
		};
		return entry;
	});
}
