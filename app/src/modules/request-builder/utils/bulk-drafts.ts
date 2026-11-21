/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Params and Headers tabs' Bulk edit drafts, and the one rule for turning
 * a draft's text into the request it describes (#3666).
 *
 * A draft is held by `RequestBuilderProvider`, filed under the builder's
 * `memoryKey`, not by `BulkEditor`: one provider serves every request tab and
 * Params / Headers unmount on every sub-tab switch, so a component-held draft
 * was either lost on a glance at another tab or committed into the next
 * request. Send and Save commit an open draft before they read the request,
 * which is why the commit is a pure patch here rather than the panel's own
 * `updateField` calls: the provider applies it to the snapshot it is about to
 * send, in the same tick, as well as to its state.
 */

import type { KeyValueItem } from "@/types";
import { withTrailingBlank } from "@/components/shared/KeyValueEditor/key-value";
import type { RequestState } from "../types";
import { isNoOpParamsEdit, parseParamsFromText } from "./params-format";
import { isNoOpHeadersEdit, parseHeadersFromText } from "./headers-format";
import { buildUrlWithParams } from "./url";
import { isPathRow, pathRowsOf } from "./path-variables";

/** The tables that have a Bulk edit. */
export type BulkTable = "params" | "headers";
const BULK_TABLES: readonly BulkTable[] = ["params", "headers"];

export interface BulkDraft {
	/** What the textarea holds. */
	text: string;
	/** The text the draft opened with, or was last committed at: `Discard` shows only once `text` differs. */
	opened: string;
}

/** One request's open drafts, at most one per table. */
export type BulkDrafts = Readonly<Partial<Record<BulkTable, BulkDraft>>>;

export const NO_BULK_DRAFTS: BulkDrafts = {};

type QuerySource = Pick<RequestState, "params" | "url" | "disableUrlEncoding">;
type BulkSource = QuerySource & Pick<RequestState, "headers">;

/**
 * The query table's rows written back beside the path rows it never shows, and
 * the URL's query rebuilt from them - the Params table's own edit and a params
 * draft's commit alike. `buildUrlWithParams` skips path rows itself, so the
 * `:name` segments stay as they are.
 *
 * A request sent unencoded (#1765) keeps its rows as typed in the URL too, or
 * the table would encode what the engine then sends raw. The rows before this
 * change tell an edited row from one carried over (#1771): only the latter may
 * keep a pair it matches decoded.
 */
export function queryTablePatch(
	request: QuerySource,
	rows: readonly KeyValueItem[]
): Pick<RequestState, "params" | "url"> {
	const params = [...rows.filter((row) => !isPathRow(row)), ...pathRowsOf(request.params)];
	const url = buildUrlWithParams(
		request.url,
		params,
		{ encode: !request.disableUrlEncoding },
		request.params
	);
	return { params, url };
}

/**
 * What committing `text` into `table` writes, or null when the text describes
 * the rows the table already holds: opening Bulk edit and leaving with nothing
 * typed must not re-enable a disabled row or dirty the request (#1480).
 */
export function bulkTextPatch(
	request: BulkSource,
	table: BulkTable,
	text: string
): Partial<RequestState> | null {
	if (table === "params") {
		if (isNoOpParamsEdit(text, request.params)) return null;
		return queryTablePatch(request, parseParamsFromText(text, request.params));
	}
	if (isNoOpHeadersEdit(text, request.headers)) return null;
	return { headers: withTrailingBlank(parseHeadersFromText(text)) };
}

/**
 * Every open draft's patch, merged. The tables write disjoint fields (params
 * and url, or headers), so each is computed against `request` as it stands.
 */
export function bulkDraftsPatch(
	request: BulkSource,
	drafts: BulkDrafts
): Partial<RequestState> | null {
	let patch: Partial<RequestState> | null = null;
	for (const table of BULK_TABLES) {
		const draft = drafts[table];
		const tablePatch = draft ? bulkTextPatch(request, table, draft.text) : null;
		if (tablePatch) patch = { ...(patch ?? {}), ...tablePatch };
	}
	return patch;
}

/** `drafts` with `table`'s draft replaced, or closed when `draft` is null. */
export function withBulkDraft(
	drafts: BulkDrafts,
	table: BulkTable,
	draft: BulkDraft | null
): BulkDrafts {
	const { [table]: _replaced, ...rest } = drafts;
	return draft ? { ...rest, [table]: draft } : rest;
}

/** Every draft still open, each now agreeing with what was just committed. */
export function rebasedBulkDrafts(drafts: BulkDrafts): BulkDrafts {
	const rebased: Partial<Record<BulkTable, BulkDraft>> = {};
	for (const table of BULK_TABLES) {
		const draft = drafts[table];
		if (draft) rebased[table] = { text: draft.text, opened: draft.text };
	}
	return rebased;
}
