/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a stored sample's trace says beyond its timing: the error type, the data
 * row it bound and the assertions that failed.
 *
 * Each block is absent when the trace does not carry its field, so a plain
 * success sample expands to exactly what it did before.
 */

import { Callout } from "@/components/shared";
import type { RunResultTrace } from "@/types";

export function SampleTraceDetails({ trace }: { trace: RunResultTrace | undefined }) {
	if (!trace) return null;

	return (
		<>
			{trace.error_type && (
				<div className="flex gap-4 text-sm">
					<span className="text-muted-foreground">Error type:</span>
					<span className="font-mono">{trace.error_type}</span>
				</div>
			)}

			{/* The data row this result bound (issue #449). A scenario load run
			    stores no per-step `results` rows, so this is the only thing that
			    says which row of the file produced the sample - and for a failure
			    it is the row the reader has to go and look at. Row 0 is a row, so
			    the test is `!== undefined`, never truthiness. */}
			{trace.dataRowIndex !== undefined && (
				<div className="flex gap-4 text-sm">
					<span className="text-muted-foreground">Data row:</span>
					<span className="font-mono">{trace.dataRowIndex}</span>
				</div>
			)}

			{/* Per-test validation failures (`validate_scripts` in run_manager.cpp),
			    so the row says which assertions failed and why, not just that the
			    status chip reads `ERR` (issue #111). */}
			{trace.failures && trace.failures.length > 0 && (
				<div className="space-y-1">
					<p className="text-xs font-medium text-muted-foreground">
						Failed tests
						{trace.totalFailed !== undefined && (
							<span className="ml-1">({trace.totalFailed})</span>
						)}
					</p>
					<div className="space-y-1.5">
						{trace.failures.map((failure, i) => (
							<Callout key={i} severity="blocking">
								<pre className="font-mono whitespace-pre-wrap break-words">
									{failure}
								</pre>
							</Callout>
						))}
					</div>
				</div>
			)}
		</>
	);
}
