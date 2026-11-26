/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Postman-style path variables (#1764): a `:name` URL segment, valued by a params row marked
 * `in: "path"`. The URL keeps `:name` verbatim and the engine substitutes enabled rows at compose
 * time. This is the app's one statement of which segments count and of the substitution the
 * snippets (`services/codegen`) and the Params "Sends" line must match the engine on, pinned by
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
 * there: `postman-url-encoder`'s `/{{[^{}]*}}/`. Shared with the query
 * encoder (`query-encoding.ts`), which keeps a token verbatim by the same rule.
 */
export function tokenEnd(text: string, at: number): number {
	if (!text.startsWith("{{", at)) return -1;
	for (let scan = at + 2; scan < text.length; scan++) {
		if (text[scan] === "{") return -1;
		if (text[scan] === "}") return text.startsWith("}}", scan) ? scan + 2 : -1;
	}
	return -1;
}

/**
 * `text` with `map` applied to each stretch between `{{...}}` tokens (a
 * token-free text is one stretch) and every token kept verbatim: the
 * encoders' shared way of leaving a variable name alone.
 */
export function mapOutsideTokens(text: string, map: (plain: string) => string): string {
	let out = "";
	let plain = 0;
	for (let at = 0; at < text.length;) {
		const end = tokenEnd(text, at);
		if (end === -1) {
			at++;
			continue;
		}
		out += map(text.slice(plain, at)) + text.slice(at, end);
		plain = at = end;
	}
	return out + map(text.slice(plain));
}

/**
 * `text` with every `{{...}}` token's characters replaced by `_`, the same
 * length, so offsets into it are offsets into `text` and a separator inside a
 * token is no longer one. Shared with the query split in `url.ts`.
 */
export function maskTokens(text: string): string {
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
 * Every `:name` segment of the URL's path, in order, repeats included: the engine's
 * `path_variable_segments` step for step. Leading whitespace is skipped; a `{{variable}}` token is
 * opaque; the fragment (first `#`), then the query (first `?`) are cut; a backslash is a `/`;
 * `scheme://` and its slashes are skipped (`file:` keeps one); the path follows the next `/`. So a
 * port (`host:8080`) or a `:` in query or fragment is never a variable.
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
 * The path row answering `name`: the last enabled one with that key, as the engine's
 * `find_path_variable_row` picks. Postman answers with the last entry whatever its `disabled` flag
 * (it has no toggle); Vayu has one, so a disabled row answers nothing. An absent or non-boolean
 * `enabled` counts as enabled.
 */
function answeringRow<T extends KeyValueEntry>(rows: readonly T[], name: string): T | undefined {
	for (let i = rows.length - 1; i >= 0; i--) {
		const row = rows[i];
		if (isPathRow(row) && row.key === name && row.enabled !== false) return row;
	}
	return undefined;
}

/**
 * The rows `substitutePathVariables` can write into `url`: per `:name` in it, the one answering
 * row; rows for absent names, disabled rows and shadowed duplicates excluded.
 */
export function answeringPathRows<T extends KeyValueEntry>(url: string, rows: readonly T[]): T[] {
	return pathVariableNames(url).flatMap((name) => answeringRow(rows, name) ?? []);
}

/** Two name lists as the same `:name` segments, in the same order. */
function sameNames(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((name, i) => name === b[i]);
}

/**
 * The path rows after the URL changed from `previousUrl` to `url`, carried from `existing`. An edit
 * leaving the `:name` segments as they were (the query, the host, a literal segment) changes no
 * row: a declared row the URL does not use (an unused Postman `url.variable`) is untouched data,
 * still exported. An edit that changes them makes the rows follow the URL, as Postman's editor
 * does: a kept name keeps its row (value, description, enabled, id, any imported member), a new
 * name gets an empty row, a gone name's row is dropped. One exception keeps a value across a
 * rename: exactly one name left and one arrived (typing `:userId` over `:id`) renames the row.
 * Nothing else pairs, as matching by position could send one variable's value (a secret) as
 * another's. Result in URL order. A disabled path row is still in the URL (the segment is there
 * either way), so it matches like any. Several rows with one key collapse to the one answering at
 * send time (last enabled, else last), so the sent value survives.
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
 * The Path variables table's rows: every stored path row, then an empty row for each `:name`
 * without one. Derived every render, never written by rendering, so a request whose URL names a
 * variable its rows lack (stored before #1764, or imported without `url.variable`) shows the row
 * unedited; the first table edit writes it. A derived row's id is its name, stable across renders.
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

/** Whether `byte` is in `PATH_ENCODE_SET`; `query-encoding.ts` writes a substituted path value by it. */
export const inPathEncodeSet = (byte: number) =>
	byte < 0x20 || byte > 0x7e || PATH_ENCODE_ASCII.has(byte);

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
 * `value` percent-encoded as Postman writes a path variable's value, `{{variable}}` tokens kept:
 * the engine's `encode_path_variable_value`. Postman joins the raw value and encodes the path with
 * `PATH_ENCODE_SET`, so `/` makes more segments, `@ : , ; = & + %` and the rest of the reserved set
 * go as typed (a `%XX` is not encoded twice), and `?` / `#` become `%3F` / `%23`, never ending the
 * path. A token is kept whole, so a snippet shows the name a run answers, not `%7B%7B`.
 */
export function encodePathVariableValue(value: string): string {
	return mapOutsideTokens(value, percentEncodePath);
}

/**
 * The URL with each `:name` replaced by its row's value, as the engine sends it
 * (`substitute_path_variables`). Only an enabled row answers, the last of several. `resolve` makes
 * its value send-time text (`{{var}}` resolution, or identity where a snippet stays templated); a
 * value resolving to nothing leaves `:id` literal, as Postman sends it; otherwise it goes through
 * `encodePathVariableValue`, and a `.suffix` stays. `encode: false` is `disableUrlEncoding`
 * (#1765): the value goes as written, as the engine does with the flag.
 */
export function substitutePathVariables(
	url: string,
	rows: readonly KeyValueEntry[],
	resolve: (value: string) => string = (value) => value,
	{ encode = true }: { encode?: boolean } = {}
): string {
	if (rows.length === 0) return url;
	let out = "";
	let copied = 0;
	for (const segment of pathVariableSegments(url)) {
		const row = answeringRow(rows, segment.name);
		if (!row) continue;
		const resolved = resolve(typeof row.value === "string" ? row.value : "");
		if (!resolved) continue;
		out +=
			url.slice(copied, segment.offset) +
			(encode ? encodePathVariableValue(resolved) : resolved);
		copied = segment.offset + segment.length;
	}
	return out + url.slice(copied);
}

/**
 * The `params` an inline `POST /compose` carries: the path rows alone, in stored shape (no editor
 * `id`; `type`, `description` and all else kept), so the engine fills the editor URL's `:name`
 * segments, which may be ahead of the saved row. Query rows are not sent: the URL holds them.
 * Always sent, `[]` included: absent, the engine falls back to the *stored* rows, where a removed
 * row would answer.
 */
export function composePathParams(rows: readonly KeyValueEntry[]): KeyValueEntry[] {
	return pathRowsOf(rows).map((row) => {
		const { id: _id, ...entry } = row as KeyValueEntry & { id?: unknown };
		return entry;
	});
}
