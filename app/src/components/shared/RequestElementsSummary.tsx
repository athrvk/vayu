/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A single-request load run's own step-level element outcomes (issues
 * #1594, #1641) - extractors, assertions, timers tallied across every
 * submission. The engine already wrote this into the report; nothing
 * rendered it until this component existed.
 *
 * Beside {@link ScriptLifecycleSummary} and {@link CustomMetricsSummary} on
 * the same terms: **silent when the run declared no `requestElements`, or a
 * scenario run reports none here at all** (its own per-step tallies live in
 * the Steps tab instead, `ScenarioStepsTab.tsx`) - an absent `elements` is a
 * different claim from "declared elements and none of them ran".
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { formatNumber } from "@/lib/format-number";
import type { RunReport } from "@/types/domain";

export interface RequestElementsSummaryProps {
	elements: RunReport["elements"];
	className?: string;
}

export function RequestElementsSummary({ elements, className }: RequestElementsSummaryProps) {
	if (!elements?.length) return null;

	return (
		<Card className={className}>
			<CardHeader className="space-y-0">
				<CardTitle>Elements</CardTitle>
			</CardHeader>
			<CardContent>
				<ul className="space-y-1.5">
					{elements.map((element) => (
						<li key={element.id} className="flex items-center gap-2 text-sm">
							<span className="text-muted-foreground font-mono">{element.kind}</span>
							<span className="font-mono text-status-success-text">
								{formatNumber(element.passed)} passed
							</span>
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
						</li>
					))}
				</ul>
			</CardContent>
		</Card>
	);
}
