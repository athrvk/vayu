/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which operations of the collection's bound contract a run exercised, and which
 * of their declared responses it saw (issue #629).
 *
 * The other half of "did this run prove anything": `ThresholdVerdict` beside it
 * says whether the run met its budgets, and this says whether it touched the
 * contract at all. A run can pass every budget and every assertion while never
 * calling four of eighteen operations, and nothing before this could say so.
 *
 * Two surfaces show it - the history detail's Overview and a scenario run's own
 * view - so it lives here once rather than being written twice and drifting,
 * exactly as `ThresholdVerdict` and `CapacitySummary` do.
 *
 * **Silent when the run was not measured against a contract.** An absent block
 * says "not measured", which is a different claim from "measured and covered
 * nothing", and it is why a run of an unbound collection renders exactly as it
 * did before coverage existed. The engine spells that as an absent `coverage`,
 * never an empty one.
 *
 * Rows arrive uncovered-first from the engine and are rendered in that order:
 * an operation nothing exercised is the finding the block is opened for, and
 * re-sorting here would be a second opinion about which those are.
 */

import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { cn } from "@/lib/utils";
import { httpStatusClass, STATUS_CLASS_STYLE } from "@/constants/http-status";
import type { RunCoverage, RunCoverageOperation } from "@/types/domain";

export interface ContractCoverageProps {
	coverage: RunCoverage | undefined;
	/**
	 * `metadata.openapi.inherited` - the contract belongs to an ancestor of the
	 * collection that ran (issue #716).
	 *
	 * The numbers are unchanged by it; what changes is how they read. Running one
	 * tag sub-collection of an imported spec is measured against the whole
	 * document, so "4 / 618 operations" is the honest answer for a scoped run and
	 * a catastrophe for a whole-collection one, and nothing else on this card
	 * tells them apart.
	 */
	inheritedBinding?: boolean;
	className?: string;
}

/** A percentage with no trailing noise on the two values that matter most. */
function formatPct(value: number): string {
	if (!Number.isFinite(value)) return "0%";
	return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

export function ContractCoverage({ coverage, inheritedBinding, className }: ContractCoverageProps) {
	if (!coverage || coverage.operations.length === 0) return null;

	const uncovered = coverage.operationsTotal - coverage.operationsCovered;
	const complete = uncovered === 0 && coverage.undeclaredStatusesSeen === 0;

	return (
		<Card className={className}>
			<CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
				<CardTitle className="text-base">Contract coverage</CardTitle>
				{/*
				 * `Badge variant="chip"` for the reason `ThresholdVerdict` states
				 * at its own chip: it is the one variant that lets a caller own
				 * the background without inheriting a `hover:bg-*` that
				 * tailwind-merge will not replace, and it is what supplies the
				 * radius. Text on a tint, never the bare `--status-*` fill as a
				 * foreground.
				 *
				 * Neutral rather than red when something is uncovered: an
				 * unexercised operation is a gap in the run, not a failure of the
				 * system under test, and painting it destructive would put it in
				 * the same vocabulary as a failed budget.
				 */}
				<Badge
					variant="chip"
					className={cn(
						"font-medium",
						complete
							? "bg-status-success/10 text-status-success-text"
							: "bg-status-warning/10 text-status-warning-text"
					)}
				>
					{coverage.operationsCovered} / {coverage.operationsTotal} operations
				</Badge>
			</CardHeader>
			<CardContent>
				<p className="mb-3 text-xs text-muted-foreground">
					{coverage.declaredResponsesHit} of {coverage.declaredResponsesTotal} declared
					responses seen ({formatPct(coverage.declaredResponseCoveragePct)}).
					{coverage.undeclaredStatusesSeen > 0 &&
						` ${coverage.undeclaredStatusesSeen} undeclared status${
							coverage.undeclaredStatusesSeen === 1 ? "" : "es"
						} observed.`}
					{coverage.undeclaredOperationRequests !== undefined &&
						` ${coverage.undeclaredOperationRequests} request${
							coverage.undeclaredOperationRequests === 1 ? "" : "s"
						} went to operations this document does not declare.`}
				</p>
				{/*
				 * Every number above and below is exact. Said here rather than
				 * left to the docs because the block sits among sampled figures -
				 * the latency percentiles and the stored samples are a reservoir
				 * under load - and a reader has no way to know which kind these
				 * are (docs/app/openapi.md, "What is exact and what is sampled").
				 */}
				<p className="mb-3 text-[11px] text-muted-foreground">
					Counted on every send, not from the stored sample.
					{/*
					 * Beside "what these numbers are" rather than raised as a
					 * warning: running one tag folder of an imported spec is an
					 * ordinary thing to do, and the operations it leaves uncovered
					 * are the truth about the contract rather than a fault to flag
					 * (issue #716).
					 */}
					{inheritedBinding &&
						" The contract is bound on a parent collection, so its operations outside this one count as uncovered."}
				</p>
				<ul className="space-y-1.5">
					{coverage.operations.map((operation) => (
						<CoverageRow
							key={`${operation.method} ${operation.path}`}
							operation={operation}
						/>
					))}
				</ul>
			</CardContent>
		</Card>
	);
}

function CoverageRow({ operation }: { operation: RunCoverageOperation }) {
	const covered = operation.sent > 0;

	return (
		<li className="flex items-baseline justify-between gap-3 text-sm">
			<span className={cn("truncate", covered ? "" : "text-muted-foreground")}>
				<span className="font-mono text-xs font-medium">{operation.method}</span>{" "}
				<span className="font-mono text-xs">{operation.path}</span>
				{operation.declaredMissed.length > 0 && (
					<span className="ml-1.5 text-xs text-muted-foreground">
						({operation.declaredMissed.join(", ")} not seen)
					</span>
				)}
			</span>
			<span className="flex shrink-0 items-baseline gap-1.5">
				{!covered && <span className="text-xs text-muted-foreground">never called</span>}
				{operation.statusesSeen.map((status) => (
					<span
						key={status}
						className={cn(
							"font-mono text-xs",
							STATUS_CLASS_STYLE[httpStatusClass(status)].text
						)}
					>
						{status}
					</span>
				))}
				{operation.transportErrors !== undefined && (
					<span className="text-xs text-destructive-text">
						{operation.transportErrors} failed
					</span>
				)}
			</span>
		</li>
	);
}
