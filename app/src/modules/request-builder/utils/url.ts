/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * URL utilities for the request builder.
 */

import type { KeyValueEntry, KeyValueItem } from "@/types";
import { generateId } from "@/lib/id";
import {
	isPathRow,
	maskTokens,
	pathRowsFromUrl,
	pathRowsOf,
	queryRowsOf,
	syncPathRows,
} from "./path-variables";
import { encodeQueryComponent } from "./query-encoding";

/** Whether a query built from rows percent-encodes them - see `writeQueryRow`. */
export interface UrlEncodeOptions {
	encode?: boolean;
}

/** One `key=value` pair of a URL's query, split as Postman's `QueryParam.parse` does. */
interface RawQueryPair {
	key: string;
	value: string;
	/** The pair has no `=` at all (`?flag`, not `?flag=`). */
	valueless: boolean;
	/** The pair exactly as the URL spells it. */
	text: string;
}

/** A URL cut at its query: `base` before the `?`, `query` up to the `#`, `fragment` from it. */
interface UrlQuerySplit {
	base: string;
	/** The query text, without its `?`; null when the URL has no `?`. */
	query: string | null;
	/** From the `#` on, or "" when there is none. */
	fragment: string;
}

/**
 * The URL cut at its fragment (the first `#`) and then its query (the first
 * `?` before that), with a `{{variable}}` token opaque - so `{{a#b}}` is not a
 * fragment, the same cut `pathVariableSegments` and the engine's
 * `path_variable_segments` make. The fragment is never sent, so a pair left
 * glued to it would never reach the server.
 */
function splitQuery(url: string): UrlQuerySplit {
	const view = maskTokens(url);
	const hash = view.indexOf("#");
	const end = hash === -1 ? url.length : hash;
	const fragment = url.slice(end);
	const queryStart = view.slice(0, end).indexOf("?");
	if (queryStart === -1) return { base: url.slice(0, end), query: null, fragment };
	return { base: url.slice(0, queryStart), query: url.slice(queryStart + 1, end), fragment };
}

/**
 * The URL's query pairs, never decoded: split on `&`, then on the first `=`.
 * Empty pairs (`a=1&&b=2`) are dropped.
 */
function rawQueryPairs(url: string): RawQueryPair[] {
	const { query } = splitQuery(url);
	if (query === null) return [];
	return query
		.split("&")
		.filter(Boolean)
		.map((text) => {
			const separator = text.indexOf("=");
			return separator === -1
				? { key: text, value: "", valueless: true, text }
				: {
						key: text.slice(0, separator),
						value: text.slice(separator + 1),
						valueless: false,
						text,
					};
		});
}

/**
 * The rows a query is written from: enabled and keyed. A path row
 * (`in: "path"`, issue #1764) is never part of the query: its value goes into
 * a `:name` segment, which the URL already carries.
 */
function queryRowsToWrite(params: readonly KeyValueEntry[]): KeyValueEntry[] {
	return params.filter((p) => p.enabled && p.key.trim() && !isPathRow(p));
}

/** Whether @p row writes as a bare `key`: it is `valueless` and still has no value. */
export function writesBareKey(row: KeyValueEntry): boolean {
	return row.valueless === true && !row.value;
}

/**
 * One row as `key=value`, encoded with Postman's query rule
 * (`encodeQueryComponent`, issue #1771), or as typed under `encode: false`.
 *
 * An empty value writes `key=` and a `valueless` row a bare `key`, as
 * Postman's `QueryParam.unparseSingle` writes `""` and `null` (issue #1772).
 *
 * `encode: false` is a request's `disableUrlEncoding` (issue #1765): the row
 * is written as typed, so `q=a|b` stays `a|b` in the URL the engine sends.
 */
function writeQueryRow(row: KeyValueEntry, encode: boolean): string {
	const key = encode ? encodeQueryComponent(row.key, "key") : row.key;
	if (writesBareKey(row)) return key;
	return `${key}=${encode ? encodeQueryComponent(row.value, "value") : row.value}`;
}

/**
 * The URL that expresses exactly these params: the rows *replace* whatever
 * query the URL carried. The fragment, if any, stays after the new query.
 *
 * This is the Params table's rule, and only the table's - there the rows are
 * the whole truth of the query, so deleting the last one has to clear it.
 *
 * A row the URL already carries keeps the URL's own bytes (issue #1771), so an
 * edit rewrites only the pairs it touches and a pair written by another rule
 * survives it: an Insomnia or OpenAPI import's `encodeURIComponent` join, or a
 * Postman `key=`. Each enabled row takes the first unused pair spelled exactly
 * as the row, and only then may a row take a pair that `safeDecode`s to it.
 * That second match is for a row an older version stored decoded (`+05:00`
 * held for `%2B05%3A00`; re-encoding it would send a `+` a server reads as a
 * space), so it is open only to a row carried over unchanged from `previous`
 * (same id, key and value). A row the user just edited or added means what it
 * says: `+` typed over `%2B` is a `+`. With no `previous`, every row counts as
 * carried over. A row with no pair is encoded.
 *
 * The exact match also asks the pair to agree on `=`, so a row made valueless
 * (or given its `=` back) is rewritten. The decoded match does not: a row
 * stored before rows could be valueless holds `""` for a URL's bare `?flag`,
 * and a carried-over one keeps it.
 */
