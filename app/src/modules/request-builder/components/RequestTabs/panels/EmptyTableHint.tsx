/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The one-line explanation above a key/value table, shown only while it is
 * empty.
 *
 * Both Params and Headers opened with a permanent sentence - "Add headers to
 * include with your request. Use `{{variable}}` for dynamic values." - in a
 * dense developer tool, repeated on the sibling tab, saying what the field
 * placeholder and the coloured token already say once you have a row. It is
 * genuinely useful on an empty tab and furniture every time after, which is the
 * same shape as "Auto-saves when you click away" in the variable popover.
 *
 * A table is "empty" when it has nothing but the trailing blank row the editor
 * always keeps - so this counts rows with content rather than rows.
 */

import type { KeyValueItem } from "../../../types";

export interface EmptyTableHintProps {
	items: KeyValueItem[];
	/** "headers" / "query parameters" - used in the variable sentence. */
	noun: string;
	children: React.ReactNode;
}

export function EmptyTableHint({ items, noun, children }: EmptyTableHintProps) {
	const hasContent = items.some((i) => i.key.trim() || i.value.trim());
	if (hasContent) return null;

	return (
		<p className="text-xs text-muted-foreground">
			{children} Use{" "}
			<code className="bg-muted px-1 rounded-md font-mono">{"{{variable}}"}</code> in a{" "}
			{noun.replace(/s$/, "")} for a value resolved at send time.
		</p>
	);
}

export default EmptyTableHint;
