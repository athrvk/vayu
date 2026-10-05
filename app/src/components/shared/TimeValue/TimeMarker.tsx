/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { parseTimeValue, type DescribeOptions } from "@/lib/time-value";
import { TimeTooltip } from "./TimeValue";

export interface TimeMarkerProps extends DescribeOptions {
	/** What the field holds right now, as typed. */
	value: string;
	/** The field's name, for the button's accessible name. */
	label: string;
	className?: string;
}

/**
 * The time card beside an editable field (issue #1786): a header value such as
 * `If-Modified-Since`, a param, a variable. The text sits in an `<input>`, which
 * cannot hold a `TimeValue`, and a tooltip on the field itself would open on
 * every focus and cover the autocomplete while the user types. So the card
 * hangs off a marker of its own, the same reasoning `KeyValueRow`'s resolved
 * peek follows: a separate target, reachable by keyboard, that never fires
 * underneath the field's own `{{token}}` tooltips.
 *
 * Decided by `parseTimeValue` alone, never `new Date()`: a field holding `1` or
 * `2026` is not a time. Renders nothing for a value that is not one.
 */
export function TimeMarker({ value, label, className, ...options }: TimeMarkerProps) {
	if (!parseTimeValue(value)) return null;
	return (
		<TimeTooltip value={value} {...options}>
			<Button
				type="button"
				variant="ghost"
				size="icon"
				aria-label={`${label} in your time zone and UTC`}
				className={cn("text-subtle-foreground hover:text-primary-text", className)}
			>
				<Clock className="size-icon-sm" />
			</Button>
		</TimeTooltip>
	);
}
