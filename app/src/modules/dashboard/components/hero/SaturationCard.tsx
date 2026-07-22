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
 * ramp_up hero card #2 - whether the server has hit its capacity ceiling.
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

	/*
	 * The `-text` variants, not the bare fill tokens.
	 *
	 * This was an inline `style={{ color: "hsl(var(--warning))" }}`. Measured on
	 * `--card`, `--warning` is 2.14 and `--destructive` 1.73 - this is the same
	 * "fill token used as a foreground" bug swept out of the app earlier, and it
	 * survived because the guard scans for the `text-<family>` *class* and an
	 * inline style is invisible to it. The guard now covers both forms.
	 */
	const colorClass = degrading ? "text-warning-text" : "text-success-text";

	return (
		<HeroCardShell label="Saturation" tip={TOOLTIPS.saturation}>
			<div className="flex items-baseline gap-1 mt-1">
				<span className={`text-[22px] font-bold leading-none ${colorClass}`}>
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
