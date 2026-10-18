/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { formatNumber, formatPercent, formatSeconds } from "@/lib/format-number";
import { orDash } from "../format";
import { TOOLTIPS } from "../tooltips";
import { HeroCardShell, HeroValue } from "./HeroCardShell";

/**
 * ramp_up hero card #1 - in-flight concurrency at this instant. The configured
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
		<HeroCardShell label="Active virtual users" tip={TOOLTIPS.currentConcurrency}>
			<HeroValue value={currentConcurrency} unit="active" />
			<p className="text-label text-muted-foreground font-mono mt-0.5">
				targeting{" "}
				<span className="text-foreground font-semibold">
					{orDash(targetConcurrency, formatNumber)}
				</span>{" "}
				over{" "}
				<span className="text-foreground font-semibold">
					{orDash(rampUpDurationSeconds, formatSeconds)}
				</span>{" "}
				ramp · lag{" "}
				<span className="text-foreground font-semibold">
					{orDash(rampDeviationPct, formatPercent)}
				</span>
				%
			</p>
		</HeroCardShell>
	);
}
