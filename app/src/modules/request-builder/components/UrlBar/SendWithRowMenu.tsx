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
 * The rows are read when this opens and are never persisted, held only for as
 * long as the popover and the send that follows it (see `data-file-store`).
 */

import { useState } from "react";
import { ChevronDown } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui";
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
	 * Held by the caller - the builder, per request, in plain state - so
	 * iterating on a script is one click rather than a hunt through the list
	 * each time. Deliberately not persisted: it points into a file whose rows
	 * are not, and a remembered index against a file that has since changed
	 * would name a different row.
	 */
	lastRowIndex: number | null;
	onRowIndexChange: (index: number) => void;
}

/** Enough rows to pick from without turning a popover into the file. */
const PICKER_ROWS = 20;

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
}: SendWithRowMenuProps) {
	const [open, setOpen] = useState(false);

	const parsed = rows.parsed;
	const shown = parsed?.rows.slice(0, PICKER_ROWS) ?? [];
	const hidden = (parsed?.rows.length ?? 0) - shown.length;

	const send = (index: number) => {
		if (!parsed) return;
		onRowIndexChange(index);
		setOpen(false);
		onSend(parsed.rows[index]);
	};

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				// Read on open, not on mount: a request tab must not touch the
				// filesystem for a send nobody asked for.
				if (next) rows.load();
			}}
		>
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
					<div className="max-h-72 overflow-auto">
						{shown.map((row, index) => (
							<button
								key={index}
								type="button"
								onClick={() => send(index)}
								className={cn(
									"flex w-full items-baseline gap-2 px-3 py-1.5 text-left",
									"text-xs hover:bg-accent transition-colors",
									index === lastRowIndex && "bg-accent/60"
								)}
							>
								<span className="w-6 shrink-0 font-mono text-[11px] text-muted-foreground">
									{index + 1}
								</span>
								<span className="min-w-0 flex-1 truncate font-mono">
									{parsed.columns
										.map((column) => `${column}=${cellText(row[column])}`)
										.join("  ")}
								</span>
							</button>
						))}
						{hidden > 0 && (
							<p className="px-3 py-2 text-[11px] text-muted-foreground">
								{hidden} more {hidden === 1 ? "row is" : "rows are"} in the file.
								Run the collection to send them all.
							</p>
						)}
					</div>
				)}
			</PopoverContent>
		</Popover>
	);
}
