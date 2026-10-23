/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { formatNumber, formatOneDecimal, formatPercent } from "@/lib/format-number";
import { orDash } from "../format";
import { TOOLTIPS } from "../tooltips";
import { HeroCardShell, HeroValue, MiniBar } from "./HeroCardShell";

/**
 * constant_concurrency hero card #2 - how many of the configured N virtual
 * users had a request on the wire. Below 100% means idle virtual users, which
 * describes the run's shape rather than a failure, so the number and the bar
 * carry no tier colour (#2245).
 *
 * `meanInFlight` is the mean on the wire (the trailing window live, the whole
 * run once finished). Without it the card draws `currentConcurrency` as a count
 * of "active" users: capacity discovery, and a run stored before the mean
 * existed. The instant alone reads 0-and-N for users that wait in step (#2821).
 */
export function ConcurrencyUtilCard({
	currentConcurrency,
	configuredConcurrency,
	meanInFlight,
}: {
	currentConcurrency: number;
	configuredConcurrency?: number;
	meanInFlight?: number;
}) {
	const onTheWire = meanInFlight !== undefined;
	// The window credits a request to the second it completes in, so a target
	// slower than the window can read above the user count for one tick; the
	// count is a hard ceiling on the wire.
	const shown = onTheWire
		? Math.min(meanInFlight, configuredConcurrency ?? meanInFlight)
		: currentConcurrency;
	const util =
		configuredConcurrency && configuredConcurrency > 0
			? (shown / configuredConcurrency) * 100
			: undefined;

	return (
		<HeroCardShell
			label="Virtual user utilisation"
			tip={onTheWire ? TOOLTIPS.concurrencyUtil : TOOLTIPS.concurrencyUtilInstant}
		>
			<HeroValue
				value={onTheWire ? formatOneDecimal(shown) : formatNumber(shown)}
				unit={
					<>
						of{" "}
						<span className="text-foreground font-semibold">
							{orDash(configuredConcurrency, formatNumber)}
						</span>{" "}
						{onTheWire ? "on the wire" : "active"}
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
