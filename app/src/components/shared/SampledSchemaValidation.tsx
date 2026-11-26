/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Whether the responses a run checked matched its contract's schemas (#682, #681): the other half
 * of `ContractCoverage` beside it, which says what the run touched while this says whether the
 * answers honoured it. Both use the document the run was *planned* with, and both are absent for a
 * run not measured against one: unchecked responses did not pass a contract.
 *
 * **Never let a reader assume a denominator the run did not have.** Both run modes write this block
 * on different evidence: a load run validates at run end over its bounded reservoir, as the load
 * loop refills concurrency per completion, while a collection run checks every step. `exact`
 * separates them and the block's sentence follows it, the distinction `docs/app/openapi.md`'s
 * exact-vs-sampled table draws. Absent means sampled, as a report older than the field was, and
 * claiming exactness wrongly is the worse error. Reasons come from `uncheckedReasonText`, the
 * response viewer's wording for one response, so the two cannot drift. The name is from the
 * load-mode block it was written for; it serves both run modes.
 */

import { AlertTriangle } from "lucide-react";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { pluralize } from "@/modules/dashboard/utils/format";
import { cn } from "@/lib/utils";
import { uncheckedReasonText } from "./response-viewer/validation-reasons";
import type { RunSchemaValidation, ValidationUncheckedReason } from "@/types/domain";

export interface SampledSchemaValidationProps {
	validation: RunSchemaValidation | undefined;
	className?: string;
}

export function SampledSchemaValidation({ validation, className }: SampledSchemaValidationProps) {
	if (!validation || validation.sampled <= 0) return null;

	// A collection run checks every step, so its figures are the run. Absent reads as sampled: an
	// older engine's report was, and overclaiming exactness is the mistake this block prevents.
	const exact = validation.exact === true;

	const unchecked = Object.entries(validation.uncheckedReasons ?? {}) as [
		ValidationUncheckedReason,
		number,
	][];
	const unevaluated = validation.unevaluatedKeywords ?? [];
	const failures = validation.failures ?? [];

	return (
		<Card className={className}>
			<CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
				<CardTitle>Schema validation</CardTitle>
				{/*
				 * `Badge variant="chip"`, for `ContractCoverage`'s reason: the variant lets a
				 * caller own the background without a `hover:bg-*` tailwind-merge keeps. Text on a
				 * tint, never the bare `--status-*` fill as foreground. Red only for a real schema
				 * failure: a run that checked nothing did not break its contract, so it stays
				 * neutral.
				 */}
				<Badge
					variant="chip"
					className={cn(
						"font-medium",
						validation.failed > 0
							? "bg-status-error/10 text-status-error-text"
							: validation.checked > 0
								? "bg-status-success/10 text-status-success-text"
								: "bg-muted text-muted-foreground"
					)}
				>
					{validation.valid} / {validation.checked} matched
				</Badge>
			</CardHeader>
			<CardContent>
				<p className="mb-3 text-xs text-muted-foreground tabular-nums">
					{validation.checked} of {validation.sampled}
					{exact ? "" : " sampled"} {pluralize(validation.sampled, "response")} checked
					against the spec.
					{validation.failed > 0 &&
						` ${validation.failed} did not match ${pluralize(
							validation.failed,
							"its",
							"their"
						)} declared schema.`}
				</p>
				{/*
				 * The counterpart of the coverage block's "counted on every send": the two sit
				 * together on different evidence, so neither may leave the reader to work out which
				 * kind its numbers are.
				 */}
				<p className="mb-3 text-label text-muted-foreground">
					{exact
						? "Checked as each step ran, over every response this run produced."
						: "Checked at the end of the run, over the responses it kept. Coverage beside this is exact; these numbers describe the sample."}
				</p>

				{/*
				 * Only when the gate was on (#720). The flag is stored beside the tally because "3
				 * failed" in the step list means something else with it, and a reader who cannot
				 * see which run this was cannot tell the two apart. On `true` alone: a load run has
				 * no flag, and a collection run not asking for the gate is the default this block
				 * describes.
				 */}
				{validation.failOnSchemaError === true && (
					<p className="mb-3 text-label text-muted-foreground">
						This run made the contract a gate: a step that passed everything else and
						did not match its declared schema was failed.
					</p>
				)}

				{unchecked.length > 0 && (
					<ul className="mb-3 space-y-1">
						{unchecked.map(([reason, count]) => (
							<li key={reason} className="text-xs text-muted-foreground tabular-nums">
								<span className="font-medium">{count}</span>{" "}
								{pluralize(count, "response")} not checked:{" "}
								{uncheckedReasonText(reason)}
							</li>
						))}
					</ul>
				)}

				{failures.length > 0 && (
					<ul className="space-y-1">
						{failures.map((failure, i) => (
							<li key={i} className="text-xs">
								{failure.step && (
									<span className="text-muted-foreground">{failure.step}: </span>
								)}
								<code className="text-foreground">{failure.path || "(body)"}</code>
								<span className="text-muted-foreground"> - {failure.message}</span>
							</li>
						))}
					</ul>
				)}

				{/*
				 * Said aloud: a list shorter than its count reads as the whole set of problems
				 * unless it says so.
				 */}
				{validation.failuresTotal > failures.length && (
					<p className="mt-2 text-xs text-muted-foreground tabular-nums">
						Showing {failures.length} of {validation.failuresTotal}.
					</p>
				)}

				{/*
				 * The dialect gap in aggregate: responses whose schema was half read passed every
				 * check that *ran*, a narrower claim than the matched count makes alone.
				 */}
				{unevaluated.length > 0 && (
					<div className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground">
						<AlertTriangle
							aria-hidden="true"
							className="mt-0.5 size-icon-sm shrink-0"
						/>
						<span className="tabular-nums">
							{validation.unevaluated} checked{" "}
							{pluralize(validation.unevaluated, "response")} met schema keywords the
							validator can't evaluate:{" "}
							{unevaluated
								.map(({ keyword, count }) =>
									count > 1 ? `${keyword} (${count})` : keyword
								)
								.join(", ")}
							. What those keywords describe was neither checked nor failed.
						</span>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
