/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { InfoChip, Eyebrow, fmt } from "../shared";
import { TOOLTIPS } from "../tooltips";

/** Utilisation tier coloring: ≥95% success, ≥80% warning, else destructive. */
function utilColor(util: number | undefined): string {
	if (util === undefined) return "hsl(var(--muted-foreground))";
	if (util >= 95) return "hsl(var(--success))";
	if (util >= 80) return "hsl(var(--warning))";
	return "hsl(var(--destructive))";
}

/**
 * constant_concurrency hero card #2 — how many of the configured N concurrent
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
	const color = utilColor(util);

	return (
		<div className="bg-card border border-border rounded-md p-4 flex flex-col gap-1.5">
			<Eyebrow>
				Concurrency Utilisation
				<InfoChip tip={TOOLTIPS.concurrencyUtil} />
			</Eyebrow>
			<div className="flex items-baseline gap-1 mt-0.5">
				<span
					className="text-[34px] font-bold leading-none font-mono tabular-nums"
					style={{ color }}
				>
					{currentConcurrency}
				</span>
				<span className="text-xs text-muted-foreground">
					of{" "}
					<span className="text-foreground font-semibold">
						{fmt(configuredConcurrency, 0)}
					</span>{" "}
					active
				</span>
			</div>
			<p className="text-[11px] text-muted-foreground font-mono mt-0.5">
				<span className="text-foreground font-semibold">{fmt(util, 0)}</span>% utilisation
			</p>
			{util !== undefined && (
				<div className="relative mt-2 h-1 rounded-sm border border-border bg-accent overflow-hidden">
					<div
						className="absolute inset-y-0 left-0"
						style={{ width: `${Math.min(100, util)}%`, background: color }}
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
