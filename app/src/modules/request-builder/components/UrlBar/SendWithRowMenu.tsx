/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * SendWithRowMenu - Send, bound to one row of the collection's data file (#601).
 *
 * The gap this closes is an authoring one. A pre-request script that reads
 * `pm.iterationData`, or a URL carrying `{{data.id}}`, could only be exercised
 * by starting a whole collection run and then digging the step out of the
 * result - so the edit loop for one line of script was a run. Here the row is
 * one click beside Send, and the response lands in the pane it always does.
 *
 * **A caret on Send, not a third button.** The row list is a *mode of sending*,
 * not a second action, and the UrlBar has no width to spare for another label
 * (see index.tsx - the pair is ~140px and every icon that was tried cost ~20px
 * of the row the URL is already short of). A split button says "same verb,
 * choose the input", which is exactly what this is. The caret carries Send's
 * own fill so the pair reads as one control rather than a seam.
 *
 * **Absent, not disabled, when there is nothing to bind.** A request outside a
 * data-driven collection has no rows, and a disabled control offering to send
 * with one would be a promise the request cannot keep. The one visible-but-
 * blocked state is a declared file that has moved, which is repairable and says
 * so - the same rule the Run dialog's pre-fill follows.
 *
 * The rows are read when this opens and the set is not persisted, held only for
 * as long as the popover and the send that follows it (see `data-file-store`).
 * The send itself is stored like any other design send, so the values the
 * chosen row bound are in its History trace (issue #731).
 *
 * **The list is a browse affordance, not the file** (issue #730). It shows the
 * first {@link PICKER_ROWS} rows, which is enough to recognise the shape of the
 * data and far too few to reach row 501 - the row a failed step of a long run
 * names. So the number field above it takes any index in the file: typing one
 * shows that row and selects it, and Enter sends with it. A list long enough to
 * reach every row would be the file rendered into a popover, which is the thing
 * this deliberately is not.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

import { Input, Popover, PopoverContent, PopoverTrigger } from "@/components/ui";
import { Callout } from "@/components/shared";
import { cn } from "@/lib/utils";
import type { SendWithRowState } from "../../hooks/useSendWithRow";

export interface SendWithRowMenuProps {
	rows: SendWithRowState;
	/** Send bound to this row. The response renders as any design send's does. */
	onSend: (row: Record<string, unknown>) => void;
	disabled: boolean;
	/** Whether the caret owns the group's right corner (no Load Test beside it). */
	lastInGroup: boolean;
	/**
	 * The row index this request was last sent with, and the setter for it.
	 *
	 * Held by the caller - the builder, keyed by request id, in plain state - so
	 * iterating on a script is one click rather than a hunt through the list
	 * each time. Deliberately not persisted: it points into a file whose rows
	 * are not, and a remembered index against a file that has since changed
	 * would name a different row. Keyed rather than single because the builder
	 * is not remounted per tab (#659); a lone number followed the user across
	 * requests.
	 */
	lastRowIndex: number | null;
	onRowIndexChange: (index: number) => void;
	/**
	 * Whether the list is showing, held by the caller.
	 *
	 * Controlled rather than local because opening is not always the user's
	 * click here: a step card's "Repro row N" opens the request *and* this list
	 * on the row that step bound (issue #730), and the caller is what hears that
	 * navigation.
	 */
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/** Enough rows to pick from without turning a popover into the file. */
const PICKER_ROWS = 20;

/** What the row-number field was asking for, or why it cannot be honoured. */
type RowEntry =
	| { kind: "empty" }
	| { kind: "row"; index: number }
	| { kind: "error"; message: string };

/**
 * Read a typed row number as a 0-based index into `total` rows.
 *
 * Refuses rather than clamps: a request to send row 900 of a 500-row file is a
 * mistake about *which row*, and binding row 500 instead would send something
 * the user did not ask for and say nothing about it.
 */
function parseRowEntry(text: string, total: number): RowEntry {
	const trimmed = text.trim();
	if (trimmed === "") return { kind: "empty" };
	if (!/^\d+$/.test(trimmed)) {
		return { kind: "error", message: "Row numbers are digits - 1 is the first row." };
	}
	const oneBased = Number(trimmed);
	if (oneBased < 1 || oneBased > total) {
		return {
			kind: "error",
			message: `The file has ${total.toLocaleString()} ${total === 1 ? "row" : "rows"}.`,
		};
	}
	return { kind: "row", index: oneBased - 1 };
}

/** One cell's text, short enough that a wide column cannot break the layout. */
function cellText(value: unknown): string {
	if (value === null || value === undefined) return "";
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

export default function SendWithRowMenu({
	rows,
	onSend,
	disabled,
	lastInGroup,
	lastRowIndex,
	onRowIndexChange,
	open,
	onOpenChange,
}: SendWithRowMenuProps) {
	const [entry, setEntry] = useState("");

	const parsed = rows.parsed;
	const total = parsed?.rows.length ?? 0;
	const shown = parsed?.rows.slice(0, PICKER_ROWS) ?? [];
	const hidden = total - shown.length;

	const typed = parseRowEntry(entry, total);
	/*
	 * The row this popover is pointing at: what was typed, or - when nothing has
	 * been - the row the caller arrived with, which is the row a step card's
	 * repro named. Only a row past the browse window needs showing separately;
	 * one inside it is already in the list, highlighted.
	 */
	const selected = typed.kind === "row" ? typed.index : lastRowIndex;
	const pinned = parsed && selected !== null && selected >= shown.length ? selected : null;

	/*
	 * Read on open, not on mount: a request tab must not touch the filesystem
	 * for a send nobody asked for. Hung off the state rather than off the
	 * trigger's click, because the caller can open this without one - a repro
	 * navigation does, and that read is one the user did ask for.
	 */
	const wasOpen = useRef(open);
	useEffect(() => {
		if (open && !wasOpen.current) rows.load();
		wasOpen.current = open;
	}, [open, rows]);

	const send = (index: number) => {
		if (!parsed) return;
		onRowIndexChange(index);
		setEntry("");
		onOpenChange(false);
		onSend(parsed.rows[index]);
	};

	const rowSummary = (row: Record<string, unknown>) =>
		parsed?.columns.map((column) => `${column}=${cellText(row[column])}`).join("  ") ?? "";

	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			<PopoverTrigger asChild>
				<button
					type="button"
					aria-label="Send with a data row"
					disabled={disabled}
					className={cn(
						"h-8 px-2 inline-flex items-center shrink-0",
						// Send's own fill and border - this is Send's caret, not a
						// control beside it - with the shared edge transparent so the
						// two do not draw a 2px line between them.
						"bg-primary-fill text-white border border-primary-fill border-l-white/25",
						"hover:bg-primary-fill/90 hover:border-primary-fill/90",
						"disabled:opacity-50 disabled:hover:bg-primary-fill transition-colors",
						lastInGroup ? "rounded-r-md rounded-l-none" : "rounded-none"
					)}
				>
					<ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
				</button>
			</PopoverTrigger>

			<PopoverContent align="end" className="w-96 p-0">
				<div className="border-b border-rule px-3 py-2">
					<p className="text-xs font-semibold">Send with a data row</p>
					<p className="mt-0.5 text-[11px] text-muted-foreground">
						{rows.fileName} · declared by {rows.contract?.collectionName}. The row binds
						every {"{{data.column}}"} and both scripts read it as pm.iterationData.
					</p>
				</div>

				{rows.status === "loading" && (
					<p className="px-3 py-4 text-xs text-muted-foreground">Reading the file…</p>
				)}

				{rows.error && (
					<div className="p-3">
						<Callout severity="blocking" title="Could not read the data file">
							{rows.error}
						</Callout>
					</div>
				)}

				{parsed && (
					<>
						{/* Any row in the file, by number - the list below is the
						    first 20, and a long run's failing row is not among them
						    (issue #730). */}
						<div className="border-b border-rule px-3 py-2">
							<label className="flex items-center gap-2 text-[11px] text-muted-foreground">
								<span className="shrink-0">Row number</span>
								<Input
									value={entry}
									onChange={(e) => setEntry(e.target.value)}
									onKeyDown={(e) => {
										if (e.key !== "Enter") return;
										e.preventDefault();
										if (typed.kind === "row") send(typed.index);
									}}
									inputMode="numeric"
									placeholder={`1 - ${total.toLocaleString()}`}
									aria-label="Send with a row by number"
									aria-invalid={typed.kind === "error"}
									className="h-7 w-28 font-mono text-xs"
								/>
							</label>
							{/* Named, never clamped or ignored: a number outside the
							    file is a mistake about which row, and sending a
							    different one would be worse than sending none. */}
							{typed.kind === "error" && (
								<p className="mt-1 text-[11px] text-destructive-text">
									{typed.message}
								</p>
							)}
						</div>

						<div className="max-h-72 overflow-auto">
							{pinned !== null && (
								<>
									<button
										type="button"
										onClick={() => send(pinned)}
										className={cn(
											"flex w-full items-baseline gap-2 px-3 py-1.5 text-left",
											"bg-accent/60 text-xs transition-colors hover:bg-accent"
										)}
									>
										<span className="w-6 shrink-0 font-mono text-[11px] text-muted-foreground">
											{pinned + 1}
										</span>
										<span className="min-w-0 flex-1 truncate font-mono">
											{rowSummary(parsed.rows[pinned])}
										</span>
									</button>
									{/* The seam, so the row above does not read as row
									    21 of the list under it. */}
									<p className="border-b border-rule px-3 pb-2 text-[11px] text-muted-foreground">
										Row {(pinned + 1).toLocaleString()}, from further down the
										file.
									</p>
								</>
							)}
							{shown.map((row, index) => (
								<button
									key={index}
									type="button"
									onClick={() => send(index)}
									className={cn(
										"flex w-full items-baseline gap-2 px-3 py-1.5 text-left",
										"text-xs hover:bg-accent transition-colors",
										index === selected && "bg-accent/60"
									)}
								>
									<span className="w-6 shrink-0 font-mono text-[11px] text-muted-foreground">
										{index + 1}
									</span>
									<span className="min-w-0 flex-1 truncate font-mono">
										{rowSummary(row)}
									</span>
								</button>
							))}
							{hidden > 0 && (
								<p className="px-3 py-2 text-[11px] text-muted-foreground">
									{hidden} more {hidden === 1 ? "row is" : "rows are"} in the file
									- reach any of them by number above. Run the collection to send
									them all.
								</p>
							)}
						</div>
					</>
				)}
			</PopoverContent>
		</Popover>
	);
}
