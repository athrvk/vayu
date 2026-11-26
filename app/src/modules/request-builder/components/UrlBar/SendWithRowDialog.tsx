/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Send, bound to one row of the collection's data file (#601), so a script reading
 * `pm.iterationData` or a URL carrying `{{data.id}}` is exercised in one click, not a whole
 * collection run, and the response lands in the usual pane.
 *
 * - **A caret on Send, not a third button.** The row list is a *mode of sending*, and the UrlBar
 *   has no spare width (index.tsx: the pair is ~140px, and each icon tried cost ~20px). A split
 *   button says "same verb, choose the input"; the caret carries Send's fill so the pair reads as
 *   one.
 * - **A dialog, not a popover** (#892). Choosing a row of tabular data is a *browse*: at `2xl` the
 *   rows are a grid with columns named once, every row present, a filter to narrow them, and the
 *   number field as a shortcut. A ~384px popover forced one truncated line per row with column
 *   names repeated, a twenty-row cap, and the 21st row reachable only by index.
 * - **Not the file rendered into a box**: rows arrive as scrolled to ({@link useGrowingWindow}), so
 *   a thousand-row set costs a screenful of DOM.
 * - **Absent, not disabled, with nothing to bind**: outside a data-driven collection a disabled
 *   control would promise what the request cannot do. The one visible-but-blocked state is a
 *   declared file that moved, which is repairable and says so, as the Run dialog's pre-fill does.
 *
 * Rows are read on open and never persisted, held only for the dialog and the send that follows
 * (`data-file-store`); the send is stored like any design send, so the bound values are in its
 * History trace (#731).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, FileSpreadsheet } from "lucide-react";

import {
	Button,
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
	DialogCancelButton,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui";
import { Callout, EmptyState, FieldError } from "@/components/shared";
import { useGrowingWindow } from "@/hooks/useGrowingWindow";
import { dataCellText, type DataFileRow } from "@/services/data-files";
import { cn } from "@/lib/utils";
import { isCommitEnter } from "@/lib/keyboard";
import { pluralize } from "@/modules/dashboard/utils/format";
import type { SendWithRowState } from "../../hooks/useSendWithRow";

export interface SendWithRowDialogProps {
	rows: SendWithRowState;
	/** Send bound to this row. The response renders as any design send's does. */
	onSend: (row: Record<string, unknown>) => void;
	disabled: boolean;
	/** Whether the caret owns the group's right corner (no Load Test beside it). */
	lastInGroup: boolean;
	/**
	 * The row index this request was last sent with, and its setter. Held by the caller (the
	 * builder, keyed by request id, plain state), so iterating on a script is one click. Not
	 * persisted: it points into a file whose rows are not, and a stale index would name another
	 * row. Keyed, not single, because the builder is not remounted per tab (#659); a lone number
	 * followed the user across requests.
	 */
	lastRowIndex: number | null;
	onRowIndexChange: (index: number) => void;
	/**
	 * Whether the picker shows, held by the caller: a step card's "Repro row N" opens the request
	 * *and* this picker on that step's row (#730), and the caller hears that navigation.
	 */
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/**
 * Rows added each time the list's end scrolls into view. Above the console's default: a row is one
 * grid line, not a wrapped log line, and the set is bounded by `maxScenarioDataRows` (1,000 by
 * default), so one step covers most files.
 */
const ROW_WINDOW_STEP = 100;

/** What the row-number field was asking for, or why it cannot be honoured. */
type RowEntry =
	{ kind: "empty" } | { kind: "row"; index: number } | { kind: "error"; message: string };

/**
 * A typed row number as a 0-based index into `total` rows. Refuses rather than clamps: row 900 of a
 * 500-row file is a mistake about *which row*, and binding row 500 would silently send another.
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
			message: `The file has ${total.toLocaleString()} ${pluralize(total, "row")}.`,
		};
	}
	return { kind: "row", index: oneBased - 1 };
}

/**
 * One cell's text, capped so a long value cannot set the grid's width; generous, since each cell
 * has its own column.
 */
function cellText(value: unknown): string {
	const text = dataCellText(value);
	return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/**
 * Rows whose text matches `query`, keeping original indices. Matched against the whole row, not a
 * column: the user describes a row ("the enterprise one", "grace"), not a query, so asking which
 * column first is the wrong question; case-insensitive for the same reason. The index travels with
 * the row because everything else here speaks file positions (the number field, the footer, the
 * remembered row, a step's repro), and renumbering a filtered list would make "row 3" ambiguous.
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
	// Memoised: `parsed?.columns ?? []` is a fresh array per render, re-running the filter on every
	// keystroke.
	const columns = useMemo(() => parsed?.columns ?? [], [parsed]);

	const typed = parseRowEntry(entry, total);
	/*
	 * The row the dialog points at: what was typed, else the caller's row (a step card's repro),
	 * else the first, so the footer always names one. Which row is *focusable* is `focusable`'s
	 * question: this index can point off screen, the grid's tab stop cannot.
	 */
	const selected = typed.kind === "row" ? typed.index : (lastRowIndex ?? 0);
	/*
	 * Whether `selected` still names a row of the file just read (#894). Only the fallback can be
	 * stale: `parseRowEntry` refuses an out-of-file number, but the remembered index and a repro
	 * target are not clamped against a file that shrank, was re-picked, or was cut by a lowered
	 * `maxScenarioDataRows`. Named, not clamped, for the typed path's reason: binding the last row
	 * would silently send another.
	 */
	const selectedMissing = selected >= total;

	const visibleRows = useMemo(
		() => matchingRows(parsed?.rows ?? [], columns, filter),
		[parsed, columns, filter]
	);
	const { visible, sentinelRef, hasMore } = useGrowingWindow(visibleRows.length, ROW_WINDOW_STEP);
	const rendered = visibleRows.slice(0, visible);

	/*
	 * Which rendered row holds the grid's single tab stop. `selected` addresses the *file*, and
	 * three ordinary states put it off screen: a remembered index past the window, a filter
	 * excluding it, a file that shrank (#894). A tab stop on `selected` alone left the grid with
	 * none, out of the tab order with its keys unreachable. So it falls back to the first rendered
	 * row, moving *focus*, never selection: which row a Send binds is still answered by refusing.
	 */
	const focusable = rendered.some(({ index }) => index === selected)
		? selected
		: (rendered[0]?.index ?? -1);

	/*
	 * Read on open, not mount: a request tab must not touch the filesystem for a send nobody asked
	 * for. Hung off the state, not the trigger's click, since a repro navigation opens this without
	 * one, and that read was asked for.
	 */
	const wasOpen = useRef(open);
	useEffect(() => {
		if (open && !wasOpen.current) {
			rows.load();
			// A new visit starts from the file, not the last visit's typing.
			setFilter("");
			setEntry("");
		}
		wasOpen.current = open;
	}, [open, rows]);

	/*
	 * Bring the selected row into view when reached by number, not click: typing "480" scrolls the
	 * grid to row 480. Optional-called because jsdom has no layout, so no `scrollIntoView`.
	 */
	const rowRefs = useRef(new Map<number, HTMLTableRowElement>());
	useEffect(() => {
		if (typed.kind !== "row") return;
		rowRefs.current.get(selected)?.scrollIntoView?.({ block: "nearest" });
	}, [typed.kind, selected]);

	/*
	 * Focus follows selection only when the grid moved it. Arrows change `selected` through the
	 * number field's state, which the user also types into, so focusing on every change would pull
	 * the caret out mid-number. The grid's handler sets this flag, read once: a keyboard move takes
	 * DOM focus (the ring, the row a screen reader announces), while typing "480" leaves focus put.
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
			 * The funnel every entry path reaches, so the bounds check is here:
			 * `parsed.rows[index]` is typed as a row but `undefined` past the file, which
			 * `executeRequest` reads as a row-less send, every `{{data.*}}` unbound with nothing
			 * said (#894). The UI refuses earlier; this makes the silent send unreachable, not
			 * merely unlikely.
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
	 * Rows PageUp/PageDown cover. Optional in the grid pattern but taken: without them a keyboard
	 * user crossing 500 rows has one row per press or the field's absolute address. Ten, a
	 * screenful at the dialog's height, not a computed page: the scroller's height is unknown here,
	 * and a wrong measurement would move the selection where the eye did not follow.
	 */
	const PAGE_ROWS = 10;

	/**
	 * Arrows move the selection through the *rendered* rows; Enter sends. The number field is the
	 * absolute address and this the relative one, so after filtering to four rows a user steps
	 * through those four. Bounded by what is rendered, as focus follows selection: a step past the
	 * window would move `aria-selected` to a row with nothing to focus. `isCommitEnter`, not
	 * `e.key === "Enter"`: a Ctrl/Cmd+Enter is the Send chord, and this grid and the window
	 * listener both acting on it ran the request twice (#935).
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
		// Through the number field's state, so a row's two addresses never disagree.
		focusMovedRow.current = true;
		setEntry(String(next.index + 1));
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{/*
			 * Send and Load Test beside this caret carry `Hint` tooltips, so an untooltipped caret
			 * between them read as broken. No chord (it opens on click only), so a plain label
			 * rather than `Hint`, which needs one.
			 */}
			<Tooltip>
				<TooltipTrigger asChild>
					<DialogTrigger asChild>
						<button
							type="button"
							aria-label="Send with a data row"
							disabled={disabled}
							className={cn(
								// `h-control`, not `h-8`: between two `h-control` buttons (#1679),
								// and since `--spacing` moved to the 3px rhythm (#1670) `h-8` is
								// visibly shorter; the caret shows only with a bound data file.
								"h-control min-w-target px-2 inline-flex items-center shrink-0",
								// Send's own fill and border, as Send's caret, with the shared edge
								// transparent so no 2px line forms.
								"bg-primary-fill text-white border border-primary-fill border-l-white/25",
								"hover:bg-primary-fill-hover hover:border-primary-fill-hover",
								"disabled:opacity-50 disabled:hover:bg-primary-fill transition-colors",
								lastInGroup ? "rounded-r-md rounded-l-none" : "rounded-none"
							)}
						>
							<ChevronDown aria-hidden="true" className="size-icon-sm" />
						</button>
					</DialogTrigger>
				</TooltipTrigger>
				<TooltipContent side="bottom">Send with a data row</TooltipContent>
			</Tooltip>

			{/*
			 * `2xl`, the browser width (see `DialogContent`), sized for seven columns of ordinary
			 * CSV.
			 */}
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Send with a data row</DialogTitle>
					<DialogDescription>
						One send, bound to one row. The row fills every{" "}
						<code className="font-mono">{"{{data.column}}"}</code> in this request and
						both scripts read it as <code className="font-mono">pm.iterationData</code>.
					</DialogDescription>
				</DialogHeader>

				{/*
				 * The file, said as the Run dialog's preview says it, so the two do not read as two
				 * data sets.
				 */}
				<div className="flex items-center gap-2 rounded-md border border-rule bg-card surface-card px-3 py-2 text-xs">
					<FileSpreadsheet
						aria-hidden="true"
						className="size-icon-sm shrink-0 text-muted-foreground"
					/>
					<span className="truncate font-medium">{rows.fileName}</span>
					<span className="shrink-0 text-muted-foreground">
						declared by {rows.contract?.collectionName}
					</span>
					{parsed && (
						<span className="ml-auto shrink-0 text-muted-foreground">
							{parsed.format.toUpperCase()} · {total.toLocaleString()}{" "}
							{pluralize(total, "row")} · {columns.length}{" "}
							{pluralize(columns.length, "column")}
						</span>
					)}
				</div>

				{rows.status === "loading" && (
					<p className="text-xs text-muted-foreground">Reading the file…</p>
				)}

				{rows.error && (
					<Callout severity="blocking" title="Couldn't read the data file">
						{rows.error}
					</Callout>
				)}

				{parsed && (
					<>
						<div className="flex items-end gap-2">
							<label className="flex-1 space-y-1">
								<span className="text-label text-muted-foreground">
									Filter rows
								</span>
								<Input
									size="sm"
									value={filter}
									onChange={(e) => setFilter(e.target.value)}
									placeholder="Any value in any column"
									aria-label="Filter rows"
									className="text-xs"
								/>
							</label>
							{/*
							 * The absolute address: how to reach row 480 of 500 without scrolling.
							 */}
							<label className="space-y-1">
								<span className="text-label text-muted-foreground">Row</span>
								<Input
									size="sm"
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
									// Fixed rem, not `w-28`: a row number (e.g. "1 - 500") is a
									// text measure that should not narrow at the Default density as
									// `--spacing` does.
									className="w-[7rem] font-mono text-xs"
								/>
							</label>
						</div>
						{/*
						 * Named, never clamped or ignored: an out-of-file number is a mistake about
						 * which row, and sending another is worse than none.
						 */}
						{typed.kind === "error" && <FieldError>{typed.message}</FieldError>}
						{/*
						 * The same refusal for a row nobody typed (a remembered index or repro
						 * target past the file as it reads now): said, not clamped, and the
						 * footer's button is dead while it stands.
						 */}
						{selectedMissing && (
							<FieldError>
								Row {(selected + 1).toLocaleString()} no longer exists - the file
								has {total.toLocaleString()} {pluralize(total, "row")}. Pick one
								below.
							</FieldError>
						)}

						<DialogBody className="rounded-md border border-rule">
							{visibleRows.length === 0 ? (
								/*
								 * An empty box would read as "the file has no rows", a different
								 * fact from "nothing matches", and only one is fixable here.
								 */
								<EmptyState
									variant="inline"
									compact
									title={`No rows match “${filter}”.`}
									action={
										<Button
											variant="link"
											size="sm"
											onClick={() => setFilter("")}
										>
											Clear the filter
										</Button>
									}
								/>
							) : (
								/*
								 * `role="grid"`, so rows can be `aria-selected` (meaningless on a
								 * plain table row). A roving tabindex keeps the grid one tab stop,
								 * not a thousand, the difference between a keyboard reaching the
								 * footer or not; always exactly one, as it falls back to the first
								 * rendered row (`focusable`). Arrow, Home, End and PageUp/PageDown
								 * move it and DOM focus together, per the WAI-ARIA grid pattern: a
								 * selection a screen reader never hears is not one.
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
												<TableCell className="w-12 text-right font-mono text-label text-muted-foreground">
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
											/*
											 * The sentinel the window grows on: a real row, so it
											 * lands inside the scroller its observer watches.
											 */
											<TableRow ref={sentinelRef} className="border-b-0">
												<TableCell
													colSpan={columns.length + 1}
													className="py-2 text-center text-label text-muted-foreground"
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
							<p className="mr-auto text-label text-muted-foreground">
								{/*
								 * Which rows are on screen and that scrolling brings the rest: the
								 * grid can clip without looking clipped under overlay scrollbars.
								 */}
								{filter.trim() !== ""
									? `${visibleRows.length.toLocaleString()} of ${total.toLocaleString()} ${pluralize(
											total,
											"row"
										)} match.`
									: hasMore
										? `Showing ${rendered.length.toLocaleString()} of ${total.toLocaleString()} rows - scroll for more.`
										: `All ${total.toLocaleString()} ${pluralize(total, "row")}.`}
							</p>
							<DialogCancelButton size="sm" onClick={() => onOpenChange(false)} />
							{/*
							 * Names the row it sends, so a row reached by number is confirmable;
							 * clicking a row still sends at once, the one-click loop this exists
							 * for. Disabled while that row is not in the file, so it never offers a
							 * row-less send; the line above the grid says which row and why.
							 */}
							<Button
								size="sm"
								disabled={selectedMissing}
								onClick={() => send(selected)}
							>
								Send row {(selected + 1).toLocaleString()}
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
