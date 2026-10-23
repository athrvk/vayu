/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file list-page.ts
 * @brief The arguments and row shaping the paged whole-list reads share:
 *        `list_collections`, `list_requests`, `get_cookies` and `list_trash`
 *        (#2443).
 *
 * The engine filters and pages (`q` / `limit` / `offset`); the summary
 * projection is this side's, because it runs after the secret withholding: a
 * request's `url` is masked by reading its `auth` (an API key placed in the
 * query), so a row projected first would lose what masks it.
 */

import { z } from "zod";
import {
	DEFAULT_LIST_PAGE_LIMIT,
	MAX_ENGINE_PAGE_LIMIT,
	type ListPageQuery,
} from "../engine-client.js";
import { isRecord, optionalOffset, optionalPageLimit, str, ToolArgError } from "./kit.js";

/** The envelope clause each paged list's description carries, sized for @p noun. */
export function listPageSentence(noun: string, filtered: string): string {
	return `Returns a {data, pagination} envelope of at most ${DEFAULT_LIST_PAGE_LIMIT} ${noun} by default (${MAX_ENGINE_PAGE_LIMIT} max), \`q\` filtering by ${filtered}.`;
}

/** The `q` / `limit` / `offset` arguments, worded for @p noun. */
export function listPageInputs(noun: string) {
	return {
		q: z.string().optional().describe("Case-insensitive substring filter."),
		limit: z
			.number()
			.int()
			.positive()
			.max(MAX_ENGINE_PAGE_LIMIT)
			.optional()
			.describe(
				`How many ${noun} to return (default ${DEFAULT_LIST_PAGE_LIMIT}, max ${MAX_ENGINE_PAGE_LIMIT}).`
			),
		offset: z
			.number()
			.int()
			.nonnegative()
			.optional()
			.describe(`How many ${noun} to skip, for paging (default 0).`),
	};
}

const ROW_FIELDS = ["summary", "full"] as const;

/** The `fields` argument: the summary row by default, the whole row on request. */
export const fieldsInput = z
	.enum(ROW_FIELDS)
	.optional()
	.describe('"full" for whole rows; default "summary".');

/**
 * The page a call asks the engine for. Built before the engine call, so an
 * argument the caller got wrong reaches dispatch as a {@link ToolArgError}
 * rather than as an engine failure.
 */
export function listPageQuery(args: Record<string, unknown>): ListPageQuery {
	const query: ListPageQuery = {
		limit: optionalPageLimit(args, "limit", DEFAULT_LIST_PAGE_LIMIT, MAX_ENGINE_PAGE_LIMIT),
		offset: optionalOffset(args, "offset"),
	};
	const q = str(args, "q");
	if (q !== undefined) query.q = q;
	return query;
}

/** Whether the call asked for whole rows; anything but the two spellings is refused. */
export function wantsFullRows(args: Record<string, unknown>): boolean {
	const fields = args.fields;
	if (fields === undefined || fields === null || fields === "summary") return false;
	if (fields === "full") return true;
	throw new ToolArgError('"fields" must be "summary" or "full".');
}

/** @p page with @p mapRow applied to each `data` row; anything else passes through. */
export function mapPageRows(page: unknown, mapRow: (row: unknown) => unknown): unknown {
	if (!isRecord(page) || !Array.isArray(page.data)) return page;
	return { ...page, data: page.data.map(mapRow) };
}

/** @p page with each row cut to the @p keys it carries. */
export function projectPageRows(page: unknown, keys: readonly string[]): unknown {
	return mapPageRows(page, (row) =>
		isRecord(row)
			? Object.fromEntries(keys.filter((k) => k in row).map((k) => [k, row[k]]))
			: row
	);
}
