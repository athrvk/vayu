/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What one step's assertions came to, in a line (issue #724).
 *
 * Two states, and the absent third is the point: a step whose script asserted
 * nothing renders no chip at all, because the component is not given a tally.
 * A `0 passed` would read as a result where the truth is that nothing was
 * claimed - the same absent-is-not-zero rule the schema verdict beside it
 * follows.
 *
 * The chip is a summary and never the evidence: the per-assertion list lives in
 * the expansion, from the stored trace. That split is what lets a live step say
 * something honest before its stored row exists - the engine's `step` frame
 * carries these two numbers and not the unbounded list.
 */

import { CheckCircle2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StepTestTally } from "@/types";

export interface TestsChipProps {
	tests: StepTestTally;
	className?: string;
}

export function TestsChip({ tests, className }: TestsChipProps) {
	const total = tests.passed + tests.failed;

	if (tests.failed > 0) {
		return (
			<div
				className={cn(
					"flex items-center gap-1.5 text-xs text-status-error-text",
					className
				)}
				title={`${tests.failed.toLocaleString()} of ${total.toLocaleString()} assertions did not hold.`}
			>
				<XCircle aria-hidden="true" className="size-3.5" />
				<span className="tabular-nums">
					{tests.passed.toLocaleString()} passed, {tests.failed.toLocaleString()} failed
				</span>
			</div>
		);
	}

	return (
		<div
			className={cn("flex items-center gap-1.5 text-xs text-status-success-text", className)}
			title="Every assertion this step's test script made held."
		>
			<CheckCircle2 aria-hidden="true" className="size-3.5" />
			<span className="tabular-nums">
				{tests.passed.toLocaleString()} {total === 1 ? "test" : "tests"} passed
			</span>
		</div>
	);
}
