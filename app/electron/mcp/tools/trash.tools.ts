/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file trash.tools.ts
 * @brief The trash: listing, restoring and purging deleted collections and requests.
 */

import { z } from "zod";
import { EngineRequestError } from "../engine-client.js";
import type { McpTool } from "./contract.js";
import {
	callEngine,
	callEngineStructured,
	confirmDestructive,
	confirmedInput,
	echoShape,
	engineErrorResult,
	errorResult,
	isRecord,
	jsonResult,
	requireStr,
	ToolArgError,
	withCaveat,
	writesDisabled,
} from "./kit.js";
import { trashListSchema } from "./output-schemas.js";
import { describeTrashEntry, readTrashEntry, trashRefusalMessage, type TrashRow } from "./trash.js";
import { GUARDED_WRITE_SENTENCE } from "../remedy.js";

export const TRASH_TOOLS: McpTool[] = [
	{
		name: "list_trash",
		category: "read",
		invalidates: [],
		description:
			"List what delete_collection / delete_request have sent to Vayu's Trash and can still be restored, newest first. Answers ROOTS ONLY - the row a delete actually targeted, never what its cascade took with it: a deleted collection's whole subtree is one entry here, with `collections` and `requests` counting the sub-collections and saved requests that same delete took (always 0 for a request). Each entry also carries `kind` ('collection' | 'request'), `name`, `deletedAt` (Unix ms) and `parentId` (the collection's old parent, or the request's owning collection). Put one back with restore_trash_entry, or destroy it for good with purge_trash_entry. Rows are also purged automatically once older than the `trashRetentionDays` config entry (30 days by default; `0` keeps them forever - see get_engine_config).",
		annotations: {
			title: "List trash",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		outputSchema: trashListSchema,
		handler: (_args, ctx, signal) =>
			callEngineStructured(ctx, () => ctx.client.listTrash(signal)),
	},
	{
		name: "restore_trash_entry",
		category: "write",
		// Both families: a restore can bring back either kind, and there is no
		// argument here that says which in advance - the same reasoning
		// move_item's pair carries.
		invalidates: ["collection", "request"],
		description:
			"Put a deleted collection or saved request back from Vayu's Trash, with everything its delete took along - a restored collection's whole subtree returns too, scoped to that one delete's cohort (see list_trash). " +
			GUARDED_WRITE_SENTENCE +
			". This is NOT destructive - it restores data rather than removing it - so there is no confirmation step. A collection whose parent is gone, or is itself still in the trash, comes back at the top level instead of where it was (`reparentedToRoot: true` in the result); a request has no such fallback, so restoring one whose collection is itself deleted or gone is refused with a 409 naming the collection to restore first. An id the trash does not hold - a live row, or one already purged - is a 404.",
		annotations: {
			title: "Restore from Trash",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			id: z.string().describe("Trash entry ID to restore (from list_trash)."),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const id = requireStr(args, "id");
			let restored: Record<string, unknown>;
			try {
				const value = await ctx.client.restoreTrashEntry(id, signal);
				restored = isRecord(value) ? value : {};
			} catch (err) {
				// The engine's own message already names the fix (a wrong id, or
				// which collection to restore first) - surface it rather than
				// writing a second sentence that could disagree with it.
				if (
					err instanceof EngineRequestError &&
					(err.status === 404 || err.status === 409)
				) {
					return errorResult(trashRefusalMessage(err));
				}
				return engineErrorResult(err, ctx);
			}
			const result = jsonResult(echoShape(ctx)(restored));
			// A moved folder is worth telling the caller about - it is not where it
			// used to be, even though the restore itself succeeded.
			return restored.reparentedToRoot === true
				? withCaveat(
						result,
						"\n\nRestored at the top level: its original parent is gone or itself in the trash, so it came back as a tree root rather than where it was."
					)
				: result;
		},
	},
	{
		name: "purge_trash_entry",
		category: "write",
		invalidates: ["collection", "request"],
		description:
			"Permanently destroy one entry in Vayu's Trash, with its whole subtree - requests, and the examples they own. THERE IS NO UNDO: this is the Trash's own hard delete, on top of the soft delete delete_collection / delete_request already did, and once it runs the row is gone the way a delete used to be before Trash existed. " +
			GUARDED_WRITE_SENTENCE +
			", and confirmation: if the client supports elicitation the user is prompted with the entry's name and what it holds; otherwise call once for a preview, then again with `confirmed: true`. An id the trash does not hold is a 404, which also stops a mistyped id from destroying anything live.",
		annotations: {
			title: "Purge from Trash",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			id: z.string().describe("Trash entry ID to destroy for good (from list_trash)."),
			confirmed: confirmedInput("actually purge this trash entry for good"),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const id = requireStr(args, "id");
			// Read what the purge destroys before asking, the same reasoning
			// delete_collection reads its cascade first: an unreadable entry is a
			// refusal, never a prompt carrying a name and counts nobody verified.
			let entry: TrashRow;
			try {
				entry = await readTrashEntry(ctx.client, id, signal);
			} catch (err) {
				if (err instanceof ToolArgError) return errorResult(err.message);
				return engineErrorResult(err, ctx);
			}
			const subject = describeTrashEntry(entry);
			const unconfirmed = await confirmDestructive(args, ctx, {
				message: `Permanently destroy ${subject}?\n\nThere is no undo.`,
				acceptTitle: "Purge from Trash",
				acceptDescription: "Confirm to destroy it for good.",
				declined: "Nothing purged - the user declined.",
				preview:
					"AWAITING CONFIRMATION - nothing was purged.\n\n" +
					`This would permanently destroy ${subject}. There is no undo.\n\n` +
					"This is a preview. To purge it, call purge_trash_entry again with confirmed: true and the same arguments.",
			});
			if (unconfirmed) return unconfirmed;
			return callEngine(ctx, () => ctx.client.purgeTrashEntry(id, signal));
		},
	},
];
