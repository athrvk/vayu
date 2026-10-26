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
 *
 * Instantaneous concurrency is 0 once a run ends, so a finished run hands the
 * peak in as `currentConcurrency` and `isCompleted` renames the card to match:
 * "Peak virtual users", no "active" unit. A run stored without a per-tick series
 * has no lag to report, and the finished card then leaves the clause out rather
 * than print a dash for it; a live card always prints the clause, since its lag
 * arrives with the first ticks.
 */
export function CurrentConcurrencyCard({
	currentConcurrency,
	targetConcurrency,
	rampUpDurationSeconds,
	rampDeviationPct,
	isCompleted = false,
}: {
	/** Absent for a finished run whose peak was not recorded (#2963): "-". */
	currentConcurrency?: number;
	targetConcurrency?: number;
	rampUpDurationSeconds?: number;
	rampDeviationPct?: number;
	isCompleted?: boolean;
}) {
	const showLag = !isCompleted || rampDeviationPct !== undefined;
	return (
		<HeroCardShell
			label={isCompleted ? "Peak virtual users" : "Active virtual users"}
			tip={TOOLTIPS.currentConcurrency}
		>
			<HeroValue
				value={orDash(currentConcurrency, formatNumber)}
				unit={isCompleted ? undefined : "active"}
			/>
			<p className="text-label text-muted-foreground font-mono mt-0.5">
				targeting{" "}
				<span className="text-foreground font-semibold">
					{orDash(targetConcurrency, formatNumber)}
				</span>{" "}
				over{" "}
				<span className="text-foreground font-semibold">
					{orDash(rampUpDurationSeconds, formatSeconds)}
				</span>{" "}
				ramp
				{showLag && (
					<>
						{" "}
						· lag{" "}
						<span className="text-foreground font-semibold">
							{orDash(rampDeviationPct, formatPercent)}
						</span>
						%
					</>
				)}
			</p>
		</HeroCardShell>
	);
}
