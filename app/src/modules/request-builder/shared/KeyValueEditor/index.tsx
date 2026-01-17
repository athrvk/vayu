
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * KeyValueEditor Component
 *
 * Reusable editor for key-value pairs with variable support.
 * Used for: Query Params, Headers, Form Data, URL Encoded
 *
 * Features:
 * - Add/remove rows
 * - Enable/disable individual rows
 * - Variable syntax highlighting and autocomplete
 * - Optional resolved value preview
 * - Optional description field
 */

import { useCallback } from "react";
import { cn } from "@/lib/utils";
import type { KeyValueItem, KeyValueEditorProps } from "../../types";
import { createEmptyKeyValue } from "../../utils/key-value";
import KeyValueRow from "./KeyValueRow";

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
	// Remove row
	const handleRemove = useCallback(
		(id: string) => {
			const itemToRemove = items.find((item) => item.id === id);

			// Check if parent allows removal
			if (itemToRemove && !canRemove(itemToRemove)) {
				return;
			}

			const newItems = items.filter((item) => item.id !== id);
			// Always ensure there's at least one empty row at the end
			if (newItems.length === 0) {
				newItems.push(createEmptyKeyValue());
			} else {
				const lastItem = newItems[newItems.length - 1];
				// If the last item has a value, add an empty row
				if (lastItem.key.trim() || lastItem.value.trim()) {
					newItems.push(createEmptyKeyValue());
				}
			}
			onChange(newItems);
		},
		[items, onChange, canRemove]
	);

	// Update row
	const handleUpdate = useCallback(
		(id: string, field: keyof KeyValueItem, value: string | boolean) => {
			const itemToUpdate = items.find((item) => item.id === id);
			if (!itemToUpdate) return;

			// Check if parent allows editing this field
			if (!canEdit(itemToUpdate, field)) {
				return;
			}

			// Check if parent allows disabling
			if (field === "enabled" && value === false && !canDisable(itemToUpdate)) {
				return;
			}

			const newItems = items.map((item) =>
				item.id === id ? { ...item, [field]: value } : item
			);

			// Check if we're updating the last row
			const lastItem = newItems[newItems.length - 1];
			const isLastRow = lastItem && lastItem.id === id;

			// If editing the last row and it now has a value, add a new empty row
			if (isLastRow) {
				const hasValue = lastItem.key.trim() || lastItem.value.trim();
				if (hasValue) {
					newItems.push(createEmptyKeyValue());
				}
			}

			onChange(newItems);
		},
		[items, onChange, canEdit, canDisable]
	);

	return (
		<div className="space-y-2">
			{/* Header */}
			{/* <div className="flex items-center justify-between">
				<div className="flex items-center gap-2">
					{enabledCount > 0 && (
						<Badge variant="secondary" className="text-xs">
							{enabledCount} active
						</Badge>
					)}
				</div>
			</div> */}

			{/* Column Headers */}
			<div
				className={cn(
					"grid gap-2 text-xs font-medium text-muted-foreground px-1",
					showResolved
						? "grid-cols-[24px_1fr_1fr_1fr_32px]"
						: "grid-cols-[24px_1fr_1fr_32px]"
				)}
			>
				<div></div>
				<div>{keyPlaceholder}</div>
				<div>{valuePlaceholder}</div>
				{showResolved && <div>Resolved</div>}
				<div></div>
			</div>

			{/* Rows */}
			<div className="space-y-1">
				{items.map((item) => (
					<KeyValueRow
						key={item.id}
						item={item}
						keyPlaceholder={keyPlaceholder}
						valuePlaceholder={valuePlaceholder}
						showResolved={showResolved}
						allowDisable={allowDisable}
						readOnly={readOnly || !canEdit(item, "key")}
						keySuggestions={keySuggestions}
						onUpdate={handleUpdate}
						onRemove={handleRemove}
						canRemove={canRemove(item)}
						canEdit={canEdit(item, "key") || canEdit(item, "value")}
						canDisable={canDisable(item)}
					/>
				))}
			</div>
		</div>
	);
}
