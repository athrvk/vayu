/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Whether a run's responses matched the schemas its contract declares
 * (issue #681).
 *
 * The other half of what `ContractCoverage` beside it says: coverage answers
 * "did the run touch the contract", this answers "did what came back match it".
 * A run can call all eighteen operations and have half of them answer with a
 * body the document does not describe.
 *
 * **Silent when the run was not measured against a contract**, on the same terms
 * every conditional block of the report follows: the engine writes no
 * `schemaValidation` at all for an unbound collection, and an absent block says
 * "not judged" rather than "judged and matched".
 *
 * Three numbers and not one percentage, because the three do not add up the way
 * a percentage implies. `checked` is a subset of `responses` - a response with
 * no schema for its status was neither a pass nor a failure - and `partlyChecked`
 * overlaps both verdicts rather than sitting beside them. Collapsing any of that
 * into "94% valid" is the reading this whole feature exists to prevent.
 */

import { AlertTriangle } from "lucide-react";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { RunSchemaValidation } from "@/types/domain";

export interface SchemaVerdictProps {
	validation: RunSchemaValidation | undefined;
	className?: string;
}

export function SchemaVerdict({ validation, className }: SchemaVerdictProps) {
	if (!validation || validation.responses <= 0) return null;

	const unchecked = Math.max(0, validation.responses - validation.checked);
	const clean = validation.failed === 0;

	return (
		<Card className={className}>
			<CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
				<CardTitle className="text-base">Schema validation</CardTitle>
				{/*
				 * `Badge variant="chip"` for the reason `ContractCoverage` states
				 * at its own: it is the variant that lets a caller own the
				 * background without inheriting a `hover:bg-*` tailwind-merge
				 * will not replace. Text on a tint, never the bare `--status-*`
				 * fill as a foreground.
				 *
				 * Destructive when something failed, unlike coverage's neutral
				 * warning - a response that contradicts the contract *is* a
				 * failure of the system under test, where an unexercised
				 * operation is only a gap in the run.
				 */}
				<Badge
					variant="chip"
					className={cn(
						"font-medium tabular-nums",
						clean
							? "bg-status-success/10 text-status-success-text"
							: "bg-status-error/10 text-status-error-text"
					)}
				>
					{clean
						? `${validation.valid} / ${validation.checked} matched`
						: `${validation.failed} failed`}
				</Badge>
			</CardHeader>
			<CardContent className="space-y-2">
				{/*
				 * The numbers as a sentence, the shape `ContractCoverage` beside
				 * it uses - and for its reason: they do not partition anything,
				 * so a row of equal-weight tiles would invite reading them as a
				 * total and its parts.
				 */}
				<p className="text-sm tabular-nums">
					{validation.checked} of {validation.responses}{" "}
					{validation.responses === 1 ? "response" : "responses"} checked -{" "}
					{validation.valid} matched the declared schema, {validation.failed} did not.
				</p>

				{/*
				 * What the numbers describe. A load run validates the responses
				 * it kept, so "0 failed" there means "no sampled response
				 * failed" - a different claim from a collection run's, which
				 * checks every step. Saying which is the same honesty the
				 * coverage block's exact-vs-sampled note carries.
				 */}
				<p className="text-xs text-muted-foreground">
					{validation.sampled
						? "Counted over the responses this run kept, not every one it produced."
						: "Counted over every step this run executed."}
					{unchecked > 0
						? ` ${unchecked} could not be checked - no schema declared for the status or content type, or a body that is not JSON.`
						: ""}
				</p>

				{/*
				 * The dialect gap, at run scale. A body can pass every check that
				 * ran while the part of its schema that would have rejected it
				 * was never evaluated, so a green count beside a half-read schema
				 * has to say so.
				 */}
				{validation.partlyChecked > 0 && (
					<div className="flex items-start gap-1.5 text-xs text-muted-foreground">
						<AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
						<span className="tabular-nums">
							{validation.partlyChecked} of the checked responses were matched against
							a schema this validator could only partly evaluate - open the step to
							see which keywords went unread.
						</span>
					</div>
				)}

				{/*
				 * Only when it was on: the default is off, and stating "schema
				 * failures did not fail their steps" under every report would be
				 * noise. When it *is* on, it changes what a failed step means,
				 * which is worth one line.
				 */}
				{validation.failOnSchemaError && (
					<p className="text-xs text-muted-foreground">
						This run failed any step whose response did not match its schema.
					</p>
				)}
			</CardContent>
		</Card>
	);
}
