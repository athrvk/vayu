/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * How many requests a Stop cancelled before they were answered (#2136). They are in no other number
 * on the page (the total, the status distribution, the error rate), so without this line a stopped
 * run's count falls silently short of what it sent. Muted, never destructive: a cancellation the
 * user asked for is not an error. Drawn by the history Overview beside the error card. Silent for
 * zero and `undefined` (an engine older than the count): absent means none.
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
