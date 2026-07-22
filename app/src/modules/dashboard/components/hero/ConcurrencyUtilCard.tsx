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
 * Utilisation tier coloring: ≥95% success, ≥80% warning, else destructive.
 * Split text vs fill for the same reason as RateFidelityCard - the number is
 * text and needs the accessible pair; the MiniBar is a fill and keeps the
 * saturated one.
 */
function utilTextColor(util: number | undefined): string {
	if (util === undefined) return "hsl(var(--muted-foreground))";
	if (util >= 95) return "hsl(var(--success-text))";
	if (util >= 80) return "hsl(var(--warning-text))";
	return "hsl(var(--destructive-text))";
}

function utilFillColor(util: number | undefined): string {
	if (util === undefined) return "hsl(var(--muted-foreground))";
	if (util >= 95) return "hsl(var(--success))";
	if (util >= 80) return "hsl(var(--warning))";
	return "hsl(var(--destructive))";
}

/**
 * constant_concurrency hero card #2 - how many of the configured N concurrent
 * users were actually in-flight on average. Below 100% means idle VUs.
 */
export function ConcurrencyUtilCard({
	currentConcurrency,
	configuredConcurrency,
}: {
	currentConcurrency: number;
	configuredConcurrency?: number;
}) {
	const util =
		configuredConcurrency && configuredConcurrency > 0
			? (currentConcurrency / configuredConcurrency) * 100
			: undefined;
	const textColor = utilTextColor(util);
	const fillColor = utilFillColor(util);

	return (
		<HeroCardShell label="Concurrency Utilisation" tip={TOOLTIPS.concurrencyUtil}>
			<HeroValue
				value={currentConcurrency}
				color={textColor}
				unit={
					<>
						of{" "}
						<span className="text-foreground font-semibold">
							{fmt(configuredConcurrency, 0)}
						</span>{" "}
						active
					</>
				}
			/>
			<p className="text-[11px] text-muted-foreground font-mono mt-0.5">
				<span className="text-foreground font-semibold">{fmt(util, 0)}</span>% utilisation
			</p>
			{util !== undefined && (
				<MiniBar pct={Math.min(100, util)} color={fillColor} showTarget />
			)}
		</HeroCardShell>
	);
}
