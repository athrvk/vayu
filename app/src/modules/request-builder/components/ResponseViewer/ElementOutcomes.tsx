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
 * one icon per outcome rather than a pass/fail split, and the message (an
 * assertion's failure text, an extractor's miss reason) on hover so the row
 * stays one line.
 */

import { AlertTriangle, CheckCircle, CircleSlash, HelpCircle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ElementOutcome } from "@/types";

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
			<h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
				Elements
			</h3>
			<div className="space-y-1.5">
				{outcomes.map((outcome, i) => {
					const Icon = OUTCOME_ICON[outcome.outcome] ?? AlertTriangle;
					return (
						<div
							key={`${outcome.id}-${i}`}
							className={cn("p-2.5 rounded-md border", OUTCOME_CARD_CLASS[outcome.outcome])}
							title={outcome.message}
						>
							<div className="flex items-center gap-2">
								<Icon
									className={cn(
										"w-3.5 h-3.5 shrink-0",
										OUTCOME_TEXT_CLASS[outcome.outcome]
									)}
								/>
								<span
									className={cn(
										"text-xs font-medium",
										OUTCOME_TEXT_CLASS[outcome.outcome]
									)}
								>
									{outcome.kind}
								</span>
								<span className="text-[10px] text-muted-foreground">
									{outcome.outcome}
								</span>
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}
