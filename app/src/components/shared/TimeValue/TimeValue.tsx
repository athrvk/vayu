/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { ComponentProps, ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
	describeInstant,
	formatInstant,
	parseTimeValue,
	type DescribeOptions,
	type TimeRow,
	type TimeStyle,
} from "@/lib/time-value";
import { TimeHoverCard } from "./TimeHoverCard";

type TimeInput = Date | number | string;

interface ResolvedTime {
	instant: Date;
	hasZone: boolean;
}

export interface TimeValueProps extends DescribeOptions {
	/** An instant (`Date`, epoch milliseconds) or the raw text an API sent. */
	value: TimeInput;
	/**
	 * The visible text: a `TimeStyle`, or `"raw"` to show a string exactly as it
	 * arrived (a header or a variable, where the machine value stays visible).
	 */
	style?: TimeStyle | "raw";
	className?: string;
	/** Surface facts that follow the time rows, such as the run a response came from. */
	extraRows?: TimeRow[];
}

/** The instant and the zone fact behind @p value, or null when it is no time. */
function resolve(value: TimeInput): ResolvedTime | null {
	if (typeof value !== "string") {
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? null : { instant: date, hasZone: true };
	}
	const parsed = parseTimeValue(value);
	if (parsed) return { instant: parsed.instant, hasZone: parsed.hasZone };
	// An engine timestamp that is not one of the machine forms still names an
	// instant; an unparseable string is simply shown.
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : { instant: date, hasZone: true };
}

/**
 * A component of its own so the rows are built when the tooltip opens, not on
 * every render of every list row that holds a time.
 */
function TimeCard({
	instant,
	original,
	options,
	extraRows,
}: {
	instant: Date;
	original: { text: string; hasZone: boolean } | undefined;
	options: DescribeOptions;
	extraRows: TimeRow[];
}) {
	return <TimeHoverCard rows={[...describeInstant(instant, options, original), ...extraRows]} />;
}

interface CardTooltipProps extends DescribeOptions {
	value: TimeInput;
	resolved: ResolvedTime;
	extraRows: TimeRow[];
	side?: ComponentProps<typeof TooltipContent>["side"];
	children: ReactElement;
}

function CardTooltip({
	value,
	resolved,
	extraRows,
	side,
	children,
	timeZone,
	locale,
	now,
}: CardTooltipProps) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>{children}</TooltipTrigger>
			<TooltipContent side={side}>
				<TimeCard
					instant={resolved.instant}
					original={
						typeof value === "string"
							? { text: value, hasZone: resolved.hasZone }
							: undefined
					}
					options={{ timeZone, locale, now }}
					extraRows={extraRows}
				/>
			</TooltipContent>
		</Tooltip>
	);
}

export interface TimeTooltipProps extends DescribeOptions {
	value: TimeInput;
	extraRows?: TimeRow[];
	side?: ComponentProps<typeof TooltipContent>["side"];
	/** The trigger: one element that takes a ref, as every `TooltipTrigger asChild` child must. */
	children: ReactElement;
}

/**
 * The time card on a trigger the surface draws itself, for a time that has no
 * visible text of its own to wrap: a history row whose time lives only in its
 * hover, a marker beside an editable field. A @p value that is not a time
 * leaves @p children bare.
 */
export function TimeTooltip({ value, extraRows = [], ...rest }: TimeTooltipProps) {
	const resolved = resolve(value);
	if (!resolved) return rest.children;
	return <CardTooltip value={value} resolved={resolved} extraRows={extraRows} {...rest} />;
}

/**
 * The one component that renders a time outside Monaco (issue #1786): visible
 * text the surface chooses, and the card - the user's zone, UTC, how long ago -
 * one hover away. A value that is not a time renders as plain text with no
 * card, so a surface can hand it whatever it holds.
 *
 * Nothing else under `app/src` may call `toLocale*String`, `formatInstant` or a
 * relative formatter on a display path (`time-surfaces.test.ts`).
 */
export function TimeValue({
	value,
	style = "datetime",
	className,
	extraRows = [],
	timeZone,
	locale,
	now,
}: TimeValueProps) {
	const options = { timeZone, locale, now };
	const resolved = resolve(value);
	const raw = typeof value === "string" ? value : undefined;
	if (!resolved) return <span className={className}>{raw ?? ""}</span>;
	const text =
		style === "raw" && raw !== undefined
			? raw
			: formatInstant(resolved.instant, style === "raw" ? "datetime" : style, options);
	return (
		<CardTooltip value={value} resolved={resolved} extraRows={extraRows} {...options}>
			<time
				dateTime={resolved.hasZone ? resolved.instant.toISOString() : undefined}
				className={cn("tabular-nums", className)}
			>
				{text}
			</time>
		</CardTooltip>
	);
}
