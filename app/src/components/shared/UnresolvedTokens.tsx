/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A step's unresolved `{{variables}}` (issue #3269), shown beside its
 * {@link ExtractorMisses}: an extractor miss unsets a variable, and this is the
 * later step that sent that name as literal text. The step can still pass.
 *
 * The engine counts two different things under the one field name, so the
 * caller says which:
 * - `"names"` - a sequential collection run's step: the distinct `{{names}}`
 *   that step sent unresolved. Absent, never 0, when none.
 * - `"sends"` - a scenario load run's step: the executions of the step that sent
 *   one. Always present, so 0 is a real "none".
 * Either way nothing renders for an absent, zero or non-numeric count.
 *
 * Text, not a `Badge`: it paints no background, the rule
 * `badge-hover.test.tsx` keeps for the ones that do.
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
