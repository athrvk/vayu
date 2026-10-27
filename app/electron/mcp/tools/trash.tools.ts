/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file trash.tools.ts
 * @brief The trash: listing, restoring and purging deleted collections, requests,
 *        environments and saved examples.
 */

import { z } from "zod";
import { EngineRequestError } from "../engine-client.js";
import type { McpTool } from "./contract.js";
import {
	callEngine,
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
import { engineRefusalClass } from "./failure.js";
import { listPageInputs, listPageQuery, listPageSentence } from "./list-page.js";
import { trashPageSchema } from "./output-schemas.js";
import { PAGE_CURSOR_SENTENCE, pagedRead } from "./run-housekeeping.js";
import { describeTrashEntry, readTrashEntry, trashRefusalMessage, type TrashRow } from "./trash.js";
import { GUARDED_WRITE_SENTENCE } from "../remedy.js";

export const TRASH_TOOLS: McpTool[] = [
	{
		name: "list_trash",
		category: "read",
		invalidates: [],
		description:
			"List what delete_collection / delete_request / delete_environment / delete_request_example have sent to Vayu's Trash and can still be restored, newest first. " +
			listPageSentence("entries", "name") +
			" Answers ROOTS ONLY - the row a delete actually targeted, never what its cascade took with it: a deleted collection's whole subtree is one entry here, with `collections` and `requests` counting the sub-collections and saved requests that same delete took (0 for every other kind). Each entry also carries `kind` ('collection' | 'request' | 'environment' | 'example'), `name`, `deletedAt` (Unix ms) and `parentId` (the collection's old parent, the owning collection of a request, the owning request of an example, null for an environment); an environment entry alone also carries `variables`, how many variables it holds. Put one back with restore_trash_entry, or destroy it for good with purge_trash_entry. Rows are also purged automatically once older than the `trashRetentionDays` config entry (30 days by default; `0` keeps them forever - see get_engine_config). " +
			PAGE_CURSOR_SENTENCE,
		annotations: {
			title: "List trash",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: listPageInputs("entries"),
		outputSchema: trashPageSchema,
		handler: (args, ctx, signal) => {
			const query = listPageQuery(args);
			return pagedRead(ctx, () => ctx.client.listTrashPage(query, signal), "trash entries");
		},
	},
	{
		name: "restore_trash_entry",
		category: "write",
		// Every family a delete sends here: a restore can bring back any kind,
		// and there is no argument here that says which in advance - the same
		// reasoning move_item's pair carries.
		invalidates: ["collection", "request", "environment"],
		description:
			"Put a deleted collection, saved request, environment or saved example back from Vayu's Trash, with everything its delete took along - a restored collection's whole subtree returns too, scoped to that one delete's cohort (see list_trash), and an environment returns inactive, with all its variables. " +
			GUARDED_WRITE_SENTENCE +
			". This is NOT destructive - it restores data rather than removing it - so there is no confirmation step. A collection whose parent is gone, or is itself still in the trash, comes back at the top level instead of where it was (`reparentedToRoot: true` in the result); a request has no such fallback, so restoring one whose collection is itself deleted or gone is refused with a 409 naming the collection to restore first. A saved example is refused the same way when its request is deleted or gone, or already holds 100 examples. An `entryId` the trash does not hold - a live row, or one already purged - is a 404.",
		annotations: {
			title: "Restore from Trash",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			entryId: z.string().describe("Trash entry ID to restore (from list_trash)."),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const id = requireStr(args, "entryId");
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
					return errorResult(trashRefusalMessage(err), engineRefusalClass(err));
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
		invalidates: ["collection", "request", "environment"],
		description:
			"Permanently destroy one entry in Vayu's Trash, with its whole subtree - requests, and the examples they own - or, for an environment, every variable in it, or, for a saved example, that one example. THERE IS NO UNDO: this is the Trash's own hard delete, on top of the soft delete delete_collection / delete_request / delete_environment / delete_request_example already did, and once it runs the row is gone the way a delete used to be before Trash existed. " +
			GUARDED_WRITE_SENTENCE +
			", and confirmation: if the client supports elicitation the user is prompted with the entry's name and what it holds; otherwise call once for a preview, then again with `confirmed: true`. An `entryId` the trash does not hold is a 404, which also stops a mistyped id from destroying anything live.",
		annotations: {
			title: "Purge from Trash",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			entryId: z.string().describe("Trash entry ID to destroy for good (from list_trash)."),
			confirmed: confirmedInput("actually purge this trash entry for good"),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const id = requireStr(args, "entryId");
			// Read what the purge destroys before asking, the same reasoning
			// delete_collection reads its cascade first: an unreadable entry is a
			// refusal, never a prompt carrying a name and counts nobody verified.
			let entry: TrashRow;
			try {
				entry = await readTrashEntry(ctx.client, id, signal);
			} catch (err) {
				if (err instanceof ToolArgError) return errorResult(err.message, err.failureClass);
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
