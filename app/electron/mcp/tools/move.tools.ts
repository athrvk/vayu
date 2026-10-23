/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file move.tools.ts
 * @brief `move_item`: reordering and reparenting collections and requests.
 */

import { z } from "zod";
import { presentReorderCollections } from "../collection-shape.js";
import { secretsShape, withholdReorderRows, withheldPointer } from "../withhold.js";
import type { McpTool, ToolContext } from "./contract.js";
import {
	callEngine,
	engineErrorResult,
	errorResult,
	requireStr,
	str,
	ToolArgError,
	writesDisabled,
} from "./kit.js";
import { collectionSubtree, readCollectionRows } from "./cascade.js";
import { destinationSiblings, MOVE_POSITIONS, moveBatch } from "./move.js";
import { readRequestRows } from "./sibling-order.js";
import { GUARDED_WRITE_SENTENCE } from "../remedy.js";

export const MOVE_TOOLS: McpTool[] = [
	{
		name: "move_item",
		category: "write",
		/*
		 * Both families, and the pair is load-bearing rather than cautious. The
		 * `request` event narrows on the `collectionId` the call named, which for
		 * a move is the *destination* - the list the row left would stay stale on
		 * its own. `collection` is the coarse one (`collections.all` +
		 * `requests.all`), so it covers the source list, the two parents' orders,
		 * and the subtree a moved collection took with it.
		 */
		invalidates: ["collection", "request"],
		description: (config) =>
			"Move a collection or a saved request into another collection - the row menu's 'Move to…', over MCP. " +
			GUARDED_WRITE_SENTENCE +
			". It lands at the end of its new parent by default, after the sub-collections and requests there alike (the two share one order, so a request can sit between folders), or at the front with `position: 'first'`; positions in between stay a UI gesture, because naming one means doing the app's ordering arithmetic from the outside. A collection may move to the top level (`parentId: null`); a request always belongs to a collection. Refused, with nothing written, when a collection would move into itself or into its own subtree." +
			withheldPointer(config),
		annotations: {
			title: "Move an item",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			type: z
				.enum(["collection", "request"])
				.describe("What is being moved: a collection (folder) or a saved request."),
			id: z.string().describe("ID of the collection or request to move."),
			parentId: z
				.string()
				.nullable()
				.optional()
				.describe(
					"Destination for a collection: another collection's id, or null for the top level. Required when `type` is 'collection'."
				),
			collectionId: z
				.string()
				.optional()
				.describe(
					"Destination collection for a request. Required when `type` is 'request'."
				),
			position: z
				.enum(MOVE_POSITIONS)
				.optional()
				.describe("Where it lands among its new siblings: 'last' (default) or 'first'."),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const type = requireStr(args, "type");
			if (type !== "collection" && type !== "request") {
				return errorResult('"type" must be "collection" or "request".', "input");
			}
			const id = requireStr(args, "id");
			// Read off the raw value rather than through `str`, which answers
			// `undefined` for a non-string: a `position: 0` would then default to
			// "last" and land the row at the opposite end of the one it named.
			const position = args.position === undefined ? "last" : args.position;
			if (position !== "first" && position !== "last") {
				return errorResult('"position" must be "first" or "last".', "input");
			}

			let batch: Record<string, unknown>;
			try {
				batch =
					type === "collection"
						? await planCollectionMove(args, id, position, ctx, signal)
						: await planRequestMove(args, id, position, ctx, signal);
			} catch (err) {
				if (err instanceof ToolArgError) return errorResult(err.message, err.failureClass);
				return engineErrorResult(err, ctx);
			}
			const withhold = secretsShape(ctx, withholdReorderRows);
			return callEngine(
				ctx,
				() => ctx.client.reorder(batch, signal),
				(answer) => withhold(presentReorderCollections(answer, ctx))
			);
		},
	},
];

/**
 * The batch that moves collection `id` under the `parentId` the call states.
 * Throws {@link ToolArgError} for a refusal; engine failures propagate.
 */
async function planCollectionMove(
	args: Record<string, unknown>,
	id: string,
	position: "first" | "last",
	ctx: ToolContext,
	signal?: AbortSignal
): Promise<Record<string, unknown>> {
	// Stated, not inferred: `parentId` absent would have to mean either "the
	// top level" or "leave it where it is", and a move that guessed wrong is a
	// folder somewhere nobody asked for.
	if (!("parentId" in args)) {
		throw new ToolArgError(
			'Moving a collection needs "parentId" - another collection\'s id, or null for the top level.'
		);
	}
	const parentId = args.parentId === null ? null : str(args, "parentId");
	if (parentId === undefined) {
		throw new ToolArgError('"parentId" must be a collection id or null.');
	}
	const rows = readCollectionRows(await ctx.client.listCollections(signal));
	const subtree = collectionSubtree(rows, id);
	if (subtree === null) throw new ToolArgError(`No collection with id "${id}".`, "not_found");
	// The UI's own refusal set, walked here so the answer names the problem.
	// The engine rejects the same batch under its lock - that check is the one
	// that is race-free and stays the authority; this one exists so an agent is
	// told "into its own subtree" rather than handed a 400 about a move entry.
	if (parentId !== null && subtree.includes(parentId)) {
		throw new ToolArgError(
			parentId === id
				? `A collection cannot be moved into itself ("${id}").`
				: `"${id}" cannot be moved into "${parentId}" - that collection is inside it.`
		);
	}
	if (parentId !== null && !rows.some((row) => row.id === parentId)) {
		throw new ToolArgError(`No collection with id "${parentId}".`, "not_found");
	}
	// The top level holds collections only, so there is no request list to read.
	const requests =
		parentId === null ? [] : readRequestRows(await ctx.client.listRequests(parentId, signal));
	return moveBatch({
		type: "collection",
		movedId: id,
		position,
		owner: { parentId },
		siblings: destinationSiblings({
			type: "collection",
			movedId: id,
			parentId,
			collections: rows,
			requests,
		}),
	});
}

/**
 * The batch that moves request `id` into the `collectionId` the call states.
 * Throws {@link ToolArgError} for a refusal; engine failures propagate.
 */
async function planRequestMove(
	args: Record<string, unknown>,
	id: string,
	position: "first" | "last",
	ctx: ToolContext,
	signal?: AbortSignal
): Promise<Record<string, unknown>> {
	const collectionId = str(args, "collectionId");
	if (collectionId === undefined) {
		throw new ToolArgError(
			'Moving a request needs "collectionId" - the collection it should end up in.'
		);
	}
	const [collections, requests] = await Promise.all([
		ctx.client.listCollections(signal),
		ctx.client.listRequests(collectionId, signal),
	]);
	return moveBatch({
		type: "request",
		movedId: id,
		position,
		owner: { collectionId },
		siblings: destinationSiblings({
			type: "request",
			movedId: id,
			parentId: collectionId,
			collections: readCollectionRows(collections),
			requests: readRequestRows(requests),
		}),
	});
}
