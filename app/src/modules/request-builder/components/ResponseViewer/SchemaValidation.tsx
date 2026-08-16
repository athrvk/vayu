/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The schema verdict in full, inside the Tests tab (issue #628).
 *
 * It lives in Tests rather than in a tab of its own because the tab set is a
 * constant (see the long comment in `ResponseViewer/index.tsx`: a tab that comes
 * and goes was issue #59), and because a schema check *is* a test result - the
 * one the spec wrote rather than the one a script did.
 *
 * Everything a verdict knows is shown, including the two things that are easy
 * to leave out and dishonest to leave out: how many failures there were when
 * more were found than are listed, and which schema keywords the validator
 * could not evaluate.
 */

import { AlertTriangle, CheckCircle2, HelpCircle, XCircle } from "lucide-react";
import { uncheckedReasonText } from "@/components/shared/response-viewer/validation-reasons";
import type { ResponseValidation } from "@/types";

export interface SchemaValidationProps {
	validation: ResponseValidation;
}

export default function SchemaValidation({ validation }: SchemaValidationProps) {
	const failures = validation.failures ?? [];
	const total = validation.failuresTotal ?? failures.length;
	const unevaluated = validation.unevaluatedKeywords ?? [];

	return (
		<section className="space-y-2">
			<div className="flex items-center gap-1.5 text-xs">
				{!validation.checked ? (
					<>
						<HelpCircle aria-hidden="true" className="size-3.5 text-muted-foreground" />
						<span className="text-muted-foreground">
							{uncheckedReasonText(validation.reason)}
						</span>
					</>
				) : validation.valid ? (
					<>
						<CheckCircle2
							aria-hidden="true"
							className="size-3.5 text-status-success-text"
						/>
						<span className="text-foreground">
							Matched the schema the spec declares
							{validation.matchedStatus ? ` for ${validation.matchedStatus}` : ""}
							{validation.matchedContentType
								? ` ${validation.matchedContentType}`
								: ""}
						</span>
					</>
				) : (
					<>
						<XCircle aria-hidden="true" className="size-3.5 text-status-error-text" />
						<span className="text-foreground tabular-nums">
							<span className="text-status-error-text font-medium">{total}</span>{" "}
							{total === 1 ? "problem" : "problems"} against the schema
							{validation.matchedStatus ? ` for ${validation.matchedStatus}` : ""}
						</span>
					</>
				)}
			</div>

			{failures.length > 0 && (
				<ul className="space-y-1">
					{failures.map((failure, i) => (
						<li key={i} className="text-xs">
							<code className="text-foreground">{failure.path || "(body)"}</code>
							<span className="text-muted-foreground"> - {failure.message}</span>
						</li>
					))}
				</ul>
			)}

			{/*
			 * Said out loud, never elided: a list that is shorter than the count
			 * reads as the whole set of problems unless it says otherwise.
			 */}
			{total > failures.length && (
				<p className="text-xs text-muted-foreground tabular-nums">
					Showing {failures.length} of {total}.
				</p>
			)}

			{/*
			 * The dialect gap. A body can pass every check that ran while the part
			 * of its schema that would have rejected it was never evaluated, so
			 * this is not a footnote - it is what makes the verdict above honest.
			 */}
			{unevaluated.length > 0 && (
				<div className="flex items-start gap-1.5 text-xs text-muted-foreground">
					<AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
					<span>
						Part of this schema was not evaluated:{" "}
						{unevaluated
							.map(({ keyword, count }) =>
								count > 1 ? `${keyword} (${count})` : keyword
							)
							.join(", ")}
						. These keywords are newer than the dialect the validator reads, so what
						they describe was neither checked nor failed.
					</span>
				</div>
			)}
		</section>
	);
}
