/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { RunReport } from "@/types";
import { InfoChip } from "../shared";
import { TOOLTIPS } from "../tooltips";

/**
 * What a streaming load run's transfers delivered - from `report.stream`
 * (issue #576).
 *
 * Renders nothing at all when the section is absent, which is every run that
 * did not stream. That is the whole reason the engine omits the section rather
 * than writing zeros: an ordinary load run has no event rate, and a card
 * reading "0 events/sec" would claim it measured one and found none.
 *
 * Two rates, deliberately. `eventsPerSecond` is the run's throughput and the
 * per-completion distribution is its shape, and one long stream and 250 short
 * ones can share a rate while being completely different runs. Time-to-first-
 * event is not repeated here: it *is* the First byte row of Phase percentiles,
 * since a stream's first byte is its first event's - a second copy would be a
 * second number to keep true.
 */
export function StreamMetrics({ report }: { report: RunReport | null }) {
	const stream = report?.stream;
	if (!stream) {
		return null;
	}

	// Every completion the caps ended rather than the server. All of them is
	// not a failure - it is the honest reading that this run measured its own
	// bounds, and a user comparing two runs' event totals needs to know that
	// before reading them as a property of the target.
	const allCapped = stream.completions > 0 && stream.capped === stream.completions;

	return (
		<div className="space-y-2.5">
			<div className="grid grid-cols-3 gap-2.5">
				<StreamStat
					label="events/sec"
					value={fmtCount(stream.eventsPerSecond, 1)}
					emphasis
				/>
				<StreamStat label="events" value={fmtCount(stream.totalEvents)} />
				<StreamStat label="streams" value={fmtCount(stream.completions)} />
			</div>

			<div className="grid grid-cols-[68px_repeat(4,1fr)] gap-2.5 pt-2.5 border-t border-dashed border-border text-[11px] text-muted-foreground">
				<span />
				<span className="text-right font-medium">p50</span>
				<span className="text-right font-medium">p95</span>
				<span className="text-right font-medium">p99</span>
				<span className="text-right font-medium">max</span>
			</div>
			<div className="grid grid-cols-[68px_repeat(4,1fr)] items-center gap-2.5">
				<span className="text-[11px] text-muted-foreground flex items-center">
					per stream
					<InfoChip tip={TOOLTIPS.streamEvents} />
				</span>
				<EventValue value={stream.events.p50} />
				<EventValue value={stream.events.p95} />
				<EventValue value={stream.events.p99} emphasis />
				<EventValue value={stream.events.max} />
			</div>

			{allCapped ? (
				<p className="text-[11px] text-warning-text">
					Every stream was ended by a cap rather than by the server, so these counts
					measure the caps, not the target. Raise them to see further.
				</p>
			) : stream.capped > 0 ? (
				<p className="text-[11px] text-muted-foreground">
					{fmtCount(stream.capped)} of {fmtCount(stream.completions)} streams were ended
					by a cap; the rest were closed by the server.
				</p>
			) : (
				<p className="text-[11px] text-muted-foreground">
					Every stream was closed by the server - no cap was reached.
				</p>
			)}
		</div>
	);
}

/** Counts, not milliseconds - `fmt` elsewhere in the dashboard means latency. */
function fmtCount(value: number, decimals = 0): string {
	if (!Number.isFinite(value)) return "-";
	return value.toLocaleString(undefined, {
		minimumFractionDigits: decimals,
		maximumFractionDigits: decimals,
	});
}

function StreamStat({
	label,
	value,
	emphasis,
}: {
	label: string;
	value: string;
	emphasis?: boolean;
}) {
	return (
		<div>
			<div
				className={
					emphasis
						? "text-sm font-semibold text-foreground font-mono tabular-nums"
						: "text-sm text-foreground font-mono tabular-nums"
				}
			>
				{value}
			</div>
			<div className="text-[10px] text-muted-foreground">{label}</div>
		</div>
	);
}

function EventValue({ value, emphasis }: { value: number; emphasis?: boolean }) {
	return (
		<span className="text-right font-mono tabular-nums text-[11px]">
			<span className={emphasis ? "text-foreground font-medium" : "text-foreground"}>
				{fmtCount(value)}
			</span>
		</span>
	);
}
