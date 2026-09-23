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
 *
 * **The toggle is a `ToggleGroup`, not a `Button` that swaps its own label.**
 * A pill `Button` at `size="sm"` (`h-control-sm` plus a border and `px-3`) reads
 * as a heavier control than anything else on this panel - the table rows it
 * sits above are a 36px grid with no border on their own inputs. `ToggleGroup`
 * is the app's existing primitive for exactly this - one choice out of a few,
 * all visible - and its `xs` step is the one `ResponseBody`'s own Pretty/Raw/
 * Preview switch already sits on a dense toolbar row.
 *
 * **`tableHeader` is not in the toggle row, and it renders below the table,
 * not above it.** It used to share a `justify-between` flex row with the
 * toggle, so the row's own height was `max(sentence, toggle)` - and the
 * sentence is a conditionally-mounted, sometimes two-line `<p>`
 * (`EmptyTableHint`), gone the moment the table gets its first row *or* the
 * moment bulk edit opens. Either trigger snapped the row from two-line-tall
 * down to the toggle's own ~24px, and everything below it jumped. Moving it
 * out of the toggle row fixed that jump, but the sentence was still *above*
 * the table at that point, so the table's own top edge (every row, the
 * caret you are typing into) still moved on the first keystroke into an
 * empty table - a shift right where the user is looking and typing.
 *
 * The remaining fix is order, not visibility: `tableHeader` renders *after*
 * `children`, below the table's own trailing blank row. Its mount/unmount
 * still moves content, but only content below the row the user's cursor is
 * in - the row itself, everything above it, and the toggle never move. This
 * is deliberately not "always show it": the sentence restates what the row
 * placeholder and the `{{token}}` colouring already say once there is a real
 * row, and a permanent two-line strip on every request forever is exactly
 * the furniture `EmptyTableHint`'s own doc comment describes removing.
 * Reserving its height so it fades instead of unmounting was considered and
 * rejected too - that keeps the clutter (an invisible box the same size as
 * the text) while still not being visible, the worst of both. Hiding it
 * behind a tooltip/info-icon was also rejected: burying the one thing this
 * sentence exists to teach (`{{variable}}` syntax) behind a disclosure is
 * wrong for the one moment - a genuinely empty tab - discovery matters most.
 */

import { useState } from "react";
import { Edit3, Table2 } from "lucide-react";
import { Button, Label, Textarea, ToggleGroup, ToggleGroupItem } from "@/components/ui";

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
	/**
	 * The empty-state hint, rendered directly below the table - table-only,
	 * like `children`, and not part of the toggle row. See the module doc:
	 * neither the toggle row nor the table's own top edge can carry this
	 * without a mount/unmount of it moving content the user is looking at.
	 */
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

	const enterText = () => {
		const text = format();
		setDraft(text);
		setOpened(text);
		setIsText(true);
	};

	const commitText = () => {
		onCommit(draft);
		setIsText(false);
	};

	// Radix's single-select toggle group reports "" on a click that would
	// deselect the active item - ignored, the same way ResponseBody's own view
	// mode switch ignores it, since a mode toggle here has no "neither" state.
	const onModeChange = (next: string) => {
		if (next === "text" && !isText) enterText();
		if (next === "table" && isText) commitText();
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
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
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
