/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One element's tally line - its kind and what happened to it across a load
 * run - shared by the single-request Elements card and the scenario Steps tab
 * (issue #2144).
 *
 * **A `deferred` element is not a skipped one.** A post-request script is not
 * run inline on the load path; the engine replays it against the sampled
 * responses afterwards and reports that in the Test Validation card. Its
 * `passed`/`failed` are therefore zero by construction, and "0 passed" would
 * read as a script that did nothing. `deferred` is absent from a report
 * stored before #2144, which keeps the older rendering.
 */

import { formatNumber } from "@/lib/format-number";
import { cn } from "@/lib/utils";
import { pluralize } from "@/modules/dashboard/utils/format";
import type { RunScenarioStepElementTally } from "@/types/domain";

export interface ElementTallyProps {
	element: RunScenarioStepElementTally;
	className?: string;
}

export function ElementTally({ element, className }: ElementTallyProps) {
	const deferred = element.deferred ?? 0;
	// A deferred row has no inline pass count to state; for every other row
	// "N passed" is always stated, zero included.
	const showPassed = deferred === 0 || element.passed > 0;

	return (
		<div className={cn("flex flex-wrap items-center gap-x-2", className)}>
			<span className="text-muted-foreground font-mono">{element.kind}</span>
			{deferred > 0 && (
				<span className="font-mono text-muted-foreground">
					{formatNumber(deferred)} {pluralize(deferred, "request")} deferred to a post-run
					replay of sampled responses - results in Test Validation
				</span>
			)}
			{showPassed && (
				<span className="font-mono text-status-success-text">
					{formatNumber(element.passed)} passed
				</span>
			)}
			{element.failed > 0 && (
				<span className="font-mono text-status-error-text">
					{formatNumber(element.failed)} failed
				</span>
			)}
			{element.skipped > 0 && (
				<span className="font-mono text-muted-foreground">
					{formatNumber(element.skipped)} skipped
				</span>
			)}
		</div>
	);
}
