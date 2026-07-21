/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { fmt } from "../shared";
import { TOOLTIPS } from "../tooltips";
import { HeroCardShell, HeroValue, MiniBar } from "./HeroCardShell";

/**
 * Rate-fidelity tier coloring: ≥95% success, ≥80% warning, else destructive.
 *
 * Two variants, because the same tier drives both the number and the MiniBar.
 * The number is text — the fill tokens measured 2.13:1 on the light card, under
 * even the 3:1 large-text bar — while the bar is a solid fill, where the fill
 * token is the right, more saturated value.
 */
function fidelityTextColor(achievement: number | undefined): string {
	if (achievement === undefined) return "hsl(var(--muted-foreground))";
	if (achievement >= 95) return "hsl(var(--success-text))";
	if (achievement >= 80) return "hsl(var(--warning-text))";
	return "hsl(var(--destructive-text))";
}

function fidelityFillColor(achievement: number | undefined): string {
	if (achievement === undefined) return "hsl(var(--muted-foreground))";
	if (achievement >= 95) return "hsl(var(--success))";
	if (achievement >= 80) return "hsl(var(--warning))";
	return "hsl(var(--destructive))";
}

/** constant_rps hero card #1 — how closely throughput tracked the target RPS. */
export function RateFidelityCard({
	targetRps,
	actualRps,
}: {
	targetRps?: number;
	actualRps?: number;
}) {
	const achievement =
		targetRps && targetRps > 0 && actualRps !== undefined
			? (actualRps / targetRps) * 100
			: undefined;
	const textColor = fidelityTextColor(achievement);
	const fillColor = fidelityFillColor(achievement);

	return (
		<HeroCardShell label="Rate Fidelity" tip={TOOLTIPS.rateFidelity}>
			<HeroValue value={fmt(achievement, 1)} unit="%" color={textColor} />
			<p className="text-[11px] text-muted-foreground font-mono mt-0.5">
				target <span className="text-foreground font-semibold">{fmt(targetRps, 1)}</span> ·
				actual <span className="text-foreground font-semibold">{fmt(actualRps, 2)}</span>{" "}
				req/s
			</p>
			{achievement !== undefined && targetRps && (
				<MiniBar pct={Math.min(100, achievement)} color={fillColor} showTarget />
			)}
		</HeroCardShell>
	);
}
