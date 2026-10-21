/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * How many requests crossed the run's slow-request threshold.
 *
 * Absent when none did, and for a run with no slow threshold, where the engine
 * leaves `slowRequests` out: a card of zeros would read as a finding rather
 * than as the absence of one. The per-row verdict is the Samples tab's "Slow"
 * chip and callout.
 *
 * `count` is every slow completion; `tracesStored` is the capped sample of them
 * the run kept (#2399), so the footer says how many can be opened rather than
 * implying all of them can.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { formatLatency, formatNumber, formatPercent } from "@/lib/format-number";
import { pluralize } from "@/modules/dashboard/utils/format";
import type { RunReport } from "@/types";

type SlowRequests = NonNullable<RunReport["slowRequests"]>;

function keptAsSamplesSentence({ count, tracesStored }: SlowRequests): string {
	if (tracesStored >= count) return "Each is kept as a sample on the Samples tab.";
	if (tracesStored <= 0) return "None were kept as samples on the Samples tab.";
	return `${formatNumber(tracesStored)} kept as ${pluralize(tracesStored, "a sample", "samples")} on the Samples tab.`;
}

export function SlowRequestsCard({ slowRequests }: { slowRequests: RunReport["slowRequests"] }) {
	if (!slowRequests || slowRequests.count <= 0) return null;

	return (
		<Card>
			<CardHeader>
				<CardTitle>Slow requests</CardTitle>
			</CardHeader>
			<CardContent>
				<div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-3">
					<div>
						<p className="text-sm text-muted-foreground">Slow requests</p>
						<p className="font-bold text-status-stopped-text">
							{formatNumber(slowRequests.count)}
						</p>
					</div>
					<div>
						<p className="text-sm text-muted-foreground">Threshold</p>
						<p className="font-bold">{formatLatency(slowRequests.thresholdMs)}</p>
					</div>
					<div>
						<p className="text-sm text-muted-foreground">Percentage</p>
						<p className="font-bold">{formatPercent(slowRequests.percentage)}%</p>
					</div>
				</div>
				<p className="text-xs text-muted-foreground mt-3">
					Requests that exceeded the configured threshold.{" "}
					{keptAsSamplesSentence(slowRequests)}
				</p>
			</CardContent>
		</Card>
	);
}
