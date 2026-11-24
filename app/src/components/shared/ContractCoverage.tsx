/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which operations of the collection's bound contract a run exercised, and which of their declared
 * responses it saw (#629): the other half of "did this run prove anything" beside
 * `ThresholdVerdict`. A run can pass every budget and assertion while never calling four of
 * eighteen operations. Shared, as the history Overview and a scenario run's view show it (like
 * `ThresholdVerdict` and `CapacitySummary`). **Silent when not measured against a contract**:
 * absent says "not measured", another claim from "covered nothing", and the engine spells it as an
 * absent `coverage`, never an empty one. Rows arrive uncovered-first and are drawn so: an
 * unexercised operation is the finding, and re-sorting would be a second opinion.
 */

import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { formatFixed } from "@/lib/format-number";
import { cn } from "@/lib/utils";
import { httpStatusClass, STATUS_CLASS_STYLE } from "@/constants/http-status";
import { pluralize } from "@/modules/dashboard/utils/format";
import type { RunCoverage, RunCoverageOperation } from "@/types/domain";

export interface ContractCoverageProps {
	coverage: RunCoverage | undefined;
	/**
	 * `metadata.openapi.inherited`: the contract is bound on an ancestor of the collection that ran
	 * (#716). The numbers do not change, their reading does: one tag sub-collection of an imported
	 * spec is measured against the whole document, so "4 / 618 operations" is honest for a scoped
	 * run and a catastrophe for a whole-collection one, and nothing else on the card tells them
	 * apart.
	 */
	inheritedBinding?: boolean;
	className?: string;
}

/** A percentage with no trailing noise on the two values that matter most. */
function formatPct(value: number): string {
	if (!Number.isFinite(value)) return "0%";
	return `${Number.isInteger(value) ? value : formatFixed(value, 1)}%`;
}

/**
 * Every send of the operation failed to connect: `sent` counts transport failures (the engine's
 * documented choice), so `covered` alone cannot tell a reached operation from one nothing answered.
 */
function gotNoResponse(operation: RunCoverageOperation): boolean {
	return operation.sent > 0 && (operation.transportErrors ?? 0) >= operation.sent;
}

export function ContractCoverage({ coverage, inheritedBinding, className }: ContractCoverageProps) {
	if (!coverage || coverage.operations.length === 0) return null;

	const uncovered = coverage.operationsTotal - coverage.operationsCovered;
	const unanswered = coverage.operations.filter(gotNoResponse).length;
	const complete = uncovered === 0 && coverage.undeclaredStatusesSeen === 0 && unanswered === 0;

	return (
		<Card className={className}>
			<CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
				<CardTitle>Contract coverage</CardTitle>
				{/*
				 * `Badge variant="chip"`, for `ThresholdVerdict`'s reason: the variant lets a
				 * caller own the background without a `hover:bg-*` tailwind-merge keeps, and
				 * supplies the radius. Text on a tint, never the bare `--status-*` fill as
				 * foreground. Neutral, not red, when something is uncovered: a gap in the run, not
				 * a failure of the system under test, and red would put it beside a failed budget.
				 * An operation whose every send failed to connect is the same gap: covered, as
				 * something was tried, but nothing learned, so not green either.
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
						` ${coverage.undeclaredStatusesSeen} ${pluralize(coverage.undeclaredStatusesSeen, "undeclared status", "undeclared statuses")} observed.`}
					{unanswered > 0 &&
						` ${unanswered} ${pluralize(unanswered, "operation")} got no response.`}
					{coverage.undeclaredOperationRequests !== undefined &&
						` ${coverage.undeclaredOperationRequests} ${pluralize(coverage.undeclaredOperationRequests, "request")} went to operations this document does not declare.`}
				</p>
				{/*
				 * Every number here is exact, said here, not only in the docs: the block sits among
				 * sampled figures (latency percentiles and stored samples are a reservoir under
				 * load), and a reader cannot tell which kind these are (docs/app/openapi.md, "What
				 * is exact and what is sampled").
				 */}
				<p className="mb-3 text-label text-muted-foreground">
					Counted on every send, not from the stored sample.
					{/*
					 * Beside "what these numbers are", not a warning: running one tag folder of an
					 * imported spec is ordinary, and what it leaves uncovered is the truth about
					 * the contract, not a fault (#716).
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
	/*
	 * `undeclaredSeen` repeats the `statusesSeen` codes matching no declared pattern, so the row
	 * paints them apart and answers the header's "N undeclared statuses observed" (#723). A Set, as
	 * a row carries up to 50 of each.
	 */
	const undeclared = new Set(operation.undeclaredSeen);
	/*
	 * The engine caps the two lists independently, so an undeclared code past the seen cap can be
	 * in `undeclaredSeen` only. Painting their union shows every code the row discloses, which
	 * makes `statusesTruncated` (the distinct statuses in neither) the count of what is *not* shown
	 * (#786). Identical to `statusesSeen` under the cap, every row in practice.
	 */
	const statuses = [...new Set([...operation.statusesSeen, ...undeclared])].sort((a, b) => a - b);

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
				{statuses.map((status) => {
					const isUndeclared = undeclared.has(status);
					return (
						<span
							key={status}
							/*
							 * The warning *tint* behind the status's own text colour, never a fill
							 * under it: an undeclared 200 is still a 200, and repainting the code
							 * would trade one fact for the other. Tint plus `--status-*-text` is
							 * the pairing the status rules allow (app/CLAUDE.md); a background
							 * makes it a box, so it takes a radius token.
							 */
							className={cn(
								"font-mono text-xs",
								STATUS_CLASS_STYLE[httpStatusClass(status)].text,
								isUndeclared && "rounded-md bg-status-warning/10 px-1"
							)}
							title={
								isUndeclared
									? `${status} - this document declares no response for it`
									: undefined
							}
						>
							{status}
							{/*
							 * The tint is the only visual difference, and colour alone is not one
							 * for every reader.
							 */}
							{isUndeclared && <span className="sr-only"> undeclared</span>}
						</span>
					);
				})}
				{/*
				 * Statuses the engine's per-operation cap left out of both lists: a list shorter
				 * than its count, drawn as complete, is what truncation disclosure forbids.
				 */}
				{operation.statusesTruncated !== undefined && (
					<span
						className="text-xs text-muted-foreground"
						title={`${operation.statusesTruncated} ${pluralize(operation.statusesTruncated, "more status", "more statuses")} observed and not shown - the per-operation status list is capped`}
					>
						+{operation.statusesTruncated} more
					</span>
				)}
				{operation.otherStatusResponses !== undefined && (
					<span
						className="text-xs text-muted-foreground"
						title="Responses whose status fell outside 100-599, so no status class describes them"
					>
						{operation.otherStatusResponses} off-range
					</span>
				)}
				{operation.transportErrors !== undefined && (
					<span className="text-xs text-destructive-text">
						{operation.transportErrors} failed
					</span>
				)}
			</span>
		</li>
	);
}
