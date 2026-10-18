/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { formatNumber, formatPercent } from "@/lib/format-number";
import { orDash } from "../format";
import { TOOLTIPS } from "../tooltips";
import { HeroCardShell, HeroValue, MiniBar } from "./HeroCardShell";

/**
 * constant_concurrency hero card #2 - how many of the configured N virtual
 * users were actually in-flight on average. Below 100% means idle virtual users,
 * which describes the run's shape rather than a failure, so the number and the
 * bar carry no tier colour (#2245).
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

	return (
		<HeroCardShell label="Virtual user utilisation" tip={TOOLTIPS.concurrencyUtil}>
			<HeroValue
				value={formatNumber(currentConcurrency)}
				unit={
					<>
						of{" "}
						<span className="text-foreground font-semibold">
							{orDash(configuredConcurrency, formatNumber)}
						</span>{" "}
						active
					</>
				}
			/>
			<p className="text-label text-muted-foreground font-mono mt-0.5">
				<span className="text-foreground font-semibold">{orDash(util, formatPercent)}</span>
				% utilisation
			</p>
			{util !== undefined && (
				<MiniBar
					pct={Math.min(100, util)}
					color="hsl(var(--muted-foreground))"
					showTarget
				/>
			)}
		</HeroCardShell>
	);
}
