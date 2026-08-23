/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * SendWithRowDialog - Send, bound to one row of the collection's data file (#601).
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
 * **A dialog, not a popover** (issue #892). It was a ~384px popover anchored
 * under the caret, and every compromise in the old design came from that box:
 * a row was one truncated line with its column name printed in front of every
 * value (`userId=1001 email=ada@example.com plan=pro q…`), the list stopped at
 * twenty rows, and a number field stood in for the rows there was no room to
 * show. Picking a row meant reading a sentence instead of scanning a column,
 * and the twenty-first row was reachable only by knowing its index. Choosing a
 * row out of tabular data is a *browse*, and a browse needs the room: at
 * `2xl` the rows are a real grid with the columns named once, every row is in
 * it, and a filter narrows them. The number field stays, demoted from mechanism
 * to shortcut.
 *
 * The one thing the popover was right about is kept: this is not the file
 * rendered into a box. Rows arrive as they are scrolled to
 * ({@link useGrowingWindow}), so a thousand-row set costs a screenful of DOM
 * rather than a thousand rows of it.
 *
 * **Absent, not disabled, when there is nothing to bind.** A request outside a
 * data-driven collection has no rows, and a disabled control offering to send
 * with one would be a promise the request cannot keep. The one visible-but-
 * blocked state is a declared file that has moved, which is repairable and says
 * so - the same rule the Run dialog's pre-fill follows.
 *
 * The rows are read when this opens and the set is not persisted, held only for
 * as long as the dialog and the send that follows it (see `data-file-store`).
 * The send itself is stored like any other design send, so the values the
 * chosen row bound are in its History trace (issue #731).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, FileSpreadsheet } from "lucide-react";

import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
	Input,
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui";
import { Callout } from "@/components/shared";
import { useGrowingWindow } from "@/hooks/useGrowingWindow";
import { dataCellText, type DataFileRow } from "@/services/data-files";
import { cn } from "@/lib/utils";
import { isCommitEnter } from "@/lib/keyboard";
import type { SendWithRowState } from "../../hooks/useSendWithRow";

export interface SendWithRowDialogProps {
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
	 * Whether the picker is showing, held by the caller.
	 *
	 * Controlled rather than local because opening is not always the user's
	 * click here: a step card's "Repro row N" opens the request *and* this
	 * picker on the row that step bound (issue #730), and the caller is what
	 * hears that navigation.
	 */
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/**
 * How many rows are added each time the end of the list is scrolled into view.
 *
 * Larger than the console's default because a row is one line of a grid rather
 * than a wrapped log line, so a screenful is more of them - and because the
 * whole set is bounded by `maxScenarioDataRows` (1,000 by default), which means
 * a single growth step covers most real files outright.
 */
const ROW_WINDOW_STEP = 100;

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

/**
 * One cell's text, capped so a long value cannot set the grid's width.
 *
 * The cap is generous where the popover's was tight (40 characters for the whole
 * row): a cell has its own column here, and the row is not competing with six
 * others for one line.
 */
function cellText(value: unknown): string {
	const text = dataCellText(value);
	return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/**
 * Rows whose text matches `query`, with their original indices kept.
 *
 * Matched against the whole row rather than a chosen column: the user is
 * looking for a row they can describe ("the enterprise one", "grace"), not
 * running a query, and asking them which column it is in first would be the
 * wrong question. Case-insensitive for the same reason.
 *
 * The index travels with the row because everything else about this dialog is
 * stated in file positions - the number field, the footer, the remembered row,
 * a step's repro - and a filtered list that renumbered from 1 would make "row
 * 3" mean two different rows depending on what was typed in the filter.
 */
function matchingRows(
	rows: DataFileRow[],
	columns: string[],
	query: string
): { row: DataFileRow; index: number }[] {
	const all = rows.map((row, index) => ({ row, index }));
	const needle = query.trim().toLowerCase();
	if (needle === "") return all;
	return all.filter(({ row }) =>
		columns.some((column) => dataCellText(row[column]).toLowerCase().includes(needle))
	);
}

export default function SendWithRowDialog({
	rows,
	onSend,
	disabled,
	lastInGroup,
	lastRowIndex,
	onRowIndexChange,
	open,
	onOpenChange,
}: SendWithRowDialogProps) {
	const [entry, setEntry] = useState("");
	const [filter, setFilter] = useState("");

	const parsed = rows.parsed;
	const total = parsed?.rows.length ?? 0;
	/*
	 * Memoised, not `parsed?.columns ?? []`: that fallback is a fresh array on
	 * every render, so the filter below would re-run for every keystroke
	 * anywhere in the dialog rather than for a change to the rows or the query.
	 */
	const columns = useMemo(() => parsed?.columns ?? [], [parsed]);

	const typed = parseRowEntry(entry, total);
	/*
	 * The row this dialog is pointing at: what was typed, or - when nothing has
	 * been - the row the caller arrived with, which is the row a step card's
	 * repro named. Falls back to the first row so the footer always names one.
	 * Which row is *focusable* is a separate question, answered by `focusable`
	 * below: this index can point outside the rows on screen, and the grid's tab
	 * stop cannot.
	 */
	const selected = typed.kind === "row" ? typed.index : (lastRowIndex ?? 0);
	/*
	 * Whether `selected` still names a row of the file just read (issue #894).
	 *
	 * Only the fallback can be stale - `parseRowEntry` refuses a number outside
	 * the file, while neither the remembered index nor a step's repro target is
	 * clamped against a file that has since shrunk, been re-picked, or been cut
	 * by a lowered `maxScenarioDataRows`. Named here rather than fixed by
	 * clamping, for the same reason the typed path refuses: binding the last row
	 * instead would send a row the user did not ask for and say nothing.
	 */
	const selectedMissing = selected >= total;

	const visibleRows = useMemo(
		() => matchingRows(parsed?.rows ?? [], columns, filter),
		[parsed, columns, filter]
	);
	const { visible, sentinelRef, hasMore } = useGrowingWindow(visibleRows.length, ROW_WINDOW_STEP);
	const rendered = visibleRows.slice(0, visible);

	/*
	 * Which rendered row carries the grid's single tab stop.
	 *
	 * `selected` is an address into the *file*, and three ordinary states leave
	 * it outside the rows on screen: a remembered index past the growing window,
	 * a filter that excludes it, and a file that shrank under it (#894). Hanging
	 * the roving `tabIndex=0` off `selected` alone meant every one of those left
	 * the grid with no tab stop at all - out of the tab order, its key handler
	 * unreachable, which is the opposite of what a roving tabindex is for.
	 *
	 * So the tab stop falls back to the first rendered row. It moves the *focus*,
	 * never the selection: which row a Send binds is #894's question and is still
	 * answered by refusing, not by quietly re-pointing at a row nobody asked for.
	 */
	const focusable = rendered.some(({ index }) => index === selected)
		? selected
		: (rendered[0]?.index ?? -1);

	/*
	 * Read on open, not on mount: a request tab must not touch the filesystem
	 * for a send nobody asked for. Hung off the state rather than off the
	 * trigger's click, because the caller can open this without one - a repro
	 * navigation does, and that read is one the user did ask for.
	 */
	const wasOpen = useRef(open);
	useEffect(() => {
		if (open && !wasOpen.current) {
			rows.load();
			// A new visit starts from the file, not from the last visit's typing.
			setFilter("");
			setEntry("");
		}
		wasOpen.current = open;
	}, [open, rows]);

	/*
	 * Bring the selected row into view when it was reached by number rather than
	 * by clicking - typing "480" is the case the old number field existed for,
	 * and here it should scroll the grid to row 480 instead of pinning a copy of
	 * it above the list. Optional-called because jsdom has no layout and
	 * therefore no `scrollIntoView`.
	 */
	const rowRefs = useRef(new Map<number, HTMLTableRowElement>());
	useEffect(() => {
		if (typed.kind !== "row") return;
		rowRefs.current.get(selected)?.scrollIntoView?.({ block: "nearest" });
	}, [typed.kind, selected]);

	/*
	 * Focus follows selection, but only when the grid itself moved it.
	 *
	 * Arrow keys change `selected` through the number field's state, and that
	 * same state is what a user types into - so focusing the selected row on
	 * every change would pull the caret out of the field mid-number. The flag is
	 * set by the grid's own handler and read once, so a keyboard move takes DOM
	 * focus with it (the ring, and the row a screen reader announces) while
	 * typing "480" leaves focus where it was typed.
	 */
	const focusMovedRow = useRef(false);
	useEffect(() => {
		if (!focusMovedRow.current) return;
		focusMovedRow.current = false;
		rowRefs.current.get(selected)?.focus();
	}, [selected]);

	const send = useCallback(
		(index: number) => {
			/*
			 * The one funnel every entry path reaches, so the bounds check lives
			 * here: `parsed.rows[index]` is typed as a row but is `undefined` for
			 * an index the file has no row at, and `executeRequest` reads that as
			 * an ordinary row-less send - the request goes out with every
			 * `{{data.*}}` token unbound and nothing says so (issue #894). The UI
			 * refuses before this point; this is what makes the silent send
			 * unreachable rather than merely unlikely.
			 */
			if (!parsed || index < 0 || index >= parsed.rows.length) return;
			onRowIndexChange(index);
			setEntry("");
			onOpenChange(false);
			onSend(parsed.rows[index]);
		},
		[parsed, onRowIndexChange, onOpenChange, onSend]
	);

	/**
	 * How many rows PageUp/PageDown cover.
	 *
	 * Taken rather than left out: the grid pattern lists them as optional, and
	 * without them a keyboard user crossing a 500-row file has one row per press
	 * or the number field's absolute address, with nothing between. Ten is a
	 * screenful of this grid at the dialog's height rather than a computed page,
	 * because the scroller's height is not known here and a wrong measurement
	 * would move the selection somewhere the eye did not follow.
	 */
	const PAGE_ROWS = 10;

	/**
	 * Arrow keys move the selection through the *rendered* rows, Enter sends.
	 *
	 * The number field is the absolute address and this is the relative one, so
	 * a keyboard user who has filtered to four rows steps through those four
	 * rather than through the file underneath them. Bounded by what is rendered
	 * rather than by the whole filtered set because focus follows selection: a
	 * step onto a row past the growing window would move `aria-selected` to a row
	 * with no element to focus, which is the announcement gap this closes.
	 *
	 * `isCommitEnter` rather than `e.key === "Enter"`: an Enter carrying Ctrl/Cmd
	 * is the app's Send chord, and this grid and the window listener both acting
	 * on it produced two competing executions of the same request (#935).
	 */
	const onGridKeyDown = (e: React.KeyboardEvent<HTMLTableSectionElement>) => {
		if (isCommitEnter(e) || e.key === " ") {
			e.preventDefault();
			send(selected);
			return;
		}
		const at = rendered.findIndex((r) => r.index === selected);
		const last = rendered.length - 1;
		const target =
			e.key === "ArrowDown"
				? at + 1
				: e.key === "ArrowUp"
					? at - 1
					: e.key === "PageDown"
						? at + PAGE_ROWS
						: e.key === "PageUp"
							? at - PAGE_ROWS
							: e.key === "Home"
								? 0
								: e.key === "End"
									? last
									: null;
		if (target === null) return;
		e.preventDefault();
		const next = rendered[Math.min(Math.max(target, 0), last)];
		if (!next || next.index === selected) return;
		// Through the number field's own state, so the two addresses of a row
		// never disagree about which one is selected.
		focusMovedRow.current = true;
		setEntry(String(next.index + 1));
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogTrigger asChild>
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
			</DialogTrigger>

			{/* `2xl`, the browser width - see `DialogContent`. Seven columns of
			    ordinary CSV is the shape this is sized for. */}
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Send with a data row</DialogTitle>
					<DialogDescription>
						One send, bound to one row. The row fills every{" "}
						<code className="font-mono">{"{{data.column}}"}</code> in this request and
						both scripts read it as <code className="font-mono">pm.iterationData</code>.
					</DialogDescription>
				</DialogHeader>

				{/* The file this is reading, said the same way the Run dialog's
				    preview says it - same file, same summary, so the two do not
				    read as two different data sets. */}
				<div className="flex items-center gap-2 rounded-md border border-rule bg-card surface-card px-3 py-2 text-xs">
					<FileSpreadsheet
						aria-hidden="true"
						className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
					/>
					<span className="truncate font-medium">{rows.fileName}</span>
					<span className="shrink-0 text-muted-foreground">
						declared by {rows.contract?.collectionName}
					</span>
					{parsed && (
						<span className="ml-auto shrink-0 text-muted-foreground">
							{parsed.format.toUpperCase()} · {total.toLocaleString()}{" "}
							{total === 1 ? "row" : "rows"} · {columns.length}{" "}
							{columns.length === 1 ? "column" : "columns"}
						</span>
					)}
				</div>

				{rows.status === "loading" && (
					<p className="text-xs text-muted-foreground">Reading the file…</p>
				)}

				{rows.error && (
					<Callout severity="blocking" title="Could not read the data file">
						{rows.error}
					</Callout>
				)}

				{parsed && (
					<>
						<div className="flex items-end gap-2">
							<label className="flex-1 space-y-1">
								<span className="text-[11px] text-muted-foreground">
									Filter rows
								</span>
								<Input
									value={filter}
									onChange={(e) => setFilter(e.target.value)}
									placeholder="Any value in any column"
									aria-label="Filter rows"
									className="h-7 text-xs"
								/>
							</label>
							{/* The absolute address, kept from the popover and demoted:
							    the rows are all here now, so this is how you reach row
							    480 of 500 without scrolling to it. */}
							<label className="space-y-1">
								<span className="text-[11px] text-muted-foreground">Row</span>
								<Input
									value={entry}
									onChange={(e) => setEntry(e.target.value)}
									onKeyDown={(e) => {
										if (!isCommitEnter(e)) return;
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
						</div>
						{/* Named, never clamped or ignored: a number outside the file
						    is a mistake about which row, and sending a different one
						    would be worse than sending none. */}
						{typed.kind === "error" && (
							<p className="text-[11px] text-destructive-text">{typed.message}</p>
						)}
						{/* The same refusal for the row nobody typed: a remembered index,
						    or a step's repro target, pointing past the file as it reads
						    now. Said rather than clamped, and the footer's button is
						    dead while it stands. */}
						{selectedMissing && (
							<p className="text-[11px] text-destructive-text">
								Row {(selected + 1).toLocaleString()} no longer exists - the file
								has {total.toLocaleString()} {total === 1 ? "row" : "rows"}. Pick
								one below.
							</p>
						)}

						<DialogBody className="rounded-md border border-rule">
							{visibleRows.length === 0 ? (
								/* An empty box would read as "the file has no rows",
								   which is a different fact from "nothing matches what
								   you typed" - and only one of them is fixable here. */
								<p className="px-3 py-6 text-center text-xs text-muted-foreground">
									No rows match “{filter}”.
								</p>
							) : (
								/*
								 * `role="grid"`, so the rows can be `aria-selected` -
								 * that attribute means nothing on a plain table's row.
								 * A roving tabindex keeps the grid one tab stop rather
								 * than one per row, which at a thousand rows is the
								 * difference between a keyboard reaching the footer and
								 * not - exactly one, always, because the stop falls back
								 * to the first rendered row when the selected row is not
								 * on screen (see `focusable`). Arrow, Home, End and
								 * PageUp/PageDown move that stop and DOM focus with it,
								 * per the WAI-ARIA grid pattern: a selection a screen
								 * reader is never told about is not a selection.
								 */
								<Table role="grid" aria-label="Data rows">
									<TableHeader className="sticky top-0 z-10 bg-card">
										<TableRow>
											<TableHead className="w-12 text-right font-mono">
												#
											</TableHead>
											{columns.map((column) => (
												<TableHead key={column}>{column}</TableHead>
											))}
										</TableRow>
									</TableHeader>
									<TableBody onKeyDown={onGridKeyDown}>
										{rendered.map(({ row, index }) => (
											<TableRow
												key={index}
												ref={(el) => {
													if (el) rowRefs.current.set(index, el);
													else rowRefs.current.delete(index);
												}}
												aria-selected={index === selected}
												tabIndex={index === focusable ? 0 : -1}
												onClick={() => send(index)}
												className={cn(
													"cursor-pointer",
													index === selected && "bg-accent/60"
												)}
											>
												<TableCell className="w-12 text-right font-mono text-[11px] text-muted-foreground">
													{index + 1}
												</TableCell>
												{columns.map((column) => (
													<TableCell
														key={column}
														className="whitespace-nowrap font-mono"
													>
														{cellText(row[column])}
													</TableCell>
												))}
											</TableRow>
										))}
										{hasMore && (
											/* The sentinel the window grows on. It is a
											   real row so it lands inside the scroller
											   the observer needs it to appear in. */
											<TableRow ref={sentinelRef} className="border-b-0">
												<TableCell
													colSpan={columns.length + 1}
													className="py-2 text-center text-[11px] text-muted-foreground"
												>
													Loading more rows…
												</TableCell>
											</TableRow>
										)}
									</TableBody>
								</Table>
							)}
						</DialogBody>

						<DialogFooter className="items-center">
							<p className="mr-auto text-[11px] text-muted-foreground">
								{/* Which rows are on screen, and that scrolling brings
								    the rest - said because the grid can clip without
								    looking clipped on an overlay-scrollbar platform. */}
								{filter.trim() !== ""
									? `${visibleRows.length.toLocaleString()} of ${total.toLocaleString()} ${
											total === 1 ? "row" : "rows"
										} match.`
									: hasMore
										? `Showing ${rendered.length.toLocaleString()} of ${total.toLocaleString()} rows - scroll for more.`
										: `All ${total.toLocaleString()} ${total === 1 ? "row" : "rows"}.`}
							</p>
							<button
								type="button"
								onClick={() => onOpenChange(false)}
								className="h-8 rounded-md px-3 text-xs font-medium hover:bg-accent transition-colors"
							>
								Cancel
							</button>
							{/* Names the row it will send, so a row reached by typing a
							    number is confirmable without hunting for it in the
							    grid. Clicking a row still sends outright - the fast
							    loop this feature exists for is one click.

							    Disabled while the named row is not in the file, so the
							    button never offers a send it would have to make without
							    a row; the line above the grid says which row and why. */}
							<button
								type="button"
								disabled={selectedMissing}
								onClick={() => send(selected)}
								className={cn(
									"h-8 rounded-md px-3 text-xs font-semibold",
									"bg-primary-fill text-white border border-primary-fill",
									"hover:bg-primary-fill/90 hover:border-primary-fill/90",
									"disabled:opacity-50 disabled:hover:bg-primary-fill",
									"disabled:hover:border-primary-fill transition-colors"
								)}
							>
								Send row {(selected + 1).toLocaleString()}
							</button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
