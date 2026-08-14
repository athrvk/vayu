/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The table/text toggle that sits above a `KeyValueEditor`, and the textarea it
 * swaps in.
 *
 * **This existed twice**, in `ParamsPanel` and `HeadersPanel`: the same
 * `isBulkEditMode` and `bulkEditText` state, the same `handleToggleMode` with
 * the same "save on the way out, load on the way in" comment, the same toolbar
 * row, and the same `<Textarea>` - both of them labelled `id="bulk-edit"`, so
 * the two would have collided had either ever rendered beside the other.
 *
 * Only the *format* differed, which is the part that genuinely differs: headers
 * are `Name: value`, params are `key=value`. So that is what the caller passes -
 * a parse, a format, and the sentence describing the syntax. Everything else is
 * here.
 *
 * **It stayed in this module when `KeyValueEditor` moved to
 * `components/shared/` (#567).** Nothing in it is key/value-shaped - it is a
 * toggle around whatever children it is given - but its only callers are this
 * module's two panels, and `components/shared/` is for what *several* features
 * share. It is imported directly rather than re-exported from the table, which
 * is where a panel used to take both from one place; a shared primitive cannot
 * re-export something from a feature module.
 *
 * The draft text is local state on purpose. Bulk edit is a staging area: you
 * paste a block, fix it up, and it commits when you switch back to the table.
 * Parsing on every keystroke would rewrite the request underneath a
 * half-finished paste.
 */

import { useState } from "react";
import { Edit3, Table2 } from "lucide-react";
import { Button, Label, Textarea } from "@/components/ui";

export interface BulkEditorProps {
	/** The rows as text, for when the user switches *into* text mode. */
	format: () => string;
	/**
	 * The edited text, when the user switches back to the table.
	 *
	 * Text rather than parsed rows: both callers already own a parser that knows
	 * their syntax *and* what to do with the result - headers have to re-impose
	 * the managed system rows, params have to rewrite the URL. Parsing here would
	 * mean handing the rows straight back for a second pass.
	 */
	onCommit: (text: string) => void;
	/** "Headers" / "Query Parameters" - names the textarea. */
	label: string;
	placeholder: string;
	/** The syntax note under the field. Headers and params differ here. */
	hint: React.ReactNode;
	/** The table, rendered when not in text mode. */
	children: React.ReactNode;
	/** Sits between the toggle and the table - the empty-state hint. */
	tableHeader?: React.ReactNode;
}

export function BulkEditor({
	format,
	onCommit,
	label,
	placeholder,
	hint,
	children,
	tableHeader,
}: BulkEditorProps) {
	const [isText, setIsText] = useState(false);
	const [draft, setDraft] = useState("");

	const toggle = () => {
		if (isText) {
			onCommit(draft);
			setIsText(false);
		} else {
			setDraft(format());
			setIsText(true);
		}
	};

	/*
	 * Derived from the label, so Headers and Query Parameters get different ids.
	 * Both old copies hardcoded `id="bulk-edit"` with a `<Label htmlFor>` to
	 * match - harmless only because one panel is mounted at a time, and exactly
	 * the copy-paste tell this component exists to remove.
	 */
	const fieldId = `bulk-edit-${label.replace(/\s+/g, "-").toLowerCase()}`;

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between gap-3">
				{/*
				 * Empty when the table has rows: the instruction that used to live
				 * here permanently now belongs to the empty state, where it is read
				 * once rather than every time.
				 */}
				<div className="min-w-0">{!isText && tableHeader}</div>
				<Button variant="outline" size="sm" onClick={toggle} className="shrink-0">
					{isText ? (
						<>
							<Table2 className="w-3.5 h-3.5 mr-1" />
							Table
						</>
					) : (
						<>
							<Edit3 className="w-3.5 h-3.5 mr-1" />
							Bulk edit
						</>
					)}
				</Button>
			</div>

			{isText ? (
				<div className="space-y-2">
					<Label htmlFor={fieldId}>{label}</Label>
					<Textarea
						id={fieldId}
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						placeholder={placeholder}
						className="font-mono text-xs min-h-[320px]"
					/>
					<p className="text-xs text-muted-foreground">{hint}</p>
				</div>
			) : (
				children
			)}
		</div>
	);
}

export default BulkEditor;
