/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The one order a scope's variables are listed in.
 *
 * The engine stores a variables object in key order, which is not the order the
 * user wrote the rows in, so every surface that lists a scope's definitions
 * sorts by `createdAt` through this function: the Variables tab and the
 * collection tab's context bar show the same rows in the same order, and
 * `VariableTableEditor` writes its save payload in this order so the round trip
 * keeps it (#3252).
 */

import type { VariableValue } from "@/types";

/**
 * Oldest `createdAt` first, newest at the bottom; ties break by name. A missing
 * `createdAt` sorts as 0 - "older than everything" - so rows with no known
 * creation time stay together at the top instead of drifting one at a time as
 * they happen to be saved (#135).
 */
export function sortVariableEntriesByCreatedAt(
	entries: readonly (readonly [string, VariableValue])[]
): [string, VariableValue][] {
	return entries
		.map(([name, variable]): [string, VariableValue] => [name, variable])
		.sort(([nameA, a], [nameB, b]) => {
			const createdA = a.createdAt ?? 0;
			const createdB = b.createdAt ?? 0;
			if (createdA !== createdB) return createdA - createdB;
			return nameA.localeCompare(nameB, undefined, { sensitivity: "base" });
		});
}
