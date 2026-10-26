/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The pieces of a scenario load run's step table that History's Steps tab
 * (`ScenarioStepsTab`, the finished report) and the live dashboard's sequence
 * panel (`LiveSequencePanel`, the gate frame's counters) both draw (#2823), so
 * a step reads the same in the run and after it.
 */

import { AlertTriangle } from "lucide-react";
import { TableCell, TableHead, Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui";
import { formatNumber } from "@/lib/format-number";
import { pluralize } from "@/modules/dashboard/utils/format";
import { MethodBadge } from "./MethodBadge";
import { TruncatedText } from "./TruncatedText";

/** A step's row header: its position, its method where it has one, and its name. */
export function StepLabelCell({
	index,
	method,
	name,
}: {
	index: number;
	/** Absent live, where a frame names the step and not its request. */
	method?: string;
	name: string;
}) {
	return (
		<TableHead scope="row" className="font-normal text-foreground">
			<div className="flex items-center gap-2 min-w-0">
				<span className="text-xs text-muted-foreground font-mono shrink-0">
					{index + 1}
				</span>
				{method && <MethodBadge method={method} />}
				<TruncatedText className="text-foreground min-w-0">{name}</TruncatedText>
			</div>
		</TableHead>
	);
}

/**
 * How often the step ran. With `expectedPerStep` (the count every step would
 * show were each iteration to reach it) a step below it carries a "(n short)"
 * marker: the visible shape of an earlier step erroring out. A live caller
 * passes none, since a step in flight is always behind the one before it.
 */
export function ExecutedCell({
	executed,
	expectedPerStep,
}: {
	executed: number;
	expectedPerStep?: number;
}) {
	const short = expectedPerStep === undefined ? 0 : expectedPerStep - executed;
	return (
		<TableCell className="text-right font-mono">
			{formatNumber(executed)}
			{short > 0 && (
				<span
					className="ml-1 text-xs text-muted-foreground"
					title={`${formatNumber(short)} iterations ended before reaching this step`}
				>
					({formatNumber(short)} short)
				</span>
			)}
		</TableCell>
	);
}

/**
 * The Errors tally, with its split on hover. `httpErrors` and `noResponse` are
 * absent from a report stored before the engine reported them, and from a live
 * frame; a tally with no split is shown as the bare count rather than as a
 * split of zeros.
 */
function ErrorsCount({
	errors,
	httpErrors,
	noResponse,
}: {
	errors: number;
	httpErrors?: number;
	noResponse?: number;
}) {
	const count = <span>{formatNumber(errors)}</span>;
	if (errors === 0 || httpErrors === undefined || noResponse === undefined) return count;
	return (
		<Tooltip>
			<TooltipTrigger asChild>{count}</TooltipTrigger>
			<TooltipContent>
				{formatNumber(httpErrors)} {pluralize(httpErrors, "HTTP error")},{" "}
				{formatNumber(noResponse)} no response
			</TooltipContent>
		</Tooltip>
	);
}

/** The Errors cell: red when the step has any, muted at zero. */
export function ErrorsCell(props: { errors: number; httpErrors?: number; noResponse?: number }) {
	return (
		<TableCell
			className={
				props.errors > 0
					? "text-right font-mono text-status-error-text"
					: "text-right font-mono text-muted-foreground"
			}
		>
			<ErrorsCount {...props} />
		</TableCell>
	);
}

/**
 * The line above a step table: what the sequence has done so far. Each count is
 * drawn when its caller has one; abandoned only when non-zero, since a run that
 * lost nothing should not be made to display a zero next to a word like
 * "abandoned".
 */
export function ScenarioFacts({
	virtualUsers,
	iterationsStarted,
	iterationsCompleted,
	iterationsAbandoned,
}: {
	virtualUsers?: number;
	iterationsStarted?: number;
	iterationsCompleted?: number;
	iterationsAbandoned?: number;
}) {
	return (
		<div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm p-3 border rounded-md bg-background/50">
			{virtualUsers !== undefined && <Fact label="Virtual users" value={virtualUsers} />}
			{iterationsStarted !== undefined && (
				<Fact label="Iterations started" value={iterationsStarted} />
			)}
			{iterationsCompleted !== undefined && (
				<Fact label="Iterations completed" value={iterationsCompleted} />
			)}
			{!!iterationsAbandoned && (
				<Fact label="Iterations abandoned" value={iterationsAbandoned} warn />
			)}
		</div>
	);
}

function Fact({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
	return (
		<div className="flex items-center gap-2">
			{warn && <AlertTriangle className="size-icon shrink-0 text-status-warning-text" />}
			<span className="text-muted-foreground">{label}:</span>
			<span className="text-foreground font-mono">{formatNumber(value)}</span>
		</div>
	);
}
