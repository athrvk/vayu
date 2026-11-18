/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { formatLatencyPartsOrDash } from "@/lib/format-number";
import { fmtRate } from "../format";
import { TOOLTIPS } from "../tooltips";
import { HeroCardShell, HeroValue } from "./HeroCardShell";

/**
 * iterations hero card #2 - average req/s across the run. In iterations mode
 * throughput is an output of how fast the server responds (no rate target).
 * The sub-line is the mean iteration time, whose meaning the caller settles
 * (`DashboardDerived.meanIterationTime`); undefined reads `-`.
 */
export function ThroughputCard({
	throughput,
	meanIterationTime,
}: {
	throughput?: number;
	meanIterationTime?: number;
}) {
	const mean = formatLatencyPartsOrDash(meanIterationTime);
	return (
		<HeroCardShell label="Throughput" tip={TOOLTIPS.throughput}>
			<HeroValue value={fmtRate(throughput)} unit="req/s" />
			<p className="text-label text-muted-foreground font-mono mt-0.5">
				mean iteration <span className="text-foreground font-semibold">{mean.value}</span>
				{mean.unit}
			</p>
		</HeroCardShell>
	);
}
