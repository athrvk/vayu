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
 * constant_concurrency hero card #1 - the achieved req/s emerging from a fixed
 * pool of concurrent users. In closed-loop testing the rate is an output, not a
 * target, so we also surface the per-user contribution (throughput / VU).
 */
export function AchievedThroughputCard({
	throughput,
	configuredConcurrency,
}: {
	throughput?: number;
	configuredConcurrency?: number;
}) {
	const perUser =
		throughput !== undefined && configuredConcurrency && configuredConcurrency > 0
			? throughput / configuredConcurrency
			: undefined;

	return (
		<HeroCardShell label="Achieved Throughput" tip={TOOLTIPS.achievedThroughput}>
			<HeroValue value={fmt(throughput, 1)} unit="req/s" />
			<p className="text-[11px] text-muted-foreground font-mono mt-0.5">
				from{" "}
				<span className="text-foreground font-semibold">
					{fmt(configuredConcurrency, 0)}
				</span>{" "}
				concurrent ·{" "}
				<span className="text-foreground font-semibold">{fmt(perUser, 2)}</span>{" "}
				req/user/sec
			</p>
		</HeroCardShell>
	);
}
