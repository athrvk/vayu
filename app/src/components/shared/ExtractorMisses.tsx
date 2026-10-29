/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A step's extractor misses (issue #3053): "2 extractor misses", shown by a
 * collection run's step card and a scenario load run's Steps tab, so both run
 * kinds word the count alike.
 *
 * A miss unsets the extractor's variable, so a later step sends that
 * `{{name}}` unresolved while the step that missed can still pass. The engine
 * omits the count at 0 and a report stored before it has none, so nothing
 * renders for either.
 *
 * Text, not a `Badge`: it paints no background, the rule
 * `badge-hover.test.tsx` keeps for the ones that do.
 */

import { AlertTriangle } from "lucide-react";
import { formatNumber } from "@/lib/format-number";
import { cn } from "@/lib/utils";
import { pluralize } from "@/modules/dashboard/utils/format";

export interface ExtractorMissesProps {
	/** `extractorMisses` from the stored trace, the `step` frame or the report. */
	count: number | undefined;
	className?: string;
}

export function ExtractorMisses({ count, className }: ExtractorMissesProps) {
	if (typeof count !== "number" || !(count > 0)) return null;
	return (
		<span
			className={cn("flex items-center gap-1.5 text-xs text-status-warning-text", className)}
			title="An extractor found nothing and unset its variable, so a later step sends that name unresolved."
		>
			<AlertTriangle aria-hidden="true" className="size-icon-sm" />
			<span className="tabular-nums">
				{formatNumber(count)} extractor {pluralize(count, "miss", "misses")}
			</span>
		</span>
	);
}
