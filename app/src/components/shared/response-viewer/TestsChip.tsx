/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What one step's assertions came to, in a line (#724). Two states, and the absent third is the
 * point: a step asserting nothing gets no tally and renders no chip, as `0 passed` would claim a
 * result where nothing was claimed (the schema verdict's absent-is-not-zero rule). A summary, never
 * the evidence: the per-assertion list lives in the expansion, from the stored trace, which lets a
 * live step say something honest before its row exists, as the engine's `step` frame carries the
 * two numbers, not the unbounded list.
 */

import { CheckCircle2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StepTestTally } from "@/types";
import { pluralize } from "@/modules/dashboard/utils/format";

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
				<XCircle aria-hidden="true" className="size-icon-sm" />
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
			<CheckCircle2 aria-hidden="true" className="size-icon-sm" />
			<span className="tabular-nums">
				{tests.passed.toLocaleString()} {pluralize(total, "test")} passed
			</span>
		</div>
	);
}
