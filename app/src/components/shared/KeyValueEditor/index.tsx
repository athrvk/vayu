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

import { useCallback, useEffect, useRef } from "react";
import type { KeyValueItem, KeyValueEditorProps } from "@/types";
import { withTrailingBlank } from "./key-value";
import KeyValueRow from "./KeyValueRow";
import type { PickedFile } from "./FilePartCell";
import { EYEBROW_CLASS } from "@/components/ui/eyebrow";
import { cn } from "@/lib/utils";

// Module constants, not inline arrows in the parameter list: an inline default
// is a fresh function every render, which would defeat the ref-backed
// callbacks below just as surely as `items` in their deps did (issue #1716) -
// every caller that leaves these unset would hand KeyValueEditor a new
// identity each render regardless of what its own callbacks do.
const ALLOW_ALL_ITEMS = () => true;
const ALLOW_ALL = () => true;

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
	canEdit = ALLOW_ALL_ITEMS, // Default: allow editing all items
	canRemove = ALLOW_ALL, // Default: allow removing all items
	canDisable = ALLOW_ALL, // Default: allow disabling all items
}: KeyValueEditorProps) {
	/*
	 * `items` is a fresh array on every keystroke (`onChange` writes it back
	 * through the parent's state), so listing it in these callbacks' deps gave
	 * every one of them a new identity on every keystroke too - which is
	 * exactly what defeated `KeyValueRow`'s `memo` (issue #1716). Reading the
	 * latest items through a ref keeps the callbacks' identities stable across
	 * keystrokes: only `onChange`, `canEdit`, `canRemove` and `canDisable` -
	 * expected stable from the caller - remain in their deps.
	 */
	const itemsRef = useRef(items);
	useEffect(() => {
		itemsRef.current = items;
	}, [items]);

	const handleRemove = useCallback(
		(id: string) => {
			const currentItems = itemsRef.current;
			const itemToRemove = currentItems.find((item) => item.id === id);
			if (itemToRemove && !canRemove(itemToRemove)) return;
			onChange(withTrailingBlank(currentItems.filter((item) => item.id !== id)));
		},
		[onChange, canRemove]
	);

	const handleUpdate = useCallback(
		(id: string, field: keyof KeyValueItem, value: string | boolean) => {
			const currentItems = itemsRef.current;
			const itemToUpdate = currentItems.find((item) => item.id === id);
			if (!itemToUpdate) return;
			if (!canEdit(itemToUpdate, field)) return;
			if (field === "enabled" && value === false && !canDisable(itemToUpdate)) return;

			/*
			 * Retyping a row a setting auto-wrote (`source`, issue #1481) hands it
			 * to the user - disabling it does not, so only key/value edits clear the
			 * marker. Harmless on a row with no `source` to begin with, which is
			 * every row outside the request builder's Headers tab.
			 */
			const newItems = currentItems.map((item) => {
				if (item.id !== id) return item;
				const updated = { ...item, [field]: value };
				if (field === "key" || field === "value") delete updated.source;
				return updated;
			});
			onChange(withTrailingBlank(newItems));
		},
		[onChange, canEdit, canDisable]
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
			const currentItems = itemsRef.current;
			const target = currentItems.find((item) => item.id === id);
			if (!target || !canEdit(target, "value")) return;
			onChange(
				withTrailingBlank(
					currentItems.map((item) =>
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
		[onChange, canEdit]
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
			const currentItems = itemsRef.current;
			const target = currentItems.find((item) => item.id === id);
			if (!target || !canEdit(target, "value")) return;
			onChange(
				withTrailingBlank(
					currentItems.map((item) => {
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
		[onChange, canEdit]
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
				className={cn(
					EYEBROW_CLASS,
					`grid gap-2 ${
						allowFiles
							? "grid-cols-[24px_1fr_1fr_20px_20px_28px]"
							: "grid-cols-[24px_1fr_1fr_20px_28px]"
					} px-1 text-subtle-foreground`
				)}
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
