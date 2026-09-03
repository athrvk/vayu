/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * KeyValueEditor Component
 *
 * The table behind the request builder's Query Params, Headers, form-data and
 * urlencoded tabs, and the webhook inbox's canned reply headers. It is the
 * densest data surface in the app, which is what most of the decisions below
 * are about.
 *
 * **It lives here rather than under `modules/request-builder/`** because two
 * feature modules mount it and `components/shared/` is what features share
 * (#567). The bulk table/text toggle that sits above it in the builder's two
 * panels did *not* come along: `BulkEditor` has one feature's panels as its
 * only callers, so it stayed in `modules/request-builder/shared/`.
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
 *
 * **Its variable scope arrives as a prop** (`variables`), not from
 * `useRequestBuilderContext()`. That hook throws with no provider above it, so
 * reading it in the row's body made the app's key/value primitive structurally
 * unmountable anywhere else, and the inbox and the variables module each grew
 * their own copy (#564). Omit the prop and the table resolves nothing and
 * offers no autocomplete, which is what a surface with no variables should
 * show.
 */

import { useCallback } from "react";
import type { KeyValueItem, KeyValueEditorProps } from "@/types";
import { withTrailingBlank } from "./key-value";
import KeyValueRow from "./KeyValueRow";
import type { PickedFile } from "./FilePartCell";

export default function KeyValueEditor({
	items,
	onChange,
	keyPlaceholder = "Key",
	valuePlaceholder = "Value",
	showResolved = true,
	allowDisable = true,
	readOnly = false,
	keySuggestions,
	allowFiles = false,
	variables,
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

	/**
	 * A pick writes the whole file part at once.
	 *
	 * Four `handleUpdate` calls would each rebuild the list from a stale
	 * `items`, so only the last would survive - and it also has to *clear*
	 * `unresolved`, since choosing the file here is the one event that proves
	 * the path exists on this machine. Outside Electron there is no path to
	 * take (`src: ""`), and that row stays unresolved: the filename alone is
	 * not something the engine can open, and it says so rather than pretending.
	 */
	const handlePickFile = useCallback(
		(id: string, file: PickedFile) => {
			const target = items.find((item) => item.id === id);
			if (!target || !canEdit(target, "value")) return;
			onChange(
				withTrailingBlank(
					items.map((item) =>
						item.id === id
							? {
									...item,
									type: "file" as const,
									value: "",
									src: file.src,
									fileName: file.fileName,
									contentType: file.contentType || undefined,
									unresolved: file.src ? undefined : true,
								}
							: item
					)
				)
			);
		},
		[items, onChange, canEdit]
	);

	/**
	 * Switching a row between text and file.
	 *
	 * Going back to text drops the file members rather than parking them: a
	 * text row that still carried a `src` is a body the engine refuses (it
	 * would mean a file the user pointed at and nothing sends), and keeping
	 * them invisible is how that shape would arrive.
	 */
	const handleToggleKind = useCallback(
		(id: string, kind: "text" | "file") => {
			const target = items.find((item) => item.id === id);
			if (!target || !canEdit(target, "value")) return;
			onChange(
				withTrailingBlank(
					items.map((item) => {
						if (item.id !== id) return item;
						if (kind === "file") return { ...item, type: "file" as const, value: "" };
						return {
							...item,
							type: "text" as const,
							src: undefined,
							fileName: undefined,
							contentType: undefined,
							unresolved: undefined,
						};
					})
				)
			);
		},
		[items, onChange, canEdit]
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
			<div
				className={`grid gap-2 ${
					allowFiles
						? "grid-cols-[24px_1fr_1fr_20px_20px_28px]"
						: "grid-cols-[24px_1fr_1fr_20px_28px]"
				} px-1 text-[11px] font-semibold uppercase tracking-wide text-subtle-foreground`}
			>
				<div />
				<div>Key</div>
				<div>Value</div>
				<div />
				<div />
				{allowFiles && <div />}
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
						allowFiles={allowFiles}
						variables={variables}
						onUpdate={handleUpdate}
						onPickFile={handlePickFile}
						onToggleKind={handleToggleKind}
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
