/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A step's unresolved `{{variables}}` (#3269), beside its {@link ExtractorMisses}: a miss unsets a
 * variable, and this is the later step sending that name as text; the step can still pass. The
 * engine counts two things under one field, so the caller says which:
 * - `"names"` - a sequential collection run's step: the distinct `{{names}}` it sent unresolved.
 *   Absent, never 0, when none.
 * - `"sends"` - a scenario load run's step: the executions that sent one. Always present, so 0 is a
 *   real "none".
 *
 * Nothing renders for an absent, zero or non-numeric count. Text, not a `Badge`: it paints no
 * background, the rule `badge-hover.test.tsx` keeps for those that do.
 */

import { AlertTriangle } from "lucide-react";
import { formatNumber } from "@/lib/format-number";
import { cn } from "@/lib/utils";
import { pluralize } from "@/modules/dashboard/utils/format";

export interface UnresolvedTokensProps {
	/** `unresolvedTokens` from the stored trace, the `step` frame or the report. */
	count: number | undefined;
	/** What `count` counts: distinct names (a collection run) or sends (a load run). */
	unit: "names" | "sends";
	className?: string;
}

function wording(count: number, unit: UnresolvedTokensProps["unit"]): string {
	const n = formatNumber(count);
	return unit === "names"
		? `${n} unresolved ${pluralize(count, "variable")}`
		: `${n} ${pluralize(count, "send")} with unresolved variables`;
}

export function UnresolvedTokens({ count, unit, className }: UnresolvedTokensProps) {
	if (typeof count !== "number" || !(count > 0)) return null;
	return (
		<span
			className={cn("flex items-center gap-1.5 text-xs text-status-warning-text", className)}
		>
			<AlertTriangle aria-hidden="true" className="size-icon-sm" />
			<span className="tabular-nums">{wording(count, unit)}</span>
		</span>
	);
}
