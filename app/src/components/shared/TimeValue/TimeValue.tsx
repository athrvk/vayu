/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
	describeInstant,
	formatInstant,
	parseTimeValue,
	type DescribeOptions,
	type TimeStyle,
} from "@/lib/time-value";
import { TimeHoverCard } from "./TimeHoverCard";

export interface TimeValueProps extends DescribeOptions {
	/** An instant (`Date`, epoch milliseconds) or the raw text an API sent. */
	value: Date | number | string;
	/**
	 * The visible text: a `TimeStyle`, or `"raw"` to show a string exactly as it
	 * arrived (a header or a variable, where the machine value stays visible).
	 */
	style?: TimeStyle | "raw";
	className?: string;
}

/** The instant and the zone fact behind @p value, or null when it is no time. */
function resolve(value: TimeValueProps["value"]) {
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
	const rows = describeInstant(
		resolved.instant,
		options,
		raw === undefined ? undefined : { text: raw, hasZone: resolved.hasZone }
	);
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<time
					dateTime={resolved.hasZone ? resolved.instant.toISOString() : undefined}
					className={cn("tabular-nums", className)}
				>
					{text}
				</time>
			</TooltipTrigger>
			<TooltipContent>
				<TimeHoverCard rows={rows} />
			</TooltipContent>
		</Tooltip>
	);
}
