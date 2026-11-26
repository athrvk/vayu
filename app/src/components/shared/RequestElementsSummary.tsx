/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A single-request load run's step-level element outcomes (#1594, #1641): extractors, assertions
 * and timers tallied across every submission, as the report carries them. Beside
 * {@link ScriptLifecycleSummary} and {@link CustomMetricsSummary} on their terms: **silent when the
 * run declared no `requestElements`, and for a scenario run**, whose per-step tallies are in the
 * Steps tab (`ScenarioStepsTab.tsx`). An absent `elements` claims something other than "declared,
 * and none ran".
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { ElementTally } from "./ElementTally";
import { elementRowKey } from "./element-origin";
import type { RunReport } from "@/types/domain";

export interface RequestElementsSummaryProps {
	elements: RunReport["elements"];
	/** Responses the deferred replay ran over (`testValidation.samplesTested`); see `ElementTally`. */
	replaySamples?: number;
	className?: string;
}

export function RequestElementsSummary({
	elements,
	replaySamples,
	className,
}: RequestElementsSummaryProps) {
	if (!elements?.length) return null;

	return (
		<Card className={className}>
			<CardHeader className="space-y-0">
				<CardTitle>Elements</CardTitle>
			</CardHeader>
			<CardContent>
				<ul className="space-y-1.5">
					{elements.map((element, i) => (
						<li key={elementRowKey(element, i)}>
							<ElementTally
								element={element}
								replaySamples={replaySamples}
								className="text-sm"
							/>
						</li>
					))}
				</ul>
			</CardContent>
		</Card>
	);
}
