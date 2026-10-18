/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * How many requests crossed the run's slow-request threshold.
 *
 * Absent when none did: the engine writes `slowRequests` for every run, and a
 * card of zeros would read as a finding rather than as the absence of one. The
 * per-row verdict is the Samples tab's "Slow" chip and callout.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { formatLatency, formatNumber, formatPercent } from "@/lib/format-number";
import type { RunReport } from "@/types";

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
					Requests that exceeded the configured threshold and were automatically captured
				</p>
			</CardContent>
		</Card>
	);
}
