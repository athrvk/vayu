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
 * tab's "Sends" line need to agree with the engine on.
 */

import type { KeyValueEntry, KeyValueItem } from "@/types";
import { generateId } from "@/lib/id";
import { containsVariableToken } from "@/constants/variables";

/**
 * A whole path segment that is a path variable: `:` then one or more of
 * `[A-Za-z0-9_.-]`. The engine's composer and importer use the same class.
 */
export const PATH_VARIABLE_SEGMENT = /^:([A-Za-z0-9_.-]+)$/;

interface PathVariableOccurrence {
	name: string;
	/** Offset of the `:` in the URL. */
	start: number;
	/** Offset one past the segment's last character. */
	end: number;
}

/**
 * Every `:name` segment of the URL's path, in order, repeats included.
 *
 * The path starts at the first `/` after the authority (after `://` when the
 * URL has a scheme, else at the first `/`), so a port (`host:8080`) and a
 * `{{baseUrl}}` host are never segments. It ends at the first `?` or `#`, so a
 * `:x` in the query or the fragment is never one either.
 */
function occurrences(url: string): PathVariableOccurrence[] {
	const queryOrHash = url.search(/[?#]/);
	const end = queryOrHash === -1 ? url.length : queryOrHash;
	const scheme = url.slice(0, end).indexOf("://");
	const pathStart = url.indexOf("/", scheme === -1 ? 0 : scheme + 3);
	if (pathStart === -1 || pathStart >= end) return [];

	const found: PathVariableOccurrence[] = [];
	let offset = pathStart + 1;
	for (const segment of url.slice(pathStart + 1, end).split("/")) {
		const match = PATH_VARIABLE_SEGMENT.exec(segment);
		if (match) found.push({ name: match[1], start: offset, end: offset + segment.length });
		offset += segment.length + 1;
	}
	return found;
}

/** The path-variable names in the URL, first occurrence order, each once. */
export function pathVariableNames(url: string): string[] {
	return [...new Set(occurrences(url).map((o) => o.name))];
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

/**
 * The path rows as the stored/sent shape (no editor `id`), for an inline
 * `POST /compose` - the engine reads them from `request.params`, the same
 * member a stored request carries them in.
 */
export function pathEntriesOf(rows: readonly KeyValueEntry[]): KeyValueEntry[] {
	return pathRowsOf(rows).map(({ key, value, enabled, description, in: location }) => ({
		key,
		value,
		enabled,
		...(description ? { description } : {}),
		in: location,
	}));
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
 * The path rows the URL now calls for, carried over from `existing`.
 *
 * A name still in the URL keeps its row (value, description, enabled, id). A
 * name that left the URL loses its row - unless a new name arrived in its
 * place, in which case the row is renamed and keeps its value: Postman's
 * behaviour, and what typing `:userId` over `:id` one keystroke at a time
 * needs, since every keystroke is a rename. Leftover names pair with leftover
 * rows by position; a name with no row left to take gets an empty one. The
 * result follows the URL's order.
 *
 * Unlike a query row, a disabled path row is still in the URL (the segment is
 * there whether or not the value is sent), so it is matched like any other.
 */
export function syncPathRows(existing: readonly KeyValueItem[], url: string): KeyValueItem[] {
	const names = pathVariableNames(url);
	const byName = new Map<string, KeyValueItem>();
	for (const row of existing) if (!byName.has(row.key)) byName.set(row.key, row);

	const leftoverRows = existing.filter(
		(row) => byName.get(row.key) === row && !names.includes(row.key)
	);
	return names.map((name) => {
		const kept = byName.get(name);
		if (kept) return kept;
		const renamed = leftoverRows.shift();
		return renamed ? { ...renamed, key: name } : newPathRow(name);
	});
}

/**
 * Percent-encode a value as one path segment: everything but RFC 3986's
 * unreserved set (`A-Za-z0-9-._~`), so a `/` in a value cannot become a second
 * segment. Stricter than `encodeURIComponent`, which leaves `!'()*` alone.
 */
function encodeSegment(value: string): string {
	return encodeURIComponent(value).replace(
		/[!'()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
	);
}

/**
 * The URL with each `:name` segment replaced by its row's value - what the
 * engine sends.
 *
 * Only an enabled path row with a non-empty value substitutes; anything else
 * leaves the segment literal (`:id` goes out as written, as Postman sends it).
 * A value holding a `{{variable}}` is left unencoded, the query builder's own
 * rule: it resolves later, and encoding the braces would send them literally.
 */
export function substitutePathVariables(url: string, rows: readonly KeyValueEntry[]): string {
	const values = new Map<string, string>();
	for (const row of rows) {
		if (!isPathRow(row) || !row.enabled || !row.value || values.has(row.key)) continue;
		values.set(row.key, row.value);
	}
	if (values.size === 0) return url;

	let out = url;
	for (const o of occurrences(url).reverse()) {
		const value = values.get(o.name);
		if (value === undefined) continue;
		const written = containsVariableToken(value) ? value : encodeSegment(value);
		out = out.slice(0, o.start) + written + out.slice(o.end);
	}
	return out;
}

/**
 * The `params` member an inline `POST /compose` request carries: the path rows
 * alone, so the engine can fill the `:name` segments of the editor's URL, which
 * may be ahead of the saved row. The query rows are not sent - the URL already
 * holds them. Spread into the request; nothing when there are no path rows, so
 * a request without them composes exactly as before.
 */
export function composePathParams(rows: readonly KeyValueEntry[]): { params?: KeyValueEntry[] } {
	const params = pathEntriesOf(rows);
	return params.length > 0 ? { params } : {};
}
