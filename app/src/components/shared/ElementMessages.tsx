/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What an inline script element said under load: its thrown error, each failing `pm.test`, and its
 * console lines (#3127). A load run keeps no per-request trace, so the tally row is the only place
 * this reaches. The engine keeps a bounded distinct sample: the first 10 of each list, each with
 * how often it was seen (`x3`, as under Test validation; no `count` is once), and a count of what a
 * full list turned away. The dropped count is said aloud ("37 more console line occurrences not
 * shown"), as Test validation says "Showing 10 of 14", or ten lines read as the set. Occurrences,
 * not entries: one error thrown on 480 iterations is 480, so the cue must not read as 480 messages.
 * All four keys are absent when empty and on older engines' rows, which render nothing.
 */

import { formatNumber } from "@/lib/format-number";
import { cn } from "@/lib/utils";
import { pluralize } from "@/modules/dashboard/utils/format";
import { LEVEL_TONE } from "./console-level";
import { LogGutter } from "./LogGutter";
import { OccurrenceCount } from "./OccurrenceCount";
import type { RunScenarioStepElementTally } from "@/types/domain";

type ElementMessagesSource = Pick<
	RunScenarioStepElementTally,
	"messages" | "messagesDropped" | "console" | "consoleDropped"
>;

/** One line: a reserved gutter naming what it is, the text, then how often it was seen. */
function Line({
	label,
	labelClassName,
	textClassName,
	count,
	children,
}: {
	label: string;
	labelClassName: string;
	textClassName: string;
	count: number | undefined;
	children: string;
}) {
	return (
		<li className="flex gap-2 py-px">
			<LogGutter label={label} labelClassName={labelClassName} />
			<pre className={cn("min-w-0 flex-1 whitespace-pre-wrap break-words", textClassName)}>
				{children}
			</pre>
			<OccurrenceCount count={count} />
		</li>
	);
}

function DroppedCue({ count, noun }: { count: number | undefined; noun: string }) {
	if (!count || count <= 0) return null;
	return (
		<li className="pt-1 text-micro text-muted-foreground tabular-nums">
			{formatNumber(count)} more {pluralize(count, noun)} not shown
		</li>
	);
}

export function ElementMessages({
	element,
	className,
}: {
	element: ElementMessagesSource;
	className?: string;
}) {
	const messages = element.messages ?? [];
	const consoleLines = element.console ?? [];
	// A dropped count is written only beside a full list, but a row is read as stored, so the cue
	// does not rely on that.
	const hasMessageCue = (element.messagesDropped ?? 0) > 0;
	const hasConsoleCue = (element.consoleDropped ?? 0) > 0;
	if (messages.length === 0 && consoleLines.length === 0 && !hasMessageCue && !hasConsoleCue) {
		return null;
	}

	return (
		<ul
			className={cn(
				"surface-sunken mt-1.5 rounded-md border border-rule p-2 font-mono text-xs",
				className
			)}
		>
			{messages.map((message, i) => (
				<Line
					key={`message-${i}`}
					label={message.kind}
					labelClassName="text-status-error-text"
					textClassName="text-status-error-text"
					count={message.count}
				>
					{message.text}
				</Line>
			))}
			<DroppedCue count={element.messagesDropped} noun="message occurrence" />
			{consoleLines.map((line, i) => {
				// A level the table does not know reads as a plain `log` line rather than throwing.
				const tone = LEVEL_TONE[line.level] ?? LEVEL_TONE.log;
				return (
					<Line
						key={`console-${i}`}
						label={tone.gutter}
						labelClassName={tone.label}
						textClassName={tone.text}
						count={line.count}
					>
						{line.text}
					</Line>
				);
			})}
			<DroppedCue count={element.consoleDropped} noun="console line occurrence" />
		</ul>
	);
}
