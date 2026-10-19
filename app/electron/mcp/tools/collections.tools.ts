/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file collections.tools.ts
 * @brief Collection writes: create, update and delete.
 */

import { z } from "zod";
import { precedenceNote } from "../variable-origins.js";
import { WITHHELD_AUTH_SENTENCE, WITHHELD_VARIABLE_SENTENCE } from "../withhold.js";
import type { McpTool } from "./contract.js";
import {
	callEngine,
	collectionEchoShape,
	confirmDestructive,
	confirmedInput,
	elementsArg,
	engineErrorResult,
	errorResult,
	requireStr,
	str,
	ToolArgError,
	withCaveat,
	writesDisabled,
} from "./kit.js";
import {
	absentRemovalCaveat,
	mergeVariables,
	readVariablesPatch,
	removalNames,
	removeVariablesInput,
	variablesInput,
} from "./variable-blobs.js";
import { readAuthArg, readScriptEdits, scriptElement, upsertScriptElement } from "./compose.js";
import { collectionScriptInput, elementsInput, storedAuthInput } from "./input-schemas.js";
import { type CascadeScope, describeCascade, readCascadeScope } from "./cascade.js";

export const COLLECTION_TOOLS: McpTool[] = [
	{
		name: "create_collection",
		category: "write",
		invalidates: ["collection"],
		description:
			"Create a collection (the folder saved requests live in), with the variables, auth and elements (extractors, assertions, timers, scripts) every request inside it composes against. GUARDED: requires write access to be enabled in Vayu Settings. Pass `parentId` to nest it inside an existing collection; omit it for a top-level one. Returns the created collection - its `id` is what create_request takes as `collectionId`. " +
			precedenceNote(
				"Collection variables sit between globals and the active environment: they shadow globals, a nested collection shadows its ancestors, and the active environment shadows them all."
			) +
			" " +
			WITHHELD_VARIABLE_SENTENCE +
			" " +
			WITHHELD_AUTH_SENTENCE,
		annotations: {
			title: "Create collection",
			readOnlyHint: false,
			destructiveHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			name: z.string().describe("Display name for the collection."),
			parentId: z
				.string()
				.optional()
				.describe("Optional parent collection ID; omit for a top-level collection."),
			description: z.string().optional(),
			variables: variablesInput("the new collection"),
			auth: storedAuthInput(
				"this collection",
				'A collection is the root of an auth chain and never inherits, so "inherit" is refused by the engine; requests below it that store { mode: "inherit" } resolve to this block.'
			),
			elements: elementsInput("this collection"),
			preRequestScript: collectionScriptInput("pre"),
			postRequestScript: collectionScriptInput("post"),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const payload: Record<string, unknown> = { name: requireStr(args, "name") };
			const parentId = str(args, "parentId");
			if (parentId !== undefined) payload.parentId = parentId;
			const description = str(args, "description");
			if (description !== undefined) payload.description = description;
			const auth = readAuthArg(args);
			if (auth) payload.auth = auth;
			const patch = readVariablesPatch(args);
			// Merged against nothing, the way create_environment does it: on a
			// create every variable is new, which is what turns the string form
			// into a stored entry and enforces "a new variable carries a value".
			if (patch !== undefined)
				payload.variables = mergeVariables({}, patch, [], ctx).variables;
			const elementsGiven = elementsArg(args);
			const scriptEdits = readScriptEdits(args);
			if (elementsGiven !== undefined && scriptEdits.length > 0) {
				return errorResult(
					'Pass "elements" or "preRequestScript"/"postRequestScript", not both - add a "script.pre"/"script.post" entry to "elements" directly instead.'
				);
			}
			if (elementsGiven !== undefined) {
				payload.elements = elementsGiven;
			} else {
				// Scripts are `elements` on the wire (issue #1514). Nothing is
				// stored yet on a create, so the list is built outright rather
				// than merged.
				const elements: Record<string, unknown>[] = [];
				for (const [which, script] of scriptEdits) {
					if (script !== "") elements.push(scriptElement(which, script));
				}
				if (elements.length > 0) payload.elements = elements;
			}
			return callEngine(
				ctx,
				() => ctx.client.createCollection(payload, signal),
				collectionEchoShape(ctx)
			);
		},
	},
	{
		name: "update_collection",
		category: "write",
		invalidates: ["collection"],
		description:
			"Change a collection: its name, description, variables, auth or elements (extractors, assertions, timers, scripts) - the state every request inside it composes against. GUARDED: requires write access to be enabled in Vayu Settings. Only the fields you pass change, and the requests inside it are never touched. Variables merge: one you do not name is left alone, and a named one keeps every flag you do not state; removeVariables deletes names outright. Auth and elements each replace the stored block/list whole. This is not a move - to re-parent a collection, use move_item. " +
			precedenceNote(
				"Collection variables sit between globals and the active environment: they shadow globals, a nested collection shadows its ancestors, and the active environment shadows them all."
			) +
			" " +
			WITHHELD_VARIABLE_SENTENCE +
			" " +
			WITHHELD_AUTH_SENTENCE,
		annotations: {
			title: "Update collection",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z.string().describe("Collection ID to update."),
			name: z.string().optional().describe("New display name."),
			description: z.string().optional().describe("New description."),
			variables: variablesInput("this collection"),
			removeVariables: removeVariablesInput("this collection"),
			auth: storedAuthInput(
				"this collection",
				'A collection never inherits - it is the root of the chain - so the engine refuses "inherit" here; { mode: "none" } is how a collection stops being an auth source.'
			),
			elements: elementsInput("this collection"),
			preRequestScript: collectionScriptInput("pre"),
			postRequestScript: collectionScriptInput("post"),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const collectionId = requireStr(args, "collectionId");
			// The engine merge-patches, so a body naming nothing would be a write
			// that changes nothing while reporting success. Say so instead.
			const payload: Record<string, unknown> = {};
			for (const field of ["name", "description"] as const) {
				const value = str(args, field);
				if (value !== undefined) payload[field] = value;
			}
			const scriptEdits = readScriptEdits(args);
			const auth = readAuthArg(args);
			if (auth) payload.auth = auth;
			const patch = readVariablesPatch(args);
			const removals = removalNames(args);
			const elementsGiven = elementsArg(args);
			if (elementsGiven !== undefined && scriptEdits.length > 0) {
				return errorResult(
					'Pass "elements" or "preRequestScript"/"postRequestScript", not both - add a "script.pre"/"script.post" entry to "elements" directly instead.'
				);
			}
			if (
				Object.keys(payload).length === 0 &&
				scriptEdits.length === 0 &&
				elementsGiven === undefined &&
				patch === undefined &&
				removals.length === 0
			) {
				return errorResult(
					'Pass at least one field to change ("name", "description", "variables", "removeVariables", "auth", "elements", "preRequestScript" or "postRequestScript").'
				);
			}
			let absentRemovals: string[] = [];
			// One read serves both merges. `PUT /collections/:id` replaces the
			// whole variables blob and the whole `elements` list rather than
			// patching inside either, so "change one of them" is a
			// read-merge-write here - without the read, an agent setting one
			// variable would drop every other one the collection holds, and
			// setting one script would drop every other element on it. An
			// explicit `elements` argument needs no read: it already states
			// the whole list.
			if (patch !== undefined || removals.length > 0 || scriptEdits.length > 0) {
				let existing: Record<string, unknown>;
				try {
					existing = ((await ctx.client.getCollection(collectionId, signal)) ??
						{}) as Record<string, unknown>;
				} catch (err) {
					return engineErrorResult(err, ctx);
				}
				if (patch !== undefined || removals.length > 0) {
					const merged = mergeVariables(existing.variables, patch, removals, ctx);
					payload.variables = merged.variables;
					absentRemovals = merged.absentRemovals;
				}
				if (scriptEdits.length > 0) {
					let elements = existing.elements;
					for (const [which, script] of scriptEdits) {
						elements = upsertScriptElement(elements, which, script);
					}
					payload.elements = elements;
				}
			}
			if (elementsGiven !== undefined) {
				payload.elements = elementsGiven;
			}
			const result = await callEngine(
				ctx,
				() => ctx.client.updateCollection(collectionId, payload, signal),
				collectionEchoShape(ctx)
			);
			return result.isError
				? result
				: withCaveat(result, absentRemovalCaveat(absentRemovals));
		},
	},
	{
		name: "delete_collection",
		category: "write",
		invalidates: ["collection"],
		description:
			"Delete a collection AND EVERYTHING INSIDE IT - every nested sub-collection and every saved request in them. GUARDED: requires write access to be enabled in Vayu Settings, and confirmation: if the client supports elicitation the user is prompted with the number of sub-collections and requests this destroys; otherwise call once to see those counts, then again with `confirmed: true`. It goes to Vayu's Trash rather than disappearing outright - list_trash shows it there, and restore_trash_entry puts it back, until the retention window (`trashRetentionDays`, 30 days by default) runs out.",
		annotations: {
			title: "Delete collection",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z.string().describe("Collection ID to delete, with its whole subtree."),
			confirmed: confirmedInput("actually delete the collection and its contents"),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const collectionId = requireStr(args, "collectionId");
			// Read what the cascade takes before asking: an unreadable subtree is a
			// refusal, never a prompt carrying counts nobody verified.
			let scope: CascadeScope;
			try {
				scope = await readCascadeScope(ctx.client, collectionId, signal);
			} catch (err) {
				if (err instanceof ToolArgError) return errorResult(err.message);
				return engineErrorResult(err, ctx);
			}
			const cascade = describeCascade(scope);
			const unconfirmed = await confirmDestructive(args, ctx, {
				message: `Delete the collection "${scope.name}"?\n\n${cascade}`,
				acceptTitle: "Delete the collection",
				acceptDescription: "Confirm to delete it and everything inside it.",
				declined: "Collection not deleted - the user declined.",
				preview:
					"AWAITING CONFIRMATION - nothing was deleted.\n\n" +
					`${cascade}\n\n` +
					"This is a preview. To delete it, call delete_collection again with confirmed: true and the same arguments.",
			});
			if (unconfirmed) return unconfirmed;
			const result = await callEngine(ctx, () =>
				ctx.client.deleteCollection(collectionId, signal)
			);
			// The counts describe what was destroyed, so they belong only on a
			// delete that happened - a refusal wearing them would read as one.
			return result.isError
				? result
				: withCaveat(
						result,
						`\n\nDeleted "${scope.name}" with ${scope.descendants} sub-collection(s) and ${scope.requests} saved request(s).`
					);
		},
	},
];
