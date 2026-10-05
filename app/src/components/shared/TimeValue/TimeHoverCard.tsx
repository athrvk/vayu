/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { TooltipHint } from "@/components/ui/tooltip";
import type { TimeRow } from "@/lib/time-value";

/**
 * The body of the time card (issue #1786): a label column and a value column,
 * one row per `describeInstant` row. Content only - `TimeValue` puts it in a
 * `TooltipContent`, and the Monaco layer draws it over a token's rectangle, so
 * the two surfaces cannot drift apart on what a time looks like.
 *
 * Labels are `TooltipHint` because the card sits on the tooltip's fill, where
 * the canvas-tuned muted foreground disappears. The value column is
 * `tabular-nums` so the rows of one card, and the same row on two cards, line
 * up digit for digit.
 */
export function TimeHoverCard({ rows }: { rows: TimeRow[] }) {
	return (
		<dl
			data-testid="time-hover-card"
			className="grid grid-cols-[auto_1fr] items-baseline gap-x-2.5 gap-y-0 text-label"
		>
			{rows.map((row, index) => (
				<div key={`${index}-${row.label}`} className="contents">
					<dt>
						<TooltipHint>{row.label}</TooltipHint>
					</dt>
					<dd className="tabular-nums">{row.value}</dd>
				</div>
			))}
		</dl>
	);
}
