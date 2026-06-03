/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { InfoChip, Eyebrow, fmt } from "../shared";
import { TOOLTIPS } from "../tooltips";

/** Rate-fidelity tier coloring: ≥95% success, ≥80% warning, else destructive. */
function fidelityColor(achievement: number | undefined): string {
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
	const color = fidelityColor(achievement);

	return (
		<div className="bg-card border border-border rounded-md p-4 flex flex-col gap-1.5">
			<Eyebrow>
				Rate Fidelity
				<InfoChip tip={TOOLTIPS.rateFidelity} />
			</Eyebrow>
			<div className="flex items-baseline gap-1 mt-0.5">
				<span
					className="text-[34px] font-bold leading-none font-mono tabular-nums"
					style={{ color }}
				>
					{fmt(achievement, 1)}
				</span>
				<span className="text-xs text-muted-foreground">%</span>
			</div>
			<p className="text-[11px] text-muted-foreground font-mono mt-0.5">
				target <span className="text-foreground font-semibold">{fmt(targetRps, 1)}</span> ·
				actual <span className="text-foreground font-semibold">{fmt(actualRps, 2)}</span>{" "}
				req/s
			</p>
			{achievement !== undefined && targetRps && (
				<div className="relative mt-2 h-1 rounded-sm border border-border bg-accent overflow-hidden">
					<div
						className="absolute inset-y-0 left-0"
						style={{
							width: `${Math.min(100, achievement)}%`,
							background: color,
						}}
					/>
					<span
						className="absolute top-[-3px] bottom-[-3px] w-px bg-primary"
						style={{ left: "100%" }}
					/>
				</div>
			)}
		</div>
	);
}
