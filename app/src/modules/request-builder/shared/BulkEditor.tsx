/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The table/text toggle above a `KeyValueEditor`, and the textarea it swaps in, shared by
 * `ParamsPanel` and `HeadersPanel`. Only the *format* differs (headers `Name: value`, params
 * `key=value`), so the caller passes a parse, a format and the syntax sentence.
 *
 * - **It stays in this module** although `KeyValueEditor` is in `components/shared/` (#567):
 *   nothing here is key/value-shaped, but only this module's two panels use it, and
 *   `components/shared/` is for what several features share. Imported directly, since a shared
 *   primitive cannot re-export from a feature module.
 * - **The draft is a staging area**: paste a block, fix it, and it commits on switching back to the
 *   table; parsing per keystroke would rewrite the request under a half-finished paste. Controlled:
 *   the builder holds it per request in its provider (`utils/bulk-drafts.ts`, #3666), so it
 *   survives a sub-tab switch and stays with its request. Send and Save commit an open draft too;
 *   this knows only the toggle.
 * - **`after` renders in both modes**: what describes *this send* ("Added by Vayu", the resolved
 *   URL) must stay while bulk-editing, when a pasted block most wants checking against its URL.
 *   Only the table and its `tableHeader` are table-only.
 * - **A diverged draft gets `Discard`** beside the toggle, so looking something up in text mode
 *   does not force a commit.
 * - **The toggle is a `ToggleGroup`, not a label-swapping `Button`**: a pill `Button` at
 *   `size="sm"` (`h-control-sm`, a border, `px-3`) outweighs the borderless 36px rows below it, and
 *   `ToggleGroup`'s `xs` step is the app's one-of-a-few primitive, as in `ResponseBody`'s
 *   Pretty/Raw/Preview.
 * - **`tableHeader` renders below the table, not in the toggle row or above it.** It is a
 *   conditional, sometimes two-line `<p>` (`EmptyTableHint`) that goes on the first row or on
 *   opening bulk edit: in the toggle row it snapped the row's height, and above the table it moved
 *   the row being typed into on the first keystroke. Below the trailing blank row, its mount moves
 *   only content under the cursor's row. Not always shown (it restates the placeholder and token
 *   colouring once a row exists, permanent furniture `EmptyTableHint` removes), not reserved
 *   invisibly (clutter without content), not behind a tooltip (it teaches `{{variable}}` syntax at
 *   the one moment discovery matters).
 */

import { Edit3, Table2 } from "lucide-react";
import { Button, Label, Textarea, ToggleGroup, ToggleGroupItem } from "@/components/ui";
import type { BulkDraft } from "../utils/bulk-drafts";

export interface BulkEditorProps {
	/** The rows as text, for when the user switches *into* text mode. */
	format: () => string;
	/** The open draft, or null on the table. */
	draft: BulkDraft | null;
	/** Opens (a fresh draft), edits, or discards (null) the draft. */
	onDraftChange: (draft: BulkDraft | null) => void;
	/**
	 * Back to the table: the caller parses `draft.text` and closes the draft, as only it knows the
	 * syntax and what the rows touch besides themselves (params rewrite the URL).
	 */
	onCommit: () => void;
	/** "Headers" / "Query parameters": names the textarea. */
	label: string;
	placeholder: string;
	/** The syntax note under the field. Headers and params differ here. */
	hint: React.ReactNode;
	/** The table, rendered when not in text mode. */
	children: React.ReactNode;
	/**
	 * The empty-state hint, directly below the table, table-only like `children`; the module doc
	 * says why nowhere higher.
	 */
	tableHeader?: React.ReactNode;
	/**
	 * Below the table or textarea in both modes: what describes the send (declared headers, the
	 * resolved URL); see the module doc.
	 */
	after?: React.ReactNode;
}

export function BulkEditor({
	format,
	draft,
	onDraftChange,
	onCommit,
	label,
	placeholder,
	hint,
	children,
	tableHeader,
	after,
}: BulkEditorProps) {
	const isText = draft !== null;
	// Against the text the draft opened with, not `format()`, which recomputes from the table's
	// current, unrelated state each render.
	const isDirty = isText && draft.text !== draft.opened;

	const enterText = () => {
		const text = format();
		onDraftChange({ text, opened: text });
	};

	// Radix's single-select group reports "" on a deselecting click; ignored, as in ResponseBody's
	// view switch, since this toggle has no "neither".
	const onModeChange = (next: string) => {
		if (next === "text" && !isText) enterText();
		if (next === "table" && isText) onCommit();
	};

	// Leaves text mode without committing; shown only once the draft diverged (`isDirty`), so it is
	// never a quieter twin of the toggle.
	const discard = () => onDraftChange(null);

	// Derived from the label, so Headers and Query Parameters get distinct ids.
	const fieldId = `bulk-edit-${label.replace(/\s+/g, "-").toLowerCase()}`;

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-end gap-2">
				{isDirty && (
					<Button variant="ghost" size="sm" onClick={discard}>
						Discard
					</Button>
				)}
				<ToggleGroup
					size="xs"
					value={isText ? "text" : "table"}
					onValueChange={onModeChange}
					aria-label={`${label} view`}
				>
					<ToggleGroupItem value="table">
						<Table2 className="size-icon-sm" />
						Table
					</ToggleGroupItem>
					<ToggleGroupItem value="text">
						<Edit3 className="size-icon-sm" />
						Bulk edit
					</ToggleGroupItem>
				</ToggleGroup>
			</div>

			{isText ? (
				<div className="space-y-2">
					<Label htmlFor={fieldId}>{label}</Label>
					<Textarea
						id={fieldId}
						value={draft.text}
						onChange={(e) => onDraftChange({ ...draft, text: e.target.value })}
						placeholder={placeholder}
						className="font-mono text-xs min-h-[320px]"
					/>
					<p className="text-xs text-muted-foreground">{hint}</p>
				</div>
			) : (
				<div className="space-y-2">
					{children}
					{tableHeader}
				</div>
			)}

			{after}
		</div>
	);
}

export default BulkEditor;
