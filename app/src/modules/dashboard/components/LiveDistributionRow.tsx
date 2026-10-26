/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Row 3 of the live view: the run-so-far latency distribution (History's HDR
 * chart) and the request timing (History's waterfall and per-phase percentile
 * table), drawn from the latest gate frame (issue #2782).
 *
 * Both are read from `history`, not from the newest tick: only the gate frame
 * carries the distributions, and the newest tick usually is not one
 * (`utils/liveDistributions.ts`). Before the first completion each card says so
 * in one line, sized to the card it will become so nothing jumps when data
 * arrives.
 */

import { useMemo } from "react";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/EmptyState";
import type { LoadTestMetrics } from "@/types";
import { InfoChip } from "./shared";
import { TOOLTIPS } from "./tooltips";
import { LatencyStat } from "./stats/LatencyStat";
import { PhasePercentiles } from "./charts/PhasePercentiles";
import { TimingWaterfall } from "./charts/TimingWaterfall";
import { HdrPercentileChart } from "./charts/uplot";
import { pluralize } from "../utils/format";
import { latestGateFrame, liveDistributions } from "../utils/liveDistributions";

/** The HDR chart's own height; the placeholder holds the same space. */
const PLACEHOLDER_CLASS = "min-h-[200px] flex items-center justify-center";

function Placeholder({ title }: { title: string }) {
	return <EmptyState variant="inline" title={title} className={PLACEHOLDER_CLASS} />;
}

export function LiveDistributionRow({
	history,
	sloMs,
}: {
	history: LoadTestMetrics[];
	sloMs?: number;
}) {
	const frame = useMemo(() => latestGateFrame(history), [history]);
	const { latency, phases } = useMemo(() => liveDistributions(frame), [frame]);

	return (
		<div className="grid grid-cols-1 @3xl:grid-cols-2 gap-3">
			{/* HDR */}
			<Card pad="sm" className="min-w-0">
				<div className="flex items-baseline justify-between mb-3">
					<h3 className="text-xs font-semibold text-foreground">
						Latency distribution
						<InfoChip tip={TOOLTIPS.latencyDistribution} />
						<span className="ml-2 text-label font-normal text-muted-foreground">
							HDR percentile plot
						</span>
					</h3>
				</div>
				{latency ? (
					<>
						<HdrPercentileChart report={latency} sloMs={sloMs} />
						<div className="flex justify-between gap-3 mt-2.5 pt-2.5 border-t border-dashed border-rule text-label font-mono text-muted-foreground">
							<LatencyStat k="min" v={latency.latency.min} />
							<LatencyStat k="mean" v={latency.latency.avg} />
							<LatencyStat k="p50" v={latency.latency.p50} />
							<LatencyStat k="p95" v={latency.latency.p95} />
							<LatencyStat k="p99" v={latency.latency.p99} />
							<LatencyStat k="max" v={latency.latency.max} />
						</div>
						<p className="mt-2 text-label text-muted-foreground">
							{`${latency.count.toLocaleString()} ${pluralize(latency.count, "completion")} so far`}
						</p>
					</>
				) : (
					<Placeholder title="Waiting for the first response" />
				)}
			</Card>

			{/* Timing waterfall */}
			<Card pad="sm" className="min-w-0">
				<div className="flex items-baseline justify-between mb-3">
					<h3 className="text-xs font-semibold text-foreground">
						Avg request timing
						<InfoChip tip={TOOLTIPS.avgRequestTiming} />
					</h3>
				</div>
				{phases.kind === "ready" && (
					<>
						<TimingWaterfall report={phases.report} />
						<div className="mt-3 pt-3 border-t border-rule">
							<PhasePercentiles report={phases.report} />
						</div>
					</>
				)}
				{phases.kind === "waiting" && (
					<Placeholder title="Waiting for the first response" />
				)}
				{phases.kind === "off" && <Placeholder title="Phase timing is off for this run" />}
			</Card>
		</div>
	);
}
