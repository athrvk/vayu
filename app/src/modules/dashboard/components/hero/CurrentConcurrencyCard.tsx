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
		<HeroCardShell label="Current Concurrency" tip={TOOLTIPS.currentConcurrency}>
			<HeroValue value={currentConcurrency} unit="active" />
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
		</HeroCardShell>
	);
}
