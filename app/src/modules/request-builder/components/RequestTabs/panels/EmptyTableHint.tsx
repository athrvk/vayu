/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The line above a key/value table, shown only while it is empty: useful on an empty tab, furniture
 * after, like "Auto-saves when you click away" in the variable popover. "Empty" is nothing but the
 * trailing blank row the editor keeps, so this counts rows with content.
 */

import type { KeyValueItem } from "@/types";

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
