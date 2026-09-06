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
import { containsVariableToken } from "@/constants/variables";

/**
 * Render the enabled, keyed rows as a query string, without a leading `?`.
 *
 * A row with no value writes as a bare key (`?page`, not `?page=`) - legal, and
 * the same shape `formatParamsToText` shows the user for that row.
 *
 * A segment holding a `{{variable}}` is left unencoded: it is resolved at
 * request time, and percent-encoding the braces here would send them literally.
 */
function toQueryString(params: readonly KeyValueEntry[]): string {
	return params
		.filter((p) => p.enabled && p.key.trim())
		.map((p) => {
			const key = containsVariableToken(p.key) ? p.key : encodeURIComponent(p.key);
			const value = containsVariableToken(p.value) ? p.value : encodeURIComponent(p.value);
			return p.value ? `${key}=${value}` : key;
		})
		.join("&");
}

/**
 * The URL that expresses exactly these params: the rows *replace* whatever
 * query the URL carried.
 *
 * This is the Params table's rule, and only the table's - there the rows are
 * the whole truth of the query, so deleting the last one has to clear it. An
 * importer must not use this: a source URL can carry a query the source did not
 * also list as a param, and replacing would drop it. See `appendParamsToUrl`.
 */
export function buildUrlWithParams(baseUrl: string, params: readonly KeyValueEntry[]): string {
	const queryStart = baseUrl.indexOf("?");
	const base = queryStart === -1 ? baseUrl : baseUrl.slice(0, queryStart);
	const query = toQueryString(params);
	return query ? `${base}?${query}` : base;
}

/**
 * Append these params to whatever query the URL already carries.
 *
 * The import rule, where `url` and `params[]` are two independent statements by
 * the source: Postman splits its query out of the URL (leaving the URL with
 * none), while Insomnia keeps the URL verbatim beside a separate `parameters[]`
 * - and appending the two is exactly what Insomnia itself does on send.
 */
export function appendParamsToUrl(url: string, params: readonly KeyValueEntry[]): string {
	const query = toQueryString(params);
	if (!query) return url;
	if (!url.includes("?")) return `${url}?${query}`;
	// A URL ending in `?` or `&` is already sitting on its separator.
	return /[?&]$/.test(url) ? `${url}${query}` : `${url}&${query}`;
}

/**
 * Parse the query string of a URL into key/value items.
 *
 * Variable tokens (`{{var}}`) are preserved verbatim - decoding is skipped for
 * any segment that contains them so the variable syntax survives round-trips.
 */
export function parseQueryParams(url: string): KeyValueItem[] {
	try {
		const queryStart = url.indexOf("?");
		if (queryStart === -1) return [];

		const queryString = url.slice(queryStart + 1);
		if (!queryString) return [];

		const pairs = queryString.split("&").filter(Boolean);

		return pairs.map((pair) => {
			const [key, ...valueParts] = pair.split("=");
			const value = valueParts.join("=");
			return {
				id: generateId(),
				key: safeDecode(key || ""),
				value: safeDecode(value || ""),
				enabled: true,
			};
		});
	} catch {
		return [];
	}
}

/**
 * Merge the URL's query into the existing params rows, in place of replacing
 * them outright.
 *
 * A disabled row is invisible in the URL by design (`toQueryString` skips it),
 * so a wholesale replace with `parseQueryParams(url)` deletes every disabled
 * row on the next keystroke, and typing the query away leaves nothing to
 * remove the enabled rows it used to carry (issue #1482). Existing rows keep
 * their position, id, description and `source`; a key the URL no longer
 * carries is dropped, and a key new to the URL is appended at the end.
 */
export function mergeParamsFromUrl(existing: readonly KeyValueItem[], url: string): KeyValueItem[] {
	const fromUrl = parseQueryParams(url);
	const consumed = new Array(fromUrl.length).fill(false);

	const merged: KeyValueItem[] = [];
	for (const row of existing) {
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

	return merged;
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
