/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { InfoChip, Eyebrow, fmt } from "../shared";
import { TOOLTIPS } from "../tooltips";

/**
 * iterations hero card #2 — average req/s across the run. In iterations mode
 * throughput is an output of how fast the server responds (no rate target).
 */
export function ThroughputCard({
	throughput,
	meanLatency,
}: {
	throughput?: number;
	meanLatency: number;
}) {
	return (
		<div className="bg-card border border-border rounded-md p-4 flex flex-col gap-1.5">
			<Eyebrow>
				Throughput
				<InfoChip tip={TOOLTIPS.throughput} />
			</Eyebrow>
			<div className="flex items-baseline gap-1 mt-0.5">
				<span className="text-[34px] font-bold leading-none font-mono tabular-nums text-foreground">
					{fmt(throughput, 1)}
				</span>
				<span className="text-xs text-muted-foreground">req/s</span>
			</div>
			<p className="text-[11px] text-muted-foreground font-mono mt-0.5">
				mean iter{" "}
				<span className="text-foreground font-semibold">{meanLatency.toFixed(0)}</span>ms
			</p>
		</div>
	);
}
