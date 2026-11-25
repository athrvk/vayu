/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { RunReport } from "@/types";
import { InfoChip } from "../shared";
import { TOOLTIPS } from "../tooltips";
import { formatCount, formatRate, pluralize } from "../../utils/format";
import { DurationValue } from "./PhasePercentiles";
import { StreamStat } from "./StreamStat";

/**
 * What a streaming load run's transfers delivered, from `report.stream` (issue #576). Renders
 * nothing when the section is absent, which is every run that did not stream: the engine omits it
 * rather than writing zeros, as a card reading "0 events/sec" would claim it measured one and found
 * none.
 *
 * Two rates on purpose: `eventsPerSecond` is the run's throughput and the per-completion
 * distribution its shape, and one long stream and 250 short ones can share a rate while being
 * completely different runs. The first-event row is its own figure, not Phase percentiles' First
 * byte row, which ends at the response headers, where a gateway that answers 200 at once and then
 * thinks reads fast (issue #3234). The row is absent when the report carries no `timeToFirstEvent`:
 * streams that delivered no timed event, not a first event that took 0ms.
 *
 * The first-match row (issue #3774) is the same clock stopped at the request's first content
 * marker, where a preamble API's first token shows; drawn only when the report carries
 * `timeToFirstMatch`, so a request declaring no marker looks as it did. Report-only: a live frame
 * carries no match.
 *
 * The max-gap and events/s rows (issue #3776) are each stream's own pacing, which the run's blended
 * rate cannot show: the largest pause between two events, and the stream's own rate. Each is drawn
 * only when the report carries it, independently of the others, since a stream whose events arrived
 * in one write measures neither. Report-only: the live panel has no such figure.
 */
export function StreamMetrics({ report }: { report: RunReport | null }) {
	const stream = report?.stream;
	if (!stream) {
		return null;
	}

	const {
		timeToFirstEvent: firstEvent,
		timeToFirstMatch: firstMatch,
		maxEventGap,
		eventRate,
	} = stream;

	// Every completion the caps ended rather than the server. All of them is not a failure: it is
	// the honest reading that this run measured its own bounds, and a user comparing two runs'
	// event totals needs to know that before reading them as a property of the target.
	const allCapped = stream.completions > 0 && stream.capped === stream.completions;

	return (
		<div className="space-y-2.5">
			<div className="grid grid-cols-3 gap-2.5">
				<StreamStat
					label="events/sec"
					value={formatCount(stream.eventsPerSecond, 1)}
					emphasis
				/>
				<StreamStat label="events" value={formatCount(stream.totalEvents)} />
				<StreamStat label="streams" value={formatCount(stream.completions)} />
			</div>

			<div className="grid grid-cols-[68px_repeat(4,1fr)] gap-2.5 pt-2.5 border-t border-dashed border-rule text-label text-muted-foreground">
				<span />
				<span className="text-right font-medium">p50</span>
				<span className="text-right font-medium">p95</span>
				<span className="text-right font-medium">p99</span>
				<span className="text-right font-medium">max</span>
			</div>
			<div className="grid grid-cols-[68px_repeat(4,1fr)] items-center gap-2.5">
				<span className="text-label text-muted-foreground flex items-center">
					per stream
					<InfoChip tip={TOOLTIPS.streamEvents} />
				</span>
				<EventValue value={stream.events.p50} />
				<EventValue value={stream.events.p95} />
				<EventValue value={stream.events.p99} emphasis />
				<EventValue value={stream.events.max} />
			</div>
			{firstEvent && (
				<div className="grid grid-cols-[68px_repeat(4,1fr)] items-center gap-2.5">
					<span className="text-label text-muted-foreground flex items-center">
						first event
						<InfoChip tip={TOOLTIPS.streamFirstEvent} />
					</span>
					<DurationValue value={firstEvent.p50} />
					<DurationValue value={firstEvent.p95} />
					<DurationValue value={firstEvent.p99} emphasis />
					<DurationValue value={firstEvent.max} />
				</div>
			)}
			{firstMatch && (
				<div className="grid grid-cols-[68px_repeat(4,1fr)] items-center gap-2.5">
					<span className="text-label text-muted-foreground flex items-center">
						first match
						<InfoChip tip={TOOLTIPS.streamFirstMatch} />
					</span>
					<DurationValue value={firstMatch.p50} />
					<DurationValue value={firstMatch.p95} />
					<DurationValue value={firstMatch.p99} emphasis />
					<DurationValue value={firstMatch.max} />
				</div>
			)}
			{maxEventGap && (
				<div className="grid grid-cols-[68px_repeat(4,1fr)] items-center gap-2.5">
					<span className="text-label text-muted-foreground flex items-center">
						max gap
						<InfoChip tip={TOOLTIPS.streamMaxEventGap} />
					</span>
					<DurationValue value={maxEventGap.p50} />
					<DurationValue value={maxEventGap.p95} />
					<DurationValue value={maxEventGap.p99} emphasis />
					<DurationValue value={maxEventGap.max} />
				</div>
			)}
			{eventRate && (
				<div className="grid grid-cols-[68px_repeat(4,1fr)] items-center gap-2.5">
					<span className="text-label text-muted-foreground flex items-center">
						events/s
						<InfoChip tip={TOOLTIPS.streamEventRate} />
					</span>
					<FigureCell text={formatRate(eventRate.p50)} />
					<FigureCell text={formatRate(eventRate.p95)} />
					<FigureCell text={formatRate(eventRate.p99)} emphasis />
					<FigureCell text={formatRate(eventRate.max)} />
				</div>
			)}

			{allCapped ? (
				<p className="text-label text-warning-text">
					Every stream was ended by a cap rather than by the server, so these counts
					measure the caps, not the target. Raise them to see further.
				</p>
			) : stream.capped > 0 ? (
				<p className="text-label text-muted-foreground">
					{formatCount(stream.capped)} of {formatCount(stream.completions)}{" "}
					{pluralize(stream.completions, "stream")}{" "}
					{pluralize(stream.capped, "was", "were")} ended by a cap
					{stream.capped < stream.completions
						? "; the rest were closed by the server."
						: "."}
				</p>
			) : (
				<p className="text-label text-muted-foreground">
					Every stream was closed by the server - no cap was reached.
				</p>
			)}
		</div>
	);
}

function EventValue({ value, emphasis }: { value: number; emphasis?: boolean }) {
	return <FigureCell text={formatCount(value)} emphasis={emphasis} />;
}

function FigureCell({ text, emphasis }: { text: string; emphasis?: boolean }) {
	return (
		<span className="text-right font-mono tabular-nums text-label">
			<span className={emphasis ? "text-foreground font-medium" : "text-foreground"}>
				{text}
			</span>
		</span>
	);
}
