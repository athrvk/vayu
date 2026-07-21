/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { cn } from "@/lib/utils";
import { InfoChip, Eyebrow, fmt } from "../shared";
import { TOOLTIPS } from "../tooltips";

/** constant_rps hero card #2 — twin send/throughput rates from the open model. */
export function ThroughputTwinCard({
	sendRate,
	throughput,
	avgQueueWaitMs,
}: {
	sendRate?: number;
	throughput?: number;
	avgQueueWaitMs?: number;
}) {
	const showQueueChip = avgQueueWaitMs !== undefined && avgQueueWaitMs > 5;
	const delta =
		sendRate !== undefined && throughput !== undefined
			? Math.max(0, sendRate - throughput)
			: undefined;
	const deltaOk = delta !== undefined && delta < 1;

	return (
		<div className="bg-card border border-border rounded-md p-4 flex flex-col gap-1.5">
			<Eyebrow>
				Send · Throughput
				<InfoChip tip={TOOLTIPS.sendThroughput} />
				{showQueueChip && (
					<span className="ml-2 inline-flex items-center normal-case tracking-normal font-mono text-[10px] font-bold px-1.5 py-px rounded-sm bg-warning/10 text-warning-text">
						queue {avgQueueWaitMs.toFixed(0)}ms
						<InfoChip tip={TOOLTIPS.queueChip} />
					</span>
				)}
			</Eyebrow>
			<div className="grid grid-cols-2 gap-4 items-end mt-1">
				<div>
					<div className="text-[24px] leading-none font-bold font-mono tabular-nums text-foreground">
						{fmt(sendRate, 1)}
						<span className="text-xs text-muted-foreground font-sans font-normal ml-1">
							req/s
						</span>
					</div>
					<div className="text-[10px] uppercase tracking-[0.06em] text-muted-foreground mt-1.5">
						dispatched
						<InfoChip tip={TOOLTIPS.sendThroughputDispatched} />
					</div>
				</div>
				<div>
					<div className="text-[24px] leading-none font-bold font-mono tabular-nums text-foreground">
						{fmt(throughput, 1)}
						<span className="text-xs text-muted-foreground font-sans font-normal ml-1">
							req/s
						</span>
					</div>
					<div className="text-[10px] uppercase tracking-[0.06em] text-muted-foreground mt-1.5">
						received
						<InfoChip tip={TOOLTIPS.sendThroughputReceived} />
					</div>
				</div>
			</div>
			{delta !== undefined && (
				<p className="text-[11px] text-muted-foreground mt-2 flex items-center gap-2">
					<span
						className={cn(
							"inline-block px-1.5 py-px rounded-sm font-mono text-[10px] font-bold",
							deltaOk
								? "bg-success/10 text-success-text"
								: "bg-destructive/10 text-destructive-text"
						)}
					>
						Δ {delta.toFixed(1)}
					</span>
					<span>
						{deltaOk ? "server kept pace with dispatch" : "server is lagging dispatch"}
					</span>
				</p>
			)}
		</div>
	);
}
