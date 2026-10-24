/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { formatLatency, formatRate } from "@/lib/format-number";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { InfoChip, Eyebrow } from "../shared";
import { fmtRate } from "../format";
import { TOOLTIPS } from "../tooltips";
import type { DispatchStatus } from "../../utils/dispatchLag";
import type { ReceivedWindow } from "../../types";

/** An absent window is the live card, whose figure is the run-cumulative rate and keeps the plain word. */
const RECEIVED_CAPTION: Record<ReceivedWindow, string> = {
	sending: "received while sending",
	wholeRun: "received, whole run",
};

const STATUS_CHIP: Record<DispatchStatus, { chip: string; sentence: string }> = {
	settling: { chip: "bg-muted text-muted-foreground", sentence: "still measuring the gap" },
	"kept-pace": {
		chip: "bg-success/10 text-success-text",
		sentence: "server kept pace with dispatch",
	},
	lagging: {
		chip: "bg-destructive/10 text-destructive-text",
		sentence: "server is lagging dispatch",
	},
};

/**
 * constant_rps hero card #2 - twin send/throughput rates from the open model.
 * The chip's verdict arrives decided (`utils/dispatchLag.ts`) on a pair its
 * producer chose, which is not the pair printed here: the card only draws, and
 * without a `status` it draws no chip.
 */
export function ThroughputTwinCard({
	sendRate,
	throughput,
	receivedWindow,
	status,
	avgQueueWaitMs,
}: {
	sendRate?: number;
	throughput?: number;
	/** What `throughput` was measured over; absent on the live card. */
	receivedWindow?: ReceivedWindow;
	status?: DispatchStatus;
	avgQueueWaitMs?: number;
}) {
	const showQueueChip = avgQueueWaitMs !== undefined && avgQueueWaitMs > 5;
	const delta =
		sendRate !== undefined && throughput !== undefined
			? Math.max(0, sendRate - throughput)
			: undefined;

	return (
		<Card pad="md" className="flex flex-col gap-1.5">
			<Eyebrow>
				Send · Throughput
				<InfoChip tip={TOOLTIPS.sendThroughput} />
				{showQueueChip && (
					<span className="ml-2 inline-flex items-center normal-case tracking-normal font-mono text-micro font-semibold px-1.5 py-px rounded-sm bg-warning/10 text-warning-text">
						queue {formatLatency(avgQueueWaitMs)}
						<InfoChip tip={TOOLTIPS.queueChip} />
					</span>
				)}
			</Eyebrow>
			<div className="grid grid-cols-2 gap-4 items-end mt-1">
				<div>
					<div className="text-metric leading-none font-bold font-mono tabular-nums text-foreground">
						{fmtRate(sendRate)}
						<span className="text-xs text-muted-foreground font-sans font-normal ml-1">
							req/s
						</span>
					</div>
					<Eyebrow size="xs" className="mt-1.5">
						dispatched
						<InfoChip tip={TOOLTIPS.sendThroughputDispatched} />
					</Eyebrow>
				</div>
				<div>
					<div className="text-metric leading-none font-bold font-mono tabular-nums text-foreground">
						{fmtRate(throughput)}
						<span className="text-xs text-muted-foreground font-sans font-normal ml-1">
							req/s
						</span>
					</div>
					<Eyebrow size="xs" className="mt-1.5">
						{receivedWindow === undefined
							? "received"
							: RECEIVED_CAPTION[receivedWindow]}
						<InfoChip tip={TOOLTIPS.sendThroughputReceived} />
					</Eyebrow>
				</div>
			</div>
			{delta !== undefined && status !== undefined && (
				<p className="text-label text-muted-foreground mt-2 flex items-center gap-2">
					<span
						className={cn(
							"inline-block px-1.5 py-px rounded-sm font-mono text-micro font-semibold transition-colors duration-150",
							STATUS_CHIP[status].chip
						)}
					>
						Δ {formatRate(delta)} req/s
					</span>
					<span>{STATUS_CHIP[status].sentence}</span>
				</p>
			)}
		</Card>
	);
}
