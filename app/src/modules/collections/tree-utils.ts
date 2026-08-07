/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Tree walks over `parentId`, in one place.
 *
 * Every walk here carries a visited-set termination guard, and that is the
 * reason the module exists. The engine rejects cycles on write but explicitly
 * tolerates them in data that is already stored (`collections.cpp`), so a
 * `parentId` cycle is reachable - and an unguarded walk in the renderer is not a
 * wrong answer, it is a synchronous hang of the window. The resolver's own walk
 * had grown the guard with a comment saying exactly that; the three copies in
 * the tree and the query layer never received it, which is this repo's
 * hand-rolled-copy-of-a-primitive failure in its usual shape.
 *
 * Deliberately typed on `TreeNode` rather than `Collection`: the walks need an
 * id and a parent and nothing else, which keeps them testable without building
 * whole collections and lets a caller pass any narrowed row it already holds.
 */

/** The minimum a walk needs from a row. `Collection` satisfies it structurally. */
export interface TreeNode {
	id: string;
	parentId?: string | null;
}

/**
 * The ancestor chain of `startId`, root first and inclusive of the start node.
 *
 * Stops at the first id that resolves to no loaded node, so a walk from an
 * orphan yields just the orphan rather than pretending it has a parent, and
 * stops at the first id it has already visited, so a cycle terminates instead
 * of looping. Returns `[]` when `startId` itself is not loaded.
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
 * Whether `candidateId` sits anywhere below `ancestorId`.
 *
 * Strict: a node is not its own descendant. Drop-target validation wants both
 * answers ("into itself" and "into its own subtree") but they are different
 * refusals, so the identity case stays the caller's to name.
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
 * Every entity id a cascade delete of `rootId` reaches: the collection itself,
 * its descendant folders, and the requests all of them hold.
 *
 * The engine performs the cascade; this is only the client's list of what has
 * gone stale (open tabs pointing at those rows), so it takes the request ids
 * from the caller's cache rather than re-deriving anything server-side.
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
