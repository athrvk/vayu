/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { CONCURRENCY_UNIT_SINGULAR, concurrencyUnit } from "@/constants/load-test-modes";
import { fmt } from "../format";
import { TOOLTIPS } from "../tooltips";
import { HeroCardShell, HeroValue } from "./HeroCardShell";

/**
 * constant_concurrency hero card #1 - the achieved req/s emerging from a fixed
 * pool of virtual users. In closed-loop testing the rate is an output, not a
 * target, so we also surface the per-user contribution.
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
		<HeroCardShell label="Achieved throughput" tip={TOOLTIPS.achievedThroughput}>
			<HeroValue value={fmt(throughput, 1)} unit="req/s" />
			<p className="text-label text-muted-foreground font-mono mt-0.5">
				from{" "}
				<span className="text-foreground font-semibold">
					{fmt(configuredConcurrency, 0)}
				</span>{" "}
				{concurrencyUnit(configuredConcurrency ?? 0)} ·{" "}
				<span className="text-foreground font-semibold">{fmt(perUser, 2)}</span> req/s per{" "}
				{CONCURRENCY_UNIT_SINGULAR}
			</p>
		</HeroCardShell>
	);
}
