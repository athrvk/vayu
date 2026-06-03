/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { formatNumber } from "@/utils";
import { InfoChip, Eyebrow } from "../shared";
import { TOOLTIPS } from "../tooltips";
import { computeEta } from "../../utils/computeEta";

/**
 * iterations hero card #1 — progress through the configured iteration count.
 * The bar fills as requests complete; ETA is projected from current throughput.
 */
export function ProgressCard({
	requestsSent,
	requestsExpected,
	currentRps,
}: {
	requestsSent: number;
	requestsExpected: number;
	currentRps: number;
}) {
	const pct =
		requestsExpected > 0 ? Math.min(100, (requestsSent / requestsExpected) * 100) : undefined;
	const eta = computeEta({ requestsExpected, requestsSent, currentRps });

	return (
		<div className="bg-card border border-border rounded-md p-4 flex flex-col gap-1.5">
			<Eyebrow>
				Progress
				<InfoChip tip={TOOLTIPS.progress} />
			</Eyebrow>
			<div className="flex items-baseline gap-1 mt-0.5">
				<span className="text-[34px] font-bold leading-none font-mono tabular-nums text-foreground">
					{pct !== undefined ? pct.toFixed(0) : "—"}
				</span>
				<span className="text-xs text-muted-foreground">%</span>
			</div>
			<p className="text-[11px] text-muted-foreground font-mono mt-0.5">
				<span className="text-foreground font-semibold">{formatNumber(requestsSent)}</span>{" "}
				/{" "}
				<span className="text-foreground font-semibold">
					{formatNumber(requestsExpected)}
				</span>{" "}
				complete · ETA{" "}
				<span className="text-foreground font-semibold">
					{eta !== null ? eta.toFixed(0) : "—"}
				</span>
				s
			</p>
			{pct !== undefined && (
				<div className="relative mt-2 h-1 rounded-sm border border-border bg-accent overflow-hidden">
					<div
						className="absolute inset-y-0 left-0"
						style={{ width: `${pct}%`, background: "hsl(var(--primary))" }}
					/>
				</div>
			)}
		</div>
	);
}
