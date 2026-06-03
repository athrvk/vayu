/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { InfoChip, Eyebrow, fmt } from "../shared";
import { TOOLTIPS } from "../tooltips";

/**
 * constant_concurrency hero card #1 — the achieved req/s emerging from a fixed
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
		<div className="bg-card border border-border rounded-md p-4 flex flex-col gap-1.5">
			<Eyebrow>
				Achieved Throughput
				<InfoChip tip={TOOLTIPS.achievedThroughput} />
			</Eyebrow>
			<div className="flex items-baseline gap-1 mt-0.5">
				<span className="text-[34px] font-bold leading-none font-mono tabular-nums text-foreground">
					{fmt(throughput, 1)}
				</span>
				<span className="text-xs text-muted-foreground">req/s</span>
			</div>
			<p className="text-[11px] text-muted-foreground font-mono mt-0.5">
				from{" "}
				<span className="text-foreground font-semibold">
					{fmt(configuredConcurrency, 0)}
				</span>{" "}
				concurrent ·{" "}
				<span className="text-foreground font-semibold">{fmt(perUser, 2)}</span>{" "}
				req/user/sec
			</p>
		</div>
	);
}
