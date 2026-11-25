/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Tree walks over `parentId`, in one place, each with a visited-set termination guard, which is why
 * the module exists. The engine rejects cycles on write but tolerates them in stored data
 * (`collections.cpp`), so a `parentId` cycle is reachable, and an unguarded walk in the renderer is
 * not a wrong answer but a synchronous hang of the window. A hand-rolled copy of these walks is the
 * copy that lacks the guard.
 *
 * Typed on `TreeNode`, not `Collection`: the walks need an id and a parent and nothing else, which
 * keeps them testable without whole collections and lets a caller pass any narrowed row it already
 * holds.
 */

/** The minimum a walk needs from a row. `Collection` satisfies it structurally. */
export interface TreeNode {
	id: string;
	parentId?: string | null;
}

/**
 * The ancestor chain of `startId`, root first, the start node included. Stops at the first id that
 * resolves to no loaded node (a walk from an orphan yields just the orphan) and at the first id
 * already visited (a cycle terminates). `[]` when `startId` itself is not loaded.
 */
export function walkAncestors<T extends TreeNode>(startId: string, nodes: readonly T[]): T[] {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const chain: T[] = [];
	const seen = new Set<string>();
	let currentId: string | null | undefined = startId;
	while (currentId) {
		if (seen.has(currentId)) break;
		seen.add(currentId);
		const node = byId.get(currentId);
		if (!node) break;
		chain.unshift(node); // root first
		currentId = node.parentId;
	}
	return chain;
}

/**
 * The names from the root down to `collectionId`, its own included: a breadcrumb's parts, for a
 * caller that joins them itself or passes them on as a list (the Copy path menu item, the agent
 * reference lines). `[]` when the id is not loaded. Built on `walkAncestors`, with its cycle guard.
 */
export function collectionNamePath(
	collectionId: string,
	collections: readonly (TreeNode & { name: string })[]
): string[] {
	return walkAncestors(collectionId, collections).map((collection) => collection.name);
}

/**
 * "Payments / Auth" for a nested collection: the names from the root down, its own included; a root
 * yields just its name, an unloaded id "". Takes an id-keyed map, not the node list, so a caller
 * labelling many rows builds the map once (`walkAncestors` builds one per call). Same termination
 * guard as the other walks.
 */
export function collectionPath(
	id: string,
	byId: ReadonlyMap<string, TreeNode & { name: string }>
): string {
	const names: string[] = [];
	const seen = new Set<string>();
	let current = byId.get(id);
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		names.unshift(current.name);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return names.join(" / ");
}

/**
 * Whether `candidateId` sits anywhere below `ancestorId`. Strict: a node is not its own descendant.
 * Drop-target validation wants both answers, but "into itself" and "into its own subtree" are
 * different refusals, so the identity case stays the caller's to name.
 */
export function isDescendant(
	candidateId: string,
	ancestorId: string,
	nodes: readonly TreeNode[]
): boolean {
	if (candidateId === ancestorId) return false;
	return walkAncestors(candidateId, nodes).some((node) => node.id === ancestorId);
}

/**
 * Every id in `rootId`'s subtree, the root first and included. `descend` is asked about each
 * *child* before it is taken: false drops that child and everything under it, which is how a
 * subtree that answers for itself looks from above (a sub-collection declaring its own data
 * contract, see `lib/data-contract.ts`). The root is never asked. Guarded like every walk in this
 * module.
 */
export function collectSubtreeIds<T extends TreeNode>(
	rootId: string,
	nodes: readonly T[],
	descend: (node: T) => boolean = () => true
): string[] {
	const childrenOf = new Map<string, T[]>();
	for (const node of nodes) {
		if (!node.parentId) continue;
		const siblings = childrenOf.get(node.parentId);
		if (siblings) siblings.push(node);
		else childrenOf.set(node.parentId, [node]);
	}

	const ids: string[] = [rootId];
	const visited = new Set<string>([rootId]);
	const queue = [rootId];
	while (queue.length > 0) {
		const current = queue.shift()!;
		for (const child of childrenOf.get(current) ?? []) {
			if (visited.has(child.id)) continue;
			visited.add(child.id);
			if (!descend(child)) continue;
			ids.push(child.id);
			queue.push(child.id);
		}
	}
	return ids;
}

/**
 * How many requests sit anywhere in `rootId`'s subtree, the root's own included.
 * Requests only: a folder is never counted. Built on `collectSubtreeIds`, so a
 * `parentId` cycle ends the walk rather than hanging it.
 */
export function countSubtreeRequests(
	rootId: string,
	nodes: readonly TreeNode[],
	requestCountIn: (collectionId: string) => number
): number {
	return collectSubtreeIds(rootId, nodes).reduce((sum, id) => sum + requestCountIn(id), 0);
}

/**
 * Every entity id a cascade delete of `rootId` reaches: the collection itself, its descendant
 * folders, and the requests all of them hold. The engine performs the cascade; this is the client's
 * list of what has gone stale (open tabs on those rows), so it takes the request ids from the
 * caller's cache rather than re-deriving anything server-side.
 */
export function collectDescendantEntityIds(
	rootId: string,
	nodes: readonly TreeNode[],
	requestIdsIn: (collectionId: string) => readonly string[]
): Set<string> {
	const childrenOf = new Map<string, string[]>();
	for (const node of nodes) {
		if (!node.parentId) continue;
		const siblings = childrenOf.get(node.parentId);
		if (siblings) siblings.push(node.id);
		else childrenOf.set(node.parentId, [node.id]);
	}

	const affected = new Set<string>([rootId]);
	// Separate from `affected`, which also holds request ids: only collections
	// are walked, and only once each even if the tree loops back on itself.
	const visited = new Set<string>([rootId]);
	const stack = [rootId];
	while (stack.length > 0) {
		const current = stack.pop()!;
		for (const requestId of requestIdsIn(current)) affected.add(requestId);
		for (const childId of childrenOf.get(current) ?? []) {
			if (visited.has(childId)) continue;
			visited.add(childId);
			affected.add(childId);
			stack.push(childId);
		}
	}
	return affected;
}
