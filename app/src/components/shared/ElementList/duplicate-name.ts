/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The name a duplicated element gets (#3056): "X copy", then "X copy 2",
 * "X copy 3" and so on, the first that no sibling already carries. A source
 * that is itself a copy is stripped back to its base first, so duplicating
 * "X copy" gives "X copy 2" rather than "X copy copy".
 */

/** A trailing " copy" or " copy N" - the shape this module writes. */
const COPY_SUFFIX = / copy(?: \d+)?$/;

/**
 * @param sourceName - the name the duplicated element shows (its own, or its
 *   kind's label when it has none).
 * @param takenNames - the names every element in the list shows, the source's
 *   included.
 */
export function nextCopyName(sourceName: string, takenNames: readonly string[]): string {
	const stripped = sourceName.replace(COPY_SUFFIX, "");
	// A name that is nothing but the suffix has no base to restore.
	const base = stripped === "" ? sourceName : stripped;
	const taken = new Set(takenNames);
	let candidate = `${base} copy`;
	for (let n = 2; taken.has(candidate); n++) {
		candidate = `${base} copy ${n}`;
	}
	return candidate;
}
