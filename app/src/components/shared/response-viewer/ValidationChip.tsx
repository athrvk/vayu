/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Whether this response matched the schema its contract declares (issue #628).
 *
 * Three states, deliberately spelled differently, because collapsing any two of
 * them is the defect this whole feature is guarding against:
 *
 * - **matched schema** - checked, and nothing was wrong.
 * - **schema failed** - checked, and something was.
 * - **not checked** - the collection is bound, and this response could not be
 *   judged: no schema for its status, a body that is not JSON, an index the
 *   document does not carry. It is *not* a failure, and it is not silence
 *   either.
 *
 * A response whose collection binds no document renders nothing at all - the
 * component is not given a verdict, because the engine writes none.
 *
 * A `valid: true` beside an unevaluated-keyword disclosure is narrower than it
 * looks: part of the schema could not be evaluated by a draft-07 validator, so
 * the chip says "partly checked" rather than claiming a clean match.
 */

import { CheckCircle2, HelpCircle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ResponseValidation } from "@/types";
import { uncheckedReasonText } from "./validation-reasons";

export interface ValidationChipProps {
	validation: ResponseValidation;
	className?: string;
}

export function ValidationChip({ validation, className }: ValidationChipProps) {
	const partial = (validation.unevaluatedKeywords?.length ?? 0) > 0;

	if (!validation.checked) {
		return (
			<div
				className={cn("flex items-center gap-1.5 text-xs text-muted-foreground", className)}
				title={uncheckedReasonText(validation.reason)}
			>
				<HelpCircle aria-hidden="true" className="size-3.5" />
				<span>Schema not checked</span>
			</div>
		);
	}

	if (!validation.valid) {
		const total = validation.failuresTotal ?? validation.failures?.length ?? 0;
		return (
			<div
				className={cn(
					"flex items-center gap-1.5 text-xs text-status-error-text",
					className
				)}
				title="This response does not match the schema its spec declares."
			>
				<XCircle aria-hidden="true" className="size-3.5" />
				<span className="tabular-nums">
					Schema failed{total > 0 ? ` - ${total.toLocaleString()}` : ""}
					{total > 0 ? (total === 1 ? " problem" : " problems") : ""}
				</span>
			</div>
		);
	}

	return (
		<div
			className={cn(
				"flex items-center gap-1.5 text-xs",
				partial ? "text-muted-foreground" : "text-status-success-text",
				className
			)}
			title={
				partial
					? "Matched the schema, but part of it uses keywords this validator cannot evaluate."
					: "This response matches the schema its spec declares."
			}
		>
			<CheckCircle2 aria-hidden="true" className="size-3.5" />
			<span>{partial ? "Schema partly checked" : "Matched schema"}</span>
		</div>
	);
}
