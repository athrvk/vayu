/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file cascade.ts
 * @brief What `delete_collection` takes with it, counted before anyone is asked.
 */

import type { EngineClient } from "../engine-client.js";
import { collectionParentId } from "../variable-origins.js";
import { ID_KINDS, unknownIdText } from "./failure.js";
import { ToolArgError } from "./kit.js";

/**
 * A `GET /collections` row, narrowed to the fields the cascade walk reads - plus
 * the sibling-order keys a move and the scenario pre-flight read, since all
 * three work from the same one list read.
 */
export interface CollectionRow {
	id: string;
	name?: string;
	parentId?: string | null;
	order?: number;
	createdAt?: number;
}

/**
 * The collection a row sits under, or `null` for a root one.
 *
 * Two spellings reach here for "no parent": the engine serializes a root
 * collection's `parentId` as `null`, while a row that has been through a client
 * whose type calls it optional can arrive without the key at all. An empty
 * string is the third - what the cascade walk has always treated as a root.
 * Comparing raw values would file a root collection under a parent named "",
 * which is a destination that does not exist.
 */
export function collectionParent(row: CollectionRow): string | null {
	// One definition of the rule, shared with the chain walk `resolve_variables`
	// does - the two disagreeing about what counts as a root is a defect neither
	// side's own tests would catch.
	return collectionParentId(row);
}

/** The collections list, dropping anything without a usable id. */
export function readCollectionRows(value: unknown): CollectionRow[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(row): row is CollectionRow =>
			!!row && typeof row === "object" && typeof (row as CollectionRow).id === "string"
	);
}

/**
 * Every collection a cascade delete of `rootId` destroys, root first - itself
 * plus every descendant, since collections nest through `parentId` and
 * `DELETE /collections/:id` takes the whole subtree with it.
 *
 * Null when `rootId` is not in the list: the caller must say "no such
 * collection" rather than ask the user to confirm destroying nothing. The
 * `seen` set is what stops a malformed parent cycle from looping forever - the
 * engine rejects cycles on write, but this walk reads whatever is stored.
 */
export function collectionSubtree(rows: CollectionRow[], rootId: string): string[] | null {
	if (!rows.some((row) => row.id === rootId)) return null;
	const childrenOf = new Map<string, string[]>();
	for (const row of rows) {
		const parent = typeof row.parentId === "string" ? row.parentId : "";
		if (!parent) continue;
		childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), row.id]);
	}
	const seen = new Set<string>([rootId]);
	const ordered: string[] = [rootId];
	for (let i = 0; i < ordered.length; i++) {
		for (const child of childrenOf.get(ordered[i]) ?? []) {
			if (seen.has(child)) continue;
			seen.add(child);
			ordered.push(child);
		}
	}
	return ordered;
}

/** What a cascade delete is about to destroy, read before the user is asked. */
export interface CascadeScope {
	name: string;
	/** Descendants only - the collection itself is not counted among them. */
	descendants: number;
	requests: number;
}

/**
 * Read the subtree `collectionId` roots and count what goes with it.
 *
 * Every count here is read from the engine rather than assumed, because it is
 * the number the user agrees to: a prompt that guessed would be asking consent
 * for something other than what happens. A failed read therefore throws instead
 * of degrading to "0 requests" - `ToolArgError` for a collection that does not
 * exist, the transport error otherwise, and either way nothing is deleted.
 */
export async function readCascadeScope(
	client: EngineClient,
	collectionId: string,
	signal?: AbortSignal
): Promise<CascadeScope> {
	const rows = readCollectionRows(await client.listCollections(signal));
	const subtree = collectionSubtree(rows, collectionId);
	if (subtree === null) {
		throw new ToolArgError(unknownIdText(ID_KINDS.collection, collectionId), "not_found");
	}
	const lists = await Promise.all(subtree.map((id) => client.listRequests(id, signal)));
	const requests = lists.reduce<number>(
		(total, list) => total + (Array.isArray(list) ? list.length : 0),
		0
	);
	const root = rows.find((row) => row.id === collectionId);
	return {
		name: typeof root?.name === "string" && root.name !== "" ? root.name : collectionId,
		descendants: subtree.length - 1,
		requests,
	};
}

/** One sentence naming everything a cascade delete destroys. */
export function describeCascade(scope: CascadeScope): string {
	return (
		`Deleting "${scope.name}" also removes ${scope.descendants} sub-collection(s) and ` +
		`${scope.requests} saved request(s) inside it. All of it goes to Vayu's Trash, ` +
		`where it can be restored.`
	);
}
