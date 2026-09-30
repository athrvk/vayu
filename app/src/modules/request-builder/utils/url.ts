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
	/** The pair exactly as the URL spells it. */
	text: string;
}

/**
 * The URL's query pairs, never decoded: split on `&`, then on the first `=`.
 * Empty pairs (`a=1&&b=2`) are dropped.
 */
function rawQueryPairs(url: string): RawQueryPair[] {
	const queryStart = url.indexOf("?");
	if (queryStart === -1) return [];
	return url
		.slice(queryStart + 1)
		.split("&")
		.filter(Boolean)
		.map((text) => {
			const separator = text.indexOf("=");
			return separator === -1
				? { key: text, value: "", text }
				: { key: text.slice(0, separator), value: text.slice(separator + 1), text };
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

/**
 * One row as `key=value`, encoded with Postman's query rule
 * (`encodeQueryComponent`, issue #1771), or as typed under `encode: false`.
 *
 * A row with no value writes as a bare key (`?page`, not `?page=`) - legal, and
 * the same shape `formatParamsToText` shows the user for that row.
 *
 * `encode: false` is a request's `disableUrlEncoding` (issue #1765): the row
 * is written as typed, so `q=a|b` stays `a|b` in the URL the engine sends.
 */
function writeQueryRow(row: KeyValueEntry, encode: boolean): string {
	const key = encode ? encodeQueryComponent(row.key, "key") : row.key;
	if (!row.value) return key;
	return `${key}=${encode ? encodeQueryComponent(row.value, "value") : row.value}`;
}

/**
 * The URL that expresses exactly these params: the rows *replace* whatever
 * query the URL carried.
 *
 * This is the Params table's rule, and only the table's - there the rows are
 * the whole truth of the query, so deleting the last one has to clear it.
 *
 * A row the URL already carries keeps the URL's own bytes (issue #1771): each
 * enabled row takes the first unused pair with the same key and value, compared
 * as written or through `safeDecode`, and only a row with no such pair is
 * encoded. So an edit rewrites only the pairs it touches, and a pair written by
 * another rule survives it: `%2B05%3A00` held as the decoded row `+05:00` by an
 * older version (re-encoding would send a `+` a server reads as a space), an
 * Insomnia or OpenAPI import's `encodeURIComponent` join, or a Postman `key=`.
 */
export function buildUrlWithParams(
	baseUrl: string,
	params: readonly KeyValueEntry[],
	{ encode = true }: UrlEncodeOptions = {}
): string {
	const queryStart = baseUrl.indexOf("?");
	const base = queryStart === -1 ? baseUrl : baseUrl.slice(0, queryStart);
	const pairs = rawQueryPairs(baseUrl);
	const used = new Array<boolean>(pairs.length).fill(false);
	const query = queryRowsToWrite(params)
		.map((row) => {
			const match = pairs.findIndex(
				(pair, i) =>
					!used[i] &&
					((pair.key === row.key && pair.value === row.value) ||
						(safeDecode(pair.key) === row.key && safeDecode(pair.value) === row.value))
			);
			if (match === -1) return writeQueryRow(row, encode);
			used[match] = true;
			return pairs[match].text;
		})
		.join("&");
	return query ? `${base}?${query}` : base;
}

/**
 * Parse the query string of a URL into key/value items, never decoded: a row
 * holds the query text as the URL spells it (`a%20b`), which is Postman's own
 * row model (`QueryParam.parse`) and the read side of `buildUrlWithParams`.
 *
 * Nothing is lost that way (issue #1771). Decoding is not reversible: `%2B`
 * decodes to a `+` a server then reads as a space, `%2541` to `%41`, and `%26`
 * inside a value to a new `&` pair. And since the query encoding never encodes
 * `%`, a raw row written back is the pair it came from.
 */
export function parseQueryParams(url: string): KeyValueItem[] {
	return rawQueryPairs(url).map(({ key, value }) => ({
		id: generateId(),
		key,
		value,
		enabled: true,
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
		merged.push({ ...row, value: fromUrl[matchIndex].value });
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
