/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The one merge a variable-map write goes through.
 *
 * A PUT to `/environments/:id`, `/globals` or `/collections/:id` replaces the
 * whole `variables` map, so any writer holding less than the freshest map
 * risks sending a stale copy of a key it never touched back over a
 * concurrent write to that key - an MCP agent's `update_environment`,
 * another tab's context-bar commit, or the variables editor's own earlier
 * save. The fix is the same everywhere: read the freshest map at write time,
 * apply only the keys this write actually changed, and send that. This
 * module is that merge, in one place, so `useVariableCommit` (a single-key
 * commit from the context bar) and `VariableTableEditor` (a multi-row commit
 * from the Variables tab) apply it the same way instead of each re-deriving
 * it - the repo's "hand-rolled copy of a primitive" trap, one level up from
 * the UI primitives it usually names.
 */

import type { VariableValue } from "@/types";

export type VariableMap = Record<string, VariableValue>;

/** `null` marks a deletion; anything else replaces the key. */
export type VariableChanges = Record<string, VariableValue | null>;

export function variableValuesEqual(
	a: VariableValue | null | undefined,
	b: VariableValue | null | undefined
): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return (
		a.value === b.value &&
		a.enabled === b.enabled &&
		(a.secret ?? false) === (b.secret ?? false) &&
		(a.type ?? "string") === (b.type ?? "string") &&
		a.createdAt === b.createdAt
	);
}

/**
 * Apply `changes` onto `fresh`. A key `changes` does not name keeps whatever
 * `fresh` holds for it - which is what lets a write nobody read survive a
 * write that never touched it.
 */
export function mergeVariableChanges(fresh: VariableMap, changes: VariableChanges): VariableMap {
	const next = { ...fresh };
	for (const [key, value] of Object.entries(changes)) {
		if (value === null) delete next[key];
		else next[key] = value;
	}
	return next;
}

export interface VariableConflict {
	key: string;
	/** What this write wants the key to become, or null to delete it. */
	mine: VariableValue | null;
	/** What the freshest map already holds for the key, or null if removed there. */
	theirs: VariableValue | null;
}

/**
 * A key is a conflict when both sides moved it away from `baseline` - the
 * value each side started from - and did not land in the same place. A key
 * only one side touched is not a conflict: it is exactly the case
 * `mergeVariableChanges` already resolves by taking whichever side has an
 * opinion.
 */
export function findVariableConflicts(
	baseline: VariableMap,
	changes: VariableChanges,
	fresh: VariableMap
): VariableConflict[] {
	const conflicts: VariableConflict[] = [];
	for (const [key, mine] of Object.entries(changes)) {
		const before = baseline[key] ?? null;
		const theirs = fresh[key] ?? null;
		if (variableValuesEqual(theirs, before)) continue; // nobody else touched it
		if (variableValuesEqual(mine, theirs)) continue; // both sides landed on the same value
		conflicts.push({ key, mine, theirs });
	}
	return conflicts;
}
