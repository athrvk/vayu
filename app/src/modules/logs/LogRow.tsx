/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One line of the Logs table (#3635): the columns a record has, then its other
 * fields as `key=value` (`electron/log.ts`'s text rendering), and the whole record
 * as formatted JSON when the row is opened. A line that is not a record is shown
 * raw with a marker in the component column.
 *
 * A button rather than table cells: the row's one action is to open it, and a
 * button spanning cells would not be a table row to a screen reader. The header
 * above the list is for the eye (`aria-hidden`) and the row's own text carries
 * each value.
 */

import { memo } from "react";
import { Copy } from "lucide-react";
import { TimeValue } from "@/components/shared/TimeValue";
import { LEVEL_TONE } from "@/components/shared/console-level";
import { TruncatedText } from "@/components/shared/TruncatedText";
import { LogGutter } from "@/components/shared/LogGutter";
import { Button } from "@/components/ui";
import { useCopy } from "@/hooks/useCopy";
import { cn } from "@/lib/utils";
import type { LogEntry, LogFileRecord } from "@/types/electron";
import { entryLine, fieldsText, isUnparsedEntry } from "./log-entry";
import { LOG_COLUMNS } from "./log-columns";

/** The marker a line that is not a record carries where a record's component would be. */
const UNPARSED_MARKER = "unparsed";

function RecordCells({ entry }: { entry: LogFileRecord }) {
	const tone = LEVEL_TONE[entry.level];
	const fields = fieldsText(entry);
	return (
		<>
			<TimeValue
				value={entry.ts}
				style="time-ms"
				className={cn(LOG_COLUMNS.time, "text-muted-foreground")}
			/>
			<LogGutter label={tone.gutter} labelClassName={tone.label} />
			<TruncatedText className={cn(LOG_COLUMNS.source, "text-muted-foreground")}>
				{entry.src}
			</TruncatedText>
			<TruncatedText className={cn(LOG_COLUMNS.component, "text-muted-foreground")}>
				{entry.cat}
			</TruncatedText>
			<TruncatedText className={cn(LOG_COLUMNS.message, tone.text)}>
				{entry.msg}
			</TruncatedText>
			<TruncatedText className={cn(LOG_COLUMNS.fields, "text-muted-foreground")}>
				{fields}
			</TruncatedText>
		</>
	);
}

function UnparsedCells({ raw }: { raw: string }) {
	return (
		<>
			<span className={LOG_COLUMNS.time} />
			<LogGutter label="" labelClassName="" />
			<span className={LOG_COLUMNS.source} />
			<span className={cn(LOG_COLUMNS.component, "italic text-muted-foreground")}>
				{UNPARSED_MARKER}
			</span>
			<TruncatedText className="min-w-0 flex-1">{raw}</TruncatedText>
		</>
	);
}

function RowDetail({ entry }: { entry: LogEntry }) {
	const { copy } = useCopy();
	const unparsed = isUnparsedEntry(entry);
	return (
		<div className="px-3 pb-2 pt-1">
			<Button
				type="button"
				variant="outline"
				size="sm"
				className="mb-1 gap-1.5"
				onClick={() => void copy(entryLine(entry), "Line")}
			>
				<Copy className="size-icon-sm" aria-hidden="true" />
				Copy line
			</Button>
			<pre className="surface-sunken max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-rule p-2 font-mono text-xs">
				{unparsed ? entry.raw : JSON.stringify(entry, null, 2)}
			</pre>
		</div>
	);
}

interface LogRowProps {
	entry: LogEntry;
	expanded: boolean;
	onToggle: (entry: LogEntry) => void;
}

export const LogRow = memo(function LogRow({ entry, expanded, onToggle }: LogRowProps) {
	const cells = isUnparsedEntry(entry) ? (
		<UnparsedCells raw={entry.raw} />
	) : (
		<RecordCells entry={entry} />
	);
	return (
		<li className="skip-offscreen">
			<button
				type="button"
				aria-expanded={expanded}
				onClick={() => onToggle(entry)}
				className="flex w-full items-baseline gap-2 px-3 py-px text-left font-mono text-xs leading-5 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
			>
				{cells}
			</button>
			{expanded && <RowDetail entry={entry} />}
		</li>
	);
});
