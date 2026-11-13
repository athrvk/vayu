/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a streaming load run has delivered so far (issue #3236), between the
 * hero row and the charts: events received, events per second now, the streams
 * open and, once one has finished and delivered an event, the time to first
 * event - with the rate on the run's timeline below.
 *
 * Rendered only for a run whose frames carry `stream_events`
 * (`utils/liveStream.ts`), so an ordinary load run never shows a "0 events/sec"
 * it did not measure. A figure the frame lacks gets no tile, never a `0`.
 * `firstEvent` is the latest gate frame's block, so this panel does not flicker
 * between the gates that carry it.
 */

import { memo } from "react";
import { Card } from "@/components/ui/card";
import type { LoadTestMetrics, StreamTimeToFirstEvent } from "@/types";
import { formatPhaseDuration } from "@/components/shared/response-viewer/utils";
import { formatCount } from "../utils/format";
import { InfoChip } from "./shared";
import { TOOLTIPS } from "./tooltips";
import { StreamStat } from "./charts/StreamStat";
import { CHART_SYNC, StreamRateChart } from "./charts/uplot";

interface LiveStreamPanelProps {
	/** The latest frame: the cumulative figures are read from it. */
	metrics: Pick<LoadTestMetrics, "stream_events" | "events_per_second" | "streams_open">;
	history: LoadTestMetrics[];
	firstEvent?: StreamTimeToFirstEvent;
}

function duration(ms: number): string {
	const { value, unit } = formatPhaseDuration(ms);
	return `${value}${unit}`;
}

function LiveStreamPanel({ metrics, history, firstEvent }: LiveStreamPanelProps) {
	const { stream_events, events_per_second, streams_open } = metrics;
	return (
		<Card pad="sm" className="min-w-0 flex flex-col gap-3">
			<h2 className="text-xs font-semibold text-foreground">
				Stream events
				<InfoChip tip={TOOLTIPS.liveStream} />
			</h2>
			<div className="grid grid-cols-2 @2xl:grid-cols-4 gap-2.5">
				{stream_events !== undefined && (
					<StreamStat label="events so far" value={formatCount(stream_events)} />
				)}
				{events_per_second !== undefined && (
					<StreamStat
						label="events/sec"
						value={formatCount(events_per_second, 1)}
						emphasis
					/>
				)}
				{streams_open !== undefined && (
					<StreamStat label="streams open" value={formatCount(streams_open)} />
				)}
				{firstEvent && (
					<StreamStat
						label={
							<>
								first event p50 / p95
								<InfoChip tip={TOOLTIPS.liveStreamFirstEvent} />
							</>
						}
						value={`${duration(firstEvent.p50)} / ${duration(firstEvent.p95)}`}
					/>
				)}
			</div>
			<StreamRateChart history={history} syncKey={CHART_SYNC.live} />
		</Card>
	);
}

export default memo(LiveStreamPanel);
