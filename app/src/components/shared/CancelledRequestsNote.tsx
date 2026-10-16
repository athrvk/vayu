/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * How many requests a Stop cancelled before they were answered (issue #2136).
 *
 * Those requests are in no other number on the page: not the total, not the
 * status-code distribution, not the error rate. Without a line of their own a
 * stopped run's request count silently falls short of what it sent. The line is
 * muted and never destructive, because a cancellation the user asked for is not
 * an error. Drawn by the history Overview, beside the error card.
 *
 * Silent for zero and for `undefined`, which is a report from an engine older
 * than the count: absent means none.
 */

import { pluralize } from "@/modules/dashboard/utils/format";
import { formatNumber } from "@/lib/format-number";
import { cn } from "@/lib/utils";

export function CancelledRequestsNote({
	count,
	className,
}: {
	count: number | undefined;
	className?: string;
}) {
	if (!count || count <= 0) return null;
	return (
		<p className={cn("text-sm text-muted-foreground", className)}>
			{formatNumber(count)} {pluralize(count, "request")} cancelled by Stop
		</p>
	);
}
