/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The run-level average of each network phase: five label/value pairs driven
 * by the shared phase descriptor.
 *
 * Gated on the averages themselves, not on `timingBreakdown`: that object also
 * carries the per-phase percentiles, which exist for runs that stored no
 * traces, and this card renders averages only, so it would print five dashes
 * for them. This is the one renderer with room for the spelled-out label, so it
 * reads `longLabel` ("First byte") where the dense ones read "TTFB".
 */

import { Card, CardContent, CardHeader, CardTitle, InfoChip } from "@/components/ui";
import { formatPhaseDuration } from "@/components/shared/response-viewer/utils";
import {
	hasPhaseAverages,
	phasesFromAverages,
} from "@/components/shared/response-viewer/timing-phases";
import type { RunReport } from "@/types";

export function PhaseAveragesCard({
	timingBreakdown,
}: {
	timingBreakdown: RunReport["timingBreakdown"];
}) {
	if (!hasPhaseAverages(timingBreakdown)) return null;

	return (
		<Card>
			<CardHeader>
				<CardTitle>Timing breakdown</CardTitle>
			</CardHeader>
			<CardContent>
				<div className="grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-3">
					{phasesFromAverages(timingBreakdown).map((phase) => {
						const duration =
							phase.value !== undefined
								? formatPhaseDuration(phase.value)
								: undefined;
						return (
							<div key={phase.key}>
								<p className="text-sm text-muted-foreground">
									{phase.longLabel} <InfoChip tip={phase.tip} />
								</p>
								<p className="font-bold">
									{duration ? (
										<>
											{duration.value}
											{duration.unit}
										</>
									) : (
										<span className="text-subtle-foreground">-</span>
									)}
								</p>
							</div>
						);
					})}
				</div>
			</CardContent>
		</Card>
	);
}
