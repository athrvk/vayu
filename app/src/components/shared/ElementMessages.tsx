/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What an inline script element said under load: the error it threw, each
 * failing `pm.test`, and its console lines (#3127). A load run keeps no trace
 * per request, so the tally row is the only place this text can reach.
 *
 * The engine keeps a bounded, distinct sample: the first 10 entries of each
 * list, with a count of what a full list turned away. The count is said out
 * loud ("37 more console line occurrences not shown") for the reason the failure
 * list under Test validation says "Showing 10 of 14": ten lines read as the
 * whole set unless they say otherwise. The count is occurrences, not distinct
 * entries: one extra error thrown on 480 iterations is 480, so the cue must not
 * read as 480 more messages. All four keys are absent when empty, and on a
 * row from an engine before the field, so a row with none renders nothing.
 */

import { formatNumber } from "@/lib/format-number";
import { cn } from "@/lib/utils";
import { pluralize } from "@/modules/dashboard/utils/format";
import { LEVEL_TONE } from "./console-level";
import { LogGutter } from "./LogGutter";
import type { RunScenarioStepElementTally } from "@/types/domain";

type ElementMessagesSource = Pick<
	RunScenarioStepElementTally,
	"messages" | "messagesDropped" | "console" | "consoleDropped"
>;

/** One line: a reserved gutter naming what it is, then the text. */
function Line({
	label,
	labelClassName,
	textClassName,
	children,
}: {
	label: string;
	labelClassName: string;
	textClassName: string;
	children: string;
}) {
	return (
		<li className="flex gap-2 py-px">
			<LogGutter label={label} labelClassName={labelClassName} />
			<pre className={cn("min-w-0 flex-1 whitespace-pre-wrap break-words", textClassName)}>
				{children}
			</pre>
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
	// A dropped count is only ever written beside a list that filled, but a row
	// is read as stored, so the cue does not depend on that.
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
					>
						{line.text}
					</Line>
				);
			})}
			<DroppedCue count={element.consoleDropped} noun="console line occurrence" />
		</ul>
	);
}