export function buildUrlWithParams(
	baseUrl: string,
	params: readonly KeyValueEntry[],
	{ encode = true }: UrlEncodeOptions = {},
	previous?: readonly KeyValueItem[]
): string {
	const { base, fragment } = splitQuery(baseUrl);
	const pairs = rawQueryPairs(baseUrl);
	const used = new Array<boolean>(pairs.length).fill(false);
	const rows = queryRowsToWrite(params);
	const claim = (matches: (pair: RawQueryPair) => boolean): string | undefined => {
		const match = pairs.findIndex((pair, i) => !used[i] && matches(pair));
		if (match === -1) return undefined;
		used[match] = true;
		return pairs[match].text;
	};
	const carriedOver = (row: KeyValueEntry): boolean =>
		previous === undefined ||
		("id" in row &&
			previous.some(
				(p) =>
					p.id === row.id &&
					p.key === row.key &&
					p.value === row.value &&
					writesBareKey(p) === writesBareKey(row)
			));

	const written = rows.map((row) =>
		claim(
			(pair) =>
				pair.key === row.key &&
				pair.value === row.value &&
				pair.valueless === writesBareKey(row)
		)
	);
	rows.forEach((row, i) => {
		if (written[i] !== undefined || !carriedOver(row)) return;
		written[i] = claim(
			(pair) => safeDecode(pair.key) === row.key && safeDecode(pair.value) === row.value
		);
	});
	const query = rows.map((row, i) => written[i] ?? writeQueryRow(row, encode)).join("&");
	return `${query ? `${base}?${query}` : base}${fragment}`;
}

/**
 * Parse the query string of a URL into key/value items, never decoded: a row
 * holds the query text as the URL spells it (`a%20b`), which is Postman's own
 * row model (`QueryParam.parse`) and the read side of `buildUrlWithParams`.
 *
 * Nothing is lost that way (issue #1771). Decoding is not reversible: `%2B`
 * decodes to a `+` a server then reads as a space, `%2541` to `%41`, and `%26`
 * inside a value to a new `&` pair. And since the query encoding never encodes
 * `%`, a raw row written back is the pair it came from. A pair with no `=`
 * (`?flag`) is a `valueless` row, so it is written back without one.
 */
export function parseQueryParams(url: string): KeyValueItem[] {
	return rawQueryPairs(url).map(({ key, value, valueless }) => ({
		id: generateId(),
		key,
		value,
		enabled: true,
		...(valueless && { valueless: true as const }),
	}));
}

/**
 * The params rows a URL states on its own, for a request that arrives with a
 * URL and no rows: its query, then a path row (empty value) per `:name`
 * segment (issue #1764).
 */
export function paramsFromUrl(url: string): KeyValueItem[] {
	return [...parseQueryParams(url), ...pathRowsFromUrl(url)];
}

/**
 * Merge the URL's query into the existing params rows, in place of replacing
 * them outright.
 *
 * A disabled row is invisible in the URL by design (`buildUrlWithParams` skips it),
 * so a wholesale replace with `parseQueryParams(url)` deletes every disabled
 * row on the next keystroke, and typing the query away leaves nothing to
 * remove the enabled rows it used to carry (issue #1482). Existing rows keep
 * their position, id, description and `source`; a key the URL no longer
 * carries is dropped, and a key new to the URL is appended at the end.
 *
 * Path rows (issue #1764) follow the URL's `:name` segments by their own rule,
 * `syncPathRows`, which reads `previousUrl` to tell an edit of those segments
 * from one that leaves them alone, and come after the query rows.
 */
export function mergeParamsFromUrl(
	existing: readonly KeyValueItem[],
	url: string,
	previousUrl: string
): KeyValueItem[] {
	const fromUrl = parseQueryParams(url);
	const consumed = new Array(fromUrl.length).fill(false);

	const merged: KeyValueItem[] = [];
	for (const row of queryRowsOf(existing)) {
		if (!row.enabled) {
			merged.push(row);
			continue;
		}
		const matchIndex = fromUrl.findIndex((p, i) => !consumed[i] && p.key === row.key);
		if (matchIndex === -1) continue; // the URL no longer carries this key
		consumed[matchIndex] = true;
		const { valueless: _was, ...rest } = row;
		const { value, valueless } = fromUrl[matchIndex];
		merged.push({ ...rest, value, ...(valueless && { valueless }) });
	}

	fromUrl.forEach((p, i) => {
		if (!consumed[i]) merged.push(p);
	});

	return [...merged, ...syncPathRows(pathRowsOf(existing), url, previousUrl)];
}

/** decodeURIComponent that leaves `{{var}}` tokens (and malformed input) untouched. */
export function safeDecode(part: string): string {
	if (part.includes("{{")) return part;
	try {
		return decodeURIComponent(part);
	} catch {
		return part;
	}
}
