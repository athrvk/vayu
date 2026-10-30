/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ElementOutcomes (issue #1512)
 *
 * What each of a step's non-script elements did - extractors, assertions and
 * timers - beside `TestResults`, which stays the script kinds' `pm.test`
 * outcomes in their own unchanged shape. Same card layout as `TestResults`,
 * one icon per outcome rather than a pass/fail split. A row's message - an
 * assertion's failure text, an extractor's miss reason, the error an element
 * raised, a `control.transaction`'s name - prints inline, and so does a timer's
 * wait (`waitedMs`, which is 0 for a silenced timer and still worth saying)
 * (#1941). The message was on hover only for a failure, which left an errored
 * element as a bare chip with its one explanation hidden (#2522); it wraps in
 * full, since a miss reason ("no match for '$.data.token'") is what tells two
 * rows of one kind apart (#3051), and the card's `title` repeats it. A row names
 * its element - `name` when it has one, the kind beside it - and a collection's
 * element says which collection it came from. A required extractor's `missing`
 * failed the step, so it takes the failure's colours and says it was required.
 */

import { AlertTriangle, CheckCircle, CircleSlash, HelpCircle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatLatency } from "@/lib/format-number";
import type { ElementOutcome } from "@/types";
import { EYEBROW_XS_CLASS } from "@/components/ui/eyebrow";
import { elementOriginLabel, REQUIRED_MISS_HINT } from "@/components/shared";

export interface ElementOutcomesProps {
	outcomes: readonly ElementOutcome[];
	/** See {@link TestResultsProps.inset} - same convention, same reason. */
	inset?: boolean;
}

const OUTCOME_ICON: Record<ElementOutcome["outcome"], typeof CheckCircle> = {
	ok: CheckCircle,
	failed: XCircle,
	error: XCircle,
	missing: HelpCircle,
	skipped: CircleSlash,
};

const OUTCOME_TEXT_CLASS: Record<ElementOutcome["outcome"], string> = {
	ok: "text-status-success-text",
	failed: "text-status-error-text",
	error: "text-status-error-text",
	missing: "text-status-warning-text",
	skipped: "text-muted-foreground",
};

const OUTCOME_CARD_CLASS: Record<ElementOutcome["outcome"], string> = {
	ok: "bg-status-success/10 border-status-success/20",
	failed: "bg-status-error/10 border-status-error/20",
	error: "bg-status-error/10 border-status-error/20",
	missing: "bg-status-warning/10 border-status-warning/20",
	skipped: "bg-muted/50 border-border",
};

export default function ElementOutcomes({ outcomes, inset = true }: ElementOutcomesProps) {
	if (outcomes.length === 0) return null;

	return (
		<div className={inset ? "p-4 overflow-auto h-full" : undefined}>
			<h3 className={cn(EYEBROW_XS_CLASS, "mb-1.5")}>Elements</h3>
			<div className="space-y-1.5">
				{outcomes.map((outcome, i) => {
					// A required miss failed the step, so it is painted as a failure.
					const requiredMiss = outcome.outcome === "missing" && outcome.required === true;
					const tone = requiredMiss ? "failed" : outcome.outcome;
					const Icon = OUTCOME_ICON[tone] ?? AlertTriangle;
					const origin = elementOriginLabel(outcome.origin);
					return (
						<div
							key={`${outcome.id}-${i}`}
							className={cn("p-2.5 rounded-md border", OUTCOME_CARD_CLASS[tone])}
							title={outcome.message}
						>
							<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
								<Icon
									className={cn(
										"size-icon-sm shrink-0",
										OUTCOME_TEXT_CLASS[tone]
									)}
								/>
								<span
									className={cn("text-xs font-medium", OUTCOME_TEXT_CLASS[tone])}
								>
									{outcome.name ?? outcome.kind}
								</span>
								{outcome.name && (
									<span className="text-micro font-mono text-muted-foreground">
										{outcome.kind}
									</span>
								)}
								{origin && (
									<span className="text-micro text-muted-foreground">
										{origin}
									</span>
								)}
								<span
									className={cn(
										"text-micro",
										requiredMiss
											? OUTCOME_TEXT_CLASS[tone]
											: "text-muted-foreground"
									)}
									title={requiredMiss ? REQUIRED_MISS_HINT : undefined}
								>
									{requiredMiss
										? `${outcome.outcome} (required)`
										: outcome.outcome}
								</span>
								{outcome.message && (
									<span className="min-w-0 break-words text-micro text-foreground">
										{outcome.message}
									</span>
								)}
								{outcome.waitedMs !== undefined && (
									<span className="shrink-0 text-micro text-muted-foreground tabular-nums">
										· {formatLatency(outcome.waitedMs)}
									</span>
								)}
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}
