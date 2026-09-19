/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The sentence `DeleteConfirmDialog` builds from `name` and `scope` (issue
 * #1689). A separate module from the dialog component itself so the file that
 * only exports a component keeps doing only that - `react-refresh/only-export-
 * components` is what it is for.
 */

/**
 * The suffix a deletion needs beyond "removed permanently" (issue #1689).
 *
 * `"default"` covers a single leaf: an environment, a run, an inbox. `"cascade"`
 * is for a container that takes its contents with it - a trashed collection, a
 * folder - and says so, because "removed permanently" alone reads as the one
 * row, not everything under it.
 */
export type DeleteScope = "default" | "cascade";

/**
 * The sentence `DeleteConfirmDialog` builds from `name` and `scope`. Exported
 * so a caller that needs the words outside the dialog itself - a toast
 * confirming what just happened, say - quotes the same noun the dialog did,
 * rather than inventing a second phrasing that can drift from it.
 *
 * Deliberately reworded away from the three phrasings this replaced, one per
 * call site that had written its own (see `collection-constants.test.ts` and
 * the acceptance criteria on issue #1689 for the exact strings). One sentence
 * shape, chosen once, is the fix.
 */
export function deleteConfirmCopy(
	name: string,
	scope: DeleteScope = "default"
): { title: string; description: string } {
	const subject = `"${name}"`;
	const suffix = scope === "cascade" ? " and everything inside it" : "";
	return {
		title: `Delete ${subject}?`,
		description: `${subject}${suffix} is removed permanently. This cannot be undone.`,
	};
}
