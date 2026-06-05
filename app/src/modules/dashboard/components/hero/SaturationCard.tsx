/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { TOOLTIPS } from "../tooltips";
import type { Breakpoint } from "../../utils/computeBreakpoint";
import { HeroCardShell } from "./HeroCardShell";

/**
 * ramp_up hero card #2 — whether the server has hit its capacity ceiling.
 * "Degrading" when p99 has crossed the SLO breakpoint or transport errors have
 * appeared; the call-out names the concurrency at which degradation began.
 *
 * Bespoke body (22px text headline, not the 34px HeroValue numeric).
 */
export function SaturationCard({
	breakpoint,
	failedRequests,
}: {
	breakpoint: Breakpoint;
	failedRequests: number;
}) {
	const degrading = breakpoint.crossed || failedRequests > 0;
	const color = degrading ? "hsl(var(--warning))" : "hsl(var(--success))";

	return (
		<HeroCardShell label="Saturation" tip={TOOLTIPS.saturation}>
			<div className="flex items-baseline gap-1 mt-1">
				<span className="text-[22px] font-bold leading-none" style={{ color }}>
					{degrading ? "⚠ degrading" : "✓ healthy"}
				</span>
			</div>
			{breakpoint.crossed && (
				<p className="text-[11px] text-muted-foreground font-mono mt-0.5">
					p99 crossed{" "}
					<span className="text-foreground font-semibold">{breakpoint.p99Ms}</span>ms at
					conc{" "}
					<span className="text-foreground font-semibold">{breakpoint.concurrency}</span>
				</p>
			)}
		</HeroCardShell>
	);
}
