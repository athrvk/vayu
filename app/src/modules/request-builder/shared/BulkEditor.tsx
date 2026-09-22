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
 *
 * **`after` renders in both modes.** "Added by Vayu" and the resolved-URL line
 * used to be part of `children`, so they vanished the moment you switched to
 * text - exactly when a bulk-pasted block of params most wants to be checked
 * against the URL it will produce. Only the table itself, and its empty-state
 * `tableHeader`, are table-only; everything that describes *this send* rather
 * than *this table* belongs in `after`.
 *
 * **Committing is still the only way out, but it is no longer the only way
 * back.** A draft that diverges from the table gets a `Discard` action beside
 * the mode toggle, so switching in to look something up and changing your mind
 * does not force a commit the way toggling back always did.
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
	/**
	 * Rendered below the table or the textarea, in both modes - what describes
	 * the send rather than the table (the engine's declared headers, the
	 * resolved URL). See the module doc for why this is not part of `children`.
	 */
	after?: React.ReactNode;
}

export function BulkEditor({
	format,
	onCommit,
	label,
	placeholder,
	hint,
	children,
	tableHeader,
	after,
}: BulkEditorProps) {
	const [isText, setIsText] = useState(false);
	const [draft, setDraft] = useState("");
	// What the table held the moment text mode opened, so `isDirty` reads the
	// draft against the edit's own starting point rather than re-deriving it
	// from a `format()` call that would recompute against the table's *current*
	// (unrelated) state on every render.
	const [opened, setOpened] = useState("");

	const isDirty = isText && draft !== opened;

	const toggle = () => {
		if (isText) {
			onCommit(draft);
			setIsText(false);
		} else {
			const text = format();
			setDraft(text);
			setOpened(text);
			setIsText(true);
		}
	};

	// Leaves text mode without committing. Only ever shown once the draft has
	// actually diverged (`isDirty`), so this is never a second, quieter way to
	// do what the toggle already does.
	const discard = () => setIsText(false);

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
				<div className="flex items-center gap-2 shrink-0">
					{isDirty && (
						<Button variant="ghost" size="sm" onClick={discard}>
							Discard
						</Button>
					)}
					<Button variant="outline" size="sm" onClick={toggle}>
						{isText ? (
							<>
								<Table2 className="size-icon-sm mr-1" />
								Table
							</>
						) : (
							<>
								<Edit3 className="size-icon-sm mr-1" />
								Bulk edit
							</>
						)}
					</Button>
				</div>
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

			{after}
		</div>
	);
}

export default BulkEditor;
