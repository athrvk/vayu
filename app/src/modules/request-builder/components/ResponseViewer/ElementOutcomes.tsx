/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What each of a step's non-script elements did (extractors, assertions, timers) (#1512), beside
 * `TestResults`, which keeps the script kinds' `pm.test` outcomes. `TestResults`' card layout, one
 * icon per outcome. A row's message (an assertion's failure, an extractor's miss reason, an
 * element's error, a `control.transaction`'s name) prints inline, as does a timer's wait
 * (`waitedMs`, 0 for a silenced timer and still worth saying, #1941). It wraps in full, since a
 * miss reason ("no match for '$.data.token'") is what tells two rows of a kind apart (#3051); the
 * card's `title` repeats it, and an errored element is never a bare chip (#2522). A row names its
 * element (`name` if any, the kind beside it), and a collection's element names its collection. A
 * required extractor's `missing` failed the step, so it takes failure colours and says required.
 *
 * `notRun` is the incomplete draft elements Send left out (#3066), after the outcomes in
 * `skipped`'s muted colours but worded "Not run - needs ...": the engine never saw them, and
 * reading as engine-skipped would hide that the check was never asked to run.
 */

import {
	AlertTriangle,
	CheckCircle,
	CircleDashed,
	CircleSlash,
	HelpCircle,
	XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatLatency } from "@/lib/format-number";
import { notRunReason, type LeftOutElement } from "@/lib/elements";
import type { ElementOutcome } from "@/types";
import { EYEBROW_XS_CLASS } from "@/components/ui/eyebrow";
import { Heading } from "@/components/ui/heading";
import { elementOriginLabel, REQUIRED_MISS_HINT } from "@/components/shared";

export interface ElementOutcomesProps {
	outcomes: readonly ElementOutcome[];
	/** Incomplete draft elements Send left out of the payload (#3066). */
	notRun?: readonly LeftOutElement[];
	/** See {@link TestResultsProps.inset}: same convention, same reason. */
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

function NotRunRow({ element, needs }: LeftOutElement) {
	const reason = notRunReason(needs);
	return (
		<div className="p-2.5 rounded-md border bg-muted/50 border-border" title={reason}>
			<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
				<CircleDashed className="size-icon-sm shrink-0 text-muted-foreground" />
				<span className="text-xs font-medium text-muted-foreground">
					{element.name ?? element.kind}
				</span>
				{element.name && (
					<span className="text-micro font-mono text-muted-foreground">
						{element.kind}
					</span>
				)}
				<span className="min-w-0 break-words text-micro text-foreground">{reason}</span>
			</div>
		</div>
	);
}

export default function ElementOutcomes({
	outcomes,
	notRun = [],
	inset = true,
}: ElementOutcomesProps) {
	if (outcomes.length === 0 && notRun.length === 0) return null;

	return (
		<div className={inset ? "p-4 overflow-auto h-full" : undefined}>
			{/* The level is the host's: the response pane, a run's step in History. */}
			<Heading outside="h3" className={cn(EYEBROW_XS_CLASS, "mb-1.5")}>
				Elements
			</Heading>
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
				{notRun.map((left) => (
					<NotRunRow key={`not-run-${left.element.id}`} {...left} />
				))}
			</div>
		</div>
	);
}
