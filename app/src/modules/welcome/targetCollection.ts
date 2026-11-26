/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Where a new request from any "New request" entry point lands, weighted toward the last-worked-in
 * collection:
 *  - a valid remembered collection (`lastCollectionId`, still present) wins, with no friction;
 *  - no collections at all → create one;
 *  - exactly one collection → use it;
 *  - otherwise (no memory, several collections) → ask: the topmost by sidebar order is arbitrary
 *    relative to what the user is doing, so this never guesses among several.
 */

import type { Collection } from "@/types";

export type NewRequestTarget =
	{ kind: "collection"; collectionId: string } | { kind: "create" } | { kind: "pick" };

export function resolveNewRequestTarget(
	lastCollectionId: string | null,
	collections: Collection[]
): NewRequestTarget {
	if (lastCollectionId && collections.some((c) => c.id === lastCollectionId)) {
		return { kind: "collection", collectionId: lastCollectionId };
	}
	if (collections.length === 0) return { kind: "create" };
	if (collections.length === 1) return { kind: "collection", collectionId: collections[0].id };
	return { kind: "pick" };
}
