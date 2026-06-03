/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { InfoChip, Eyebrow, fmt } from "../shared";
import { TOOLTIPS } from "../tooltips";

/**
 * ramp_up hero card #1 — in-flight concurrency at this instant. The configured
 * ramp climbs linearly toward the target; ramp lag is the share of the planned
 * curve the generator failed to deliver.
 */
export function CurrentConcurrencyCard({
	currentConcurrency,
	targetConcurrency,
	rampUpDurationSeconds,
	rampDeviationPct,
}: {
	currentConcurrency: number;
	targetConcurrency?: number;
	rampUpDurationSeconds?: number;
	rampDeviationPct?: number;
}) {
	return (
		<div className="bg-card border border-border rounded-md p-4 flex flex-col gap-1.5">
			<Eyebrow>
				Current Concurrency
				<InfoChip tip={TOOLTIPS.currentConcurrency} />
			</Eyebrow>
			<div className="flex items-baseline gap-1 mt-0.5">
				<span className="text-[34px] font-bold leading-none font-mono tabular-nums text-foreground">
					{currentConcurrency}
				</span>
				<span className="text-xs text-muted-foreground">active</span>
			</div>
			<p className="text-[11px] text-muted-foreground font-mono mt-0.5">
				targeting{" "}
				<span className="text-foreground font-semibold">{fmt(targetConcurrency, 0)}</span>{" "}
				over{" "}
				<span className="text-foreground font-semibold">
					{fmt(rampUpDurationSeconds, 0)}
				</span>
				s ramp · lag{" "}
				<span className="text-foreground font-semibold">{fmt(rampDeviationPct, 0)}</span>%
			</p>
		</div>
	);
}
