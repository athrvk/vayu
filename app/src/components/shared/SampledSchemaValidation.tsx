/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Whether the responses a load run kept matched the schemas its contract
 * declares (issue #682).
 *
 * The other half of the answer `ContractCoverage` beside it starts: coverage
 * says which of the contract the run touched, this says whether what came back
 * honoured it. Both are computed against the document the run was *planned*
 * with, and both are absent when the run was not measured against one - a run
 * whose responses were never checked did not pass a contract.
 *
 * **The one thing this component must never let a reader assume is that these
 * numbers describe the run.** They describe the bounded reservoir of responses
 * the run stored: the engine defers validation to run end because the load loop
 * refills concurrency per completion. So the sampled denominator is rendered
 * beside every tally rather than left to a tooltip, and `Coverage is exact,
 * this is sampled` is the sentence the block carries - the same distinction
 * `docs/app/openapi.md`'s exact-vs-sampled table draws.
 *
 * Reasons come from `uncheckedReasonText`, the wording the response viewer
 * already shows for a single response. One copy: a second list of sentences
 * here would drift from the one a user reads on their own response.
 */

import { AlertTriangle } from "lucide-react";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { cn } from "@/lib/utils";
import { uncheckedReasonText } from "./response-viewer/validation-reasons";
import type { RunSchemaValidation, ValidationUncheckedReason } from "@/types/domain";

export interface SampledSchemaValidationProps {
	validation: RunSchemaValidation | undefined;
	className?: string;
}

export function SampledSchemaValidation({ validation, className }: SampledSchemaValidationProps) {
	if (!validation || validation.sampled <= 0) return null;

	const unchecked = Object.entries(validation.uncheckedReasons ?? {}) as [
		ValidationUncheckedReason,
		number,
	][];
	const unevaluated = validation.unevaluatedKeywords ?? [];
	const failures = validation.failures ?? [];

	return (
		<Card className={className}>
			<CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
				<CardTitle className="text-base">Schema validation</CardTitle>
				{/*
				 * `Badge variant="chip"` for the reason `ContractCoverage` states at
				 * its own: it is the variant that lets a caller own the background
				 * without inheriting a `hover:bg-*` tailwind-merge will not replace.
				 * Text on a tint, never the bare `--status-*` fill as a foreground.
				 *
				 * Red only for a real schema failure. A run that checked nothing is
				 * not a run that broke its contract, so it stays neutral rather than
				 * borrowing the vocabulary of a failed budget.
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
					{validation.checked} of {validation.sampled} sampled{" "}
					{validation.sampled === 1 ? "response" : "responses"} checked against the spec.
					{validation.failed > 0 &&
						` ${validation.failed} did not match ${
							validation.failed === 1 ? "its" : "their"
						} declared schema.`}
				</p>
				{/*
				 * The counterpart of the coverage block's "counted on every send",
				 * and the reason both sentences exist: the two blocks sit together
				 * and are computed on different evidence, so neither can leave the
				 * reader to work out which kind its numbers are.
				 */}
				<p className="mb-3 text-[11px] text-muted-foreground">
					Checked at the end of the run, over the responses it kept. Coverage beside this
					is exact; these numbers describe the sample.
				</p>

				{unchecked.length > 0 && (
					<ul className="mb-3 space-y-1">
						{unchecked.map(([reason, count]) => (
							<li key={reason} className="text-xs text-muted-foreground tabular-nums">
								<span className="font-medium">{count}</span>{" "}
								{count === 1 ? "response" : "responses"} not checked:{" "}
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
				 * Said out loud, never elided: a list shorter than the count reads as
				 * the whole set of problems unless it says otherwise.
				 */}
				{validation.failuresTotal > failures.length && (
					<p className="mt-2 text-xs text-muted-foreground tabular-nums">
						Showing {failures.length} of {validation.failuresTotal}.
					</p>
				)}

				{/*
				 * The dialect gap, in aggregate. Responses whose schema was half read
				 * passed every check that *ran*, which is a narrower claim than the
				 * matched count above makes on its own.
				 */}
				{unevaluated.length > 0 && (
					<div className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground">
						<AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
						<span className="tabular-nums">
							{validation.unevaluated} checked{" "}
							{validation.unevaluated === 1 ? "response" : "responses"} met schema
							keywords the validator cannot evaluate:{" "}
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
