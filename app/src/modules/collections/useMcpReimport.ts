/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Import dialog's "Update existing" (#3994): the ticks of an MCP re-import diff, and the one
 * call that writes them to the collection it compared. Beside `McpReimportDiff`, which draws the
 * rows, and `ImportModal`, which draws the button and the delete confirm.
 *
 * **What an update sends is what the diff was computed from.** The request is the one the connect
 * stashed on the entry (`BatchEntry.mcpRequest`), never the form's present values: the user may
 * have edited the form since (a different token, another header), and the engine re-reads the
 * server and checks each ticked row against *that* read, so a different request would be a diff
 * the user was not shown.
 *
 * The ticks are kept for one comparison, identified by its entry: a new connect makes a new entry,
 * so a tick of an earlier comparison (a request id the next diff may name for another row) is never
 * carried over. The state holds the entry only while it is the one on screen, because the entry
 * carries the bearer token: a dismissed preview or a closed dialog drops it on the next render.
 */

import { useState } from "react";

import { useImportMcpApplyMutation } from "@/queries/import-mcp";
import { ApiError } from "@/services/http-client";
import { pluralize } from "@/modules/dashboard/utils/format";
import type { BatchEntry } from "@/services/importers/batch";
import type { ImportMcpApplyResponse, ImportMcpDiffMatch } from "@/types";
import { buildMcpSelect, defaultMcpSelection, type McpSelection } from "./mcp-reimport-selection";

interface UpdateState {
	/** The comparison the ticks, the error and the confirm belong to. */
	comparison: BatchEntry | null;
	/** The ticks the user moved; a match not in here is at its defaults. */
	selections: Record<string, McpSelection>;
	/** Why the last update did not land, shown until the next attempt. */
	error: Error | null;
	/** The match whose update waits on the delete confirm. */
	confirming: string | null;
}

function freshState(comparison: BatchEntry | null): UpdateState {
	return { comparison, selections: {}, error: null, confirming: null };
}

/**
 * The line under the preview when an update did not land. A 409 is the engine saying the server's
 * listing no longer matches the comparison, and says nothing was written; what to do next is this
 * line's, since the answer to a stale diff is to compare again, not to press the button again.
 */
export function mcpUpdateFailureMessage(error: Error): string {
	const base = `Couldn't update the collection - ${error.message.replace(/\.$/, "")}`;
	if (!(error instanceof ApiError) || error.statusCode !== 409) return base;
	return `${base}. Nothing was written: dismiss this preview and connect again to compare, then choose from the new answer.`;
}

/** "Updated "Acme tools" - 1 request created, 2 updated, 1 deleted.", as a sync reports its counts. */
export function mcpUpdateToastMessage(name: string, response: ImportMcpApplyResponse): string {
	const created = response.created.length;
	return (
		`Updated "${name}" - ${created} ${pluralize(created, "request")} created, ` +
		`${response.updated.length} updated, ${response.deleted.length} deleted.`
	);
}

/** An update that landed: the match it wrote to and what the engine answered. */
export interface McpApplied {
	match: ImportMcpDiffMatch;
	response: ImportMcpApplyResponse;
}

export interface McpReimport {
	selectionFor: (match: ImportMcpDiffMatch) => McpSelection;
	setSelection: (collectionId: string, next: McpSelection) => void;
	/**
	 * Writes the ticked rows of one match, after the delete confirm when any removal is ticked.
	 * Settles with what landed, or `null` when nothing did (it is waiting on the confirm, or failed).
	 */
	update: (collectionId: string) => Promise<McpApplied | null>;
	/** The removals a confirmed update would delete, while the confirm is open. */
	confirming: { collectionId: string; deleteCount: number } | null;
	cancelConfirm: () => void;
	confirmUpdate: () => Promise<McpApplied | null>;
	isPending: boolean;
	error: Error | null;
}

/** @param entry the MCP tab's one entry, or `null` when it is not the one on screen. */
export function useMcpReimport(entry: BatchEntry | null): McpReimport {
	const apply = useImportMcpApplyMutation();
	const matches = entry?.existingMcp;
	const [stored, setStored] = useState(() => freshState(entry));
	if (stored.comparison !== entry) setStored(freshState(entry));
	const state = stored.comparison === entry ? stored : freshState(entry);
	const patch = (change: Partial<UpdateState>) =>
		setStored((previous) => ({
			...(previous.comparison === entry ? previous : freshState(entry)),
			...change,
		}));

	const selectionFor = (match: ImportMcpDiffMatch): McpSelection =>
		state.selections[match.collectionId] ?? defaultMcpSelection(match);

	const setSelection = (collectionId: string, next: McpSelection) =>
		setStored((previous) => {
			const base = previous.comparison === entry ? previous : freshState(entry);
			return { ...base, selections: { ...base.selections, [collectionId]: next } };
		});

	const write = async (collectionId: string): Promise<McpApplied | null> => {
		const request = entry?.mcpRequest;
		const match = matches?.find((m) => m.collectionId === collectionId);
		if (!request || !match) return null;
		patch({ error: null });
		let response: ImportMcpApplyResponse;
		try {
			response = await apply.mutateAsync({
				...request,
				collectionId,
				select: buildMcpSelect(match, selectionFor(match)),
			});
		} catch (e) {
			// The confirm stays open while the call runs, showing it, and closes on either answer.
			patch({ error: e instanceof Error ? e : new Error(String(e)), confirming: null });
			return null;
		}
		patch({ confirming: null });
		return { match, response };
	};

	const update = async (collectionId: string): Promise<McpApplied | null> => {
		if (apply.isPending) return null;
		const match = matches?.find((m) => m.collectionId === collectionId);
		// Counted from what is sent: a removal a ticked rename stands in for deletes nothing.
		if (!match || buildMcpSelect(match, selectionFor(match)).removed.length === 0) {
			return write(collectionId);
		}
		patch({ confirming: collectionId });
		return null;
	};

	const confirmingMatch = matches?.find((m) => m.collectionId === state.confirming);
	return {
		selectionFor,
		setSelection,
		update,
		confirming: confirmingMatch
			? {
					collectionId: confirmingMatch.collectionId,
					deleteCount: buildMcpSelect(confirmingMatch, selectionFor(confirmingMatch))
						.removed.length,
				}
			: null,
		cancelConfirm: () => patch({ confirming: null }),
		confirmUpdate: async () => (state.confirming === null ? null : write(state.confirming)),
		isPending: apply.isPending,
		error: state.error,
	};
}
