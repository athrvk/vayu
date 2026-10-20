/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A parent's children as the one list the tree shows them in.
 *
 * A collection's sub-folders and its requests share one `order` space (#2535),
 * so a request can sit between two folders and every consumer that asks "what
 * comes next under this parent" - the render, a drop, Alt+Arrow, "Move to...",
 * the menu's Move up / Move down gating - has to read the same merged list. This
 * is that list, built once; a consumer that merged the two itself would be the
 * second copy of the sibling rule that #360 and #431 removed.
 */

import { compareTreeOrder, type Collection, type Request } from "@/types";

/** One child of a parent: a sub-folder or a request, tagged with its kind. */
export type TreeChild =
	| {
			kind: "collection";
			id: string;
			order: number;
			createdAt?: string;
			collection: Collection;
	  }
	| {
			kind: "request";
			id: string;
			order: number;
			createdAt?: string;
			request: Request;
	  };

/**
 * The children of `parentId` in sibling order (`compareTreeOrder`).
 *
 * `null` is the top level, which holds collections only: a request always
 * belongs to one. Unlike the tree's root list this does not adopt orphans (a
 * collection whose parent is not loaded); a reorder scope is a stored parent,
 * and an orphan's stored parent is its own id, not the root.
 */
export function childrenOf(
	parentId: string | null,
	collections: readonly Collection[],
	requestsOf: (collectionId: string) => readonly Request[]
): TreeChild[] {
	const folders = collections.filter((c) => (c.parentId ?? null) === parentId);
	return mergeSiblings(folders, parentId === null ? [] : requestsOf(parentId));
}

/**
 * One parent's sub-folders and requests as its sibling list, for a caller that
 * already holds both: the merge `childrenOf` does, without its scan of every
 * collection for the parent's folders. Neither input needs to be sorted.
 */
export function mergeSiblings(
	folders: readonly Collection[],
	requests: readonly Request[]
): TreeChild[] {
	const children: TreeChild[] = [
		...folders.map((collection): TreeChild => ({
			kind: "collection",
			id: collection.id,
			order: collection.order,
			createdAt: collection.createdAt,
			collection,
		})),
		...requests.map((request): TreeChild => ({
			kind: "request",
			id: request.id,
			order: request.order,
			createdAt: request.createdAt,
			request,
		})),
	];
	return children.sort(compareTreeOrder);
}
