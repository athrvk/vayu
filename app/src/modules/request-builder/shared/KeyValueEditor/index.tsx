/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * KeyValueEditor Component
 *
 * The table behind four surfaces: Query Params, Headers, form-data and
 * urlencoded. It is the densest data surface in the app, which is what most of
 * the decisions below are about.
 *
 * **Rows were 48px.** `VariableInput` is `h-9` (36px), the row added `p-1` and
 * the stack added `space-y-1` - so eight headers cost 384px, in a panel whose
 * tab band is 24px and whose URL bar is 40px. They are `h-8` now, the height 43
 * other places in the app already use, at a 36px pitch. Same eight headers,
 * 288px.
 *
 * **The Resolved column is gone.** It held an equal third of the table -
 * `grid-cols-[24px_1fr_1fr_1fr_32px]` - and on a row with no variable in it,
 * which is most rows, it printed the two cells to its left joined by `=`. Key
 * and Value now have the whole width, and a row that *does* contain a variable
 * carries a marker that reveals the resolved line on hover or focus. See
 * `ResolvedPeek`.
 *
 * **The trailing blank row** comes from one `withTrailingBlank` rather than two
 * copies that had drifted.
 */

import { useCallback } from "react";
import type { KeyValueItem, KeyValueEditorProps } from "../../types";
import { withTrailingBlank } from "../../utils/key-value";
import KeyValueRow from "./KeyValueRow";

// Re-exported here so a panel takes the table and its text form from one place.
export { BulkEditor } from "./BulkEditor";
export type { BulkEditorProps } from "./BulkEditor";

export default function KeyValueEditor({
	items,
	onChange,
	keyPlaceholder = "Key",
	valuePlaceholder = "Value",
	showResolved = true,
	allowDisable = true,
	readOnly = false,
	keySuggestions,
	canEdit = () => true, // Default: allow editing all items
	canRemove = () => true, // Default: allow removing all items
	canDisable = () => true, // Default: allow disabling all items
}: KeyValueEditorProps) {
	const handleRemove = useCallback(
		(id: string) => {
			const itemToRemove = items.find((item) => item.id === id);
			if (itemToRemove && !canRemove(itemToRemove)) return;
			onChange(withTrailingBlank(items.filter((item) => item.id !== id)));
		},
		[items, onChange, canRemove]
	);

	const handleUpdate = useCallback(
		(id: string, field: keyof KeyValueItem, value: string | boolean) => {
			const itemToUpdate = items.find((item) => item.id === id);
			if (!itemToUpdate) return;
			if (!canEdit(itemToUpdate, field)) return;
			if (field === "enabled" && value === false && !canDisable(itemToUpdate)) return;

			const newItems = items.map((item) =>
				item.id === id ? { ...item, [field]: value } : item
			);
			onChange(withTrailingBlank(newItems));
		},
		[items, onChange, canEdit, canDisable]
	);

	return (
		<div className="space-y-1.5">
			{/*
			 * The column headers no longer repeat the placeholders. They used to
			 * render `keyPlaceholder` verbatim, so an empty Headers table said
			 * "Header" as a column title and "Header" again inside every field
			 * below it. The placeholder is the one that has to name the thing,
			 * because it is the one still visible once you start typing.
			 */}
			<div className="grid gap-2 grid-cols-[24px_1fr_1fr_20px_28px] px-1 text-[11px] font-medium uppercase tracking-wide text-subtle-foreground">
				<div />
				<div>Key</div>
				<div>Value</div>
				<div />
				<div />
			</div>

			<div className="space-y-0.5">
				{items.map((item) => (
					<KeyValueRow
						key={item.id}
						item={item}
						keyPlaceholder={keyPlaceholder}
						valuePlaceholder={valuePlaceholder}
						showResolved={showResolved}
						allowDisable={allowDisable}
						readOnly={readOnly}
						keySuggestions={keySuggestions}
						onUpdate={handleUpdate}
						onRemove={handleRemove}
						canRemove={canRemove(item)}
						/*
						 * Per field, not one boolean for both. `canEdit(item, field)`
						 * has always taken a field, and `handleUpdate` above honours
						 * it - but the row derived its disabled state from the *key*
						 * alone and applied it to both inputs. Nothing exercised the
						 * difference today (every rule that says no says no to both),
						 * so this was a promise the UI could not keep rather than a
						 * live bug: a value-editable, key-locked row would have given
						 * you a field you could type into that discarded the write.
						 */
						canEditKey={canEdit(item, "key")}
						canEditValue={canEdit(item, "value")}
						canDisable={canDisable(item)}
					/>
				))}
			</div>
		</div>
	);
}
