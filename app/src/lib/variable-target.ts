/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which definition a variable edit lands on: the one the resolver named.
 * `ResolvedVariable.sourceId` is the resolver's own statement of which environment or collection a
 * value came from, and an edit goes there and nowhere else: re-deriving a target (the request's own
 * collection, the active environment) disagrees with the resolver whenever the winner is an
 * ancestor's definition, and the edit then lands as a copy in a collection that never defined the
 * name (#3683).
 *
 * The context bar (`useVariableCommit`) and the token popover (`useVariableWriter`) both read their
 * target through this, so they cannot drift apart. What each does with the target differs (the bar
 * reads the query cache and awaits `mutateAsync`, the writer reads hook data and fires `mutate`),
 * so only the naming is shared.
 */

import type { VariableScope } from "@/types";

/** A scope's own address: globals are a singleton, the others are named by id. */
export type VariableTarget =
	{ scope: "global" } | { scope: "environment" | "collection"; id: string };

/**
 * The target a definition's `scope` and `sourceId` name, or null when a
 * non-global one carries no id. Every non-global winner has one, so null is a
 * resolver that changed shape, not a variable to guess a home for.
 */
export function variableTargetOf(definition: {
	scope: VariableScope;
	sourceId?: string;
}): VariableTarget | null {
	if (definition.scope === "global") return { scope: "global" };
	if (!definition.sourceId) return null;
	return { scope: definition.scope, id: definition.sourceId };
}
