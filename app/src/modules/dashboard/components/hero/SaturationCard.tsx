/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { InfoChip, Eyebrow } from "../shared";
import { TOOLTIPS } from "../tooltips";
import type { Breakpoint } from "../../utils/computeBreakpoint";

/**
 * ramp_up hero card #2 — whether the server has hit its capacity ceiling.
 * "Degrading" when p99 has crossed the SLO breakpoint or transport errors have
 * appeared; the call-out names the concurrency at which degradation began.
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
		<div className="bg-card border border-border rounded-md p-4 flex flex-col gap-1.5">
			<Eyebrow>
				Saturation
				<InfoChip tip={TOOLTIPS.saturation} />
			</Eyebrow>
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
		</div>
	);
}
