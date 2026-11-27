/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which rows of an MCP re-import diff the user means to write (#3994): what is ticked by default,
 * and the `select` body `POST /import/mcp/apply` takes. The judgement of what differs is the
 * diff's and the judgement of what each row writes is the apply's (the route's page); this holds
 * only the ticks, so the rule that matters is provable without a collection to damage: a removal
 * is never a default, because deleting a request takes everything saved on it.
 */

import type { ImportMcpApplySelect, ImportMcpDiffAdded, ImportMcpDiffMatch } from "@/types";

/** The ticked rows of one match of the diff. */
export interface McpSelection {
	/** An added entry has no request yet, so its id is the listing's own, `addedRowId`. */
	added: ReadonlySet<string>;
	/** Stored request ids. */
	changed: ReadonlySet<string>;
	/** Stored request ids. */
	removed: ReadonlySet<string>;
}

/** An entry of the listing, as the diff identifies it: `kind` never holds a colon, so this is one-to-one. */
export function addedRowId(entry: ImportMcpDiffAdded): string {
	return `${entry.kind}:${entry.key}`;
}

/** Added and changed are ticked, as a sync's are; removed is not, as a sync's is not. */
export function defaultMcpSelection(match: ImportMcpDiffMatch): McpSelection {
	return {
		added: new Set(match.added.map(addedRowId)),
		changed: new Set(match.changed.map((row) => row.requestId)),
		removed: new Set(),
	};
}

export function isEmptyMcpSelection(selection: McpSelection): boolean {
	return selection.added.size + selection.changed.size + selection.removed.size === 0;
}

/**
 * `set` with `id` in or out, as a new set. A selection is replaced rather than mutated, so a
 * stored one is never changed from under a render that has read it.
 */
export function withTicked(set: ReadonlySet<string>, id: string, on: boolean): Set<string> {
	const next = new Set(set);
	if (on) next.add(id);
	else next.delete(id);
	return next;
}

/**
 * The route's `select`: the ticked rows, in the order the diff lists them. Built from the match
 * and not from the ids alone, so an id that is not one of its rows (a stale tick) is never sent.
 */
export function buildMcpSelect(
	match: ImportMcpDiffMatch,
	selection: McpSelection
): ImportMcpApplySelect {
	return {
		added: match.added
			.filter((entry) => selection.added.has(addedRowId(entry)))
			.map(({ kind, key }) => ({ kind, key })),
		changed: match.changed
			.filter((row) => selection.changed.has(row.requestId))
			.map((row) => row.requestId),
		removed: match.removed
			.filter((row) => selection.removed.has(row.requestId))
			.map((row) => row.requestId),
	};
}
