/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { fmt } from "../shared";
import { TOOLTIPS } from "../tooltips";
import { HeroCardShell, HeroValue } from "./HeroCardShell";

/**
 * iterations hero card #2 - average req/s across the run. In iterations mode
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
		<HeroCardShell label="Throughput" tip={TOOLTIPS.throughput}>
			<HeroValue value={fmt(throughput, 1)} unit="req/s" />
			<p className="text-[11px] text-muted-foreground font-mono mt-0.5">
				mean iter{" "}
				<span className="text-foreground font-semibold">{meanLatency.toFixed(0)}</span>ms
			</p>
		</HeroCardShell>
	);
}
