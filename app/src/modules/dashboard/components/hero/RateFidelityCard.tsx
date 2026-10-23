/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { formatNumber, formatPercent, formatRate, formatSeconds } from "@/lib/format-number";
import type { StoppedAt } from "../../types";
import { TOOLTIPS } from "../tooltips";
import { HeroCardShell, HeroValue, MiniBar } from "./HeroCardShell";

/**
 * Rate-fidelity tier coloring: ≥95% success, ≥80% warning, else destructive.
 *
 * Two variants, because the same tier drives both the number and the MiniBar.
 * The number is text - the fill tokens measured 2.13:1 on the light card, under
 * even the 3:1 large-text bar - while the bar is a fill on `--card`, which is
 * what the `--series-*` tier is tuned for (the bare `--destructive` measures
 * 1.73:1 there in dark).
 */
function fidelityTextColor(achievement: number | undefined): string {
	if (achievement === undefined) return "hsl(var(--muted-foreground))";
	if (achievement >= 95) return "hsl(var(--success-text))";
	if (achievement >= 80) return "hsl(var(--warning-text))";
	return "hsl(var(--destructive-text))";
}

function fidelityFillColor(achievement: number | undefined): string {
	if (achievement === undefined) return "hsl(var(--muted-foreground))";
	if (achievement >= 95) return "hsl(var(--series-success))";
	if (achievement >= 80) return "hsl(var(--series-warning))";
	return "hsl(var(--series-danger))";
}

/**
 * constant_rps hero card #1 - how closely the requests sent tracked the target
 * RPS over the sending window. The percentage arrives derived (live from
 * `liveRateFidelity`, finished from the report), so a run's drain never reads
 * as a missed rate.
 * A stopped run's figure is its pace, so `stoppedAt` states the share of the
 * plan it reached (#2805).
 */
export function RateFidelityCard({
	targetRps,
	actualRps,
	achievement,
	stoppedAt,
}: {
	targetRps?: number;
	actualRps?: number;
	achievement?: number;
	/** A stopped run's share of its plan; the figure above is its pace. */
	stoppedAt?: StoppedAt;
}) {
	const textColor = fidelityTextColor(achievement);
	const fillColor = fidelityFillColor(achievement);

	return (
		<HeroCardShell label="Rate fidelity" tip={TOOLTIPS.rateFidelity}>
			<HeroValue value={formatPercent(achievement)} unit="%" color={textColor} />
			<p className="text-label text-muted-foreground font-mono mt-0.5">
				target{" "}
				<span className="text-foreground font-semibold">{formatRate(targetRps)}</span> ·
				actual{" "}
				<span className="text-foreground font-semibold">{formatRate(actualRps)}</span> req/s
			</p>
			{stoppedAt && (
				<p className="text-label text-muted-foreground font-mono mt-0.5">
					stopped at {formatNumber(Math.round(stoppedAt.planSharePct))}% of the planned{" "}
					{formatSeconds(stoppedAt.plannedSeconds)}
				</p>
			)}
			{achievement !== undefined && targetRps && (
				<MiniBar pct={Math.min(100, achievement)} color={fillColor} showTarget />
			)}
		</HeroCardShell>
	);
}
