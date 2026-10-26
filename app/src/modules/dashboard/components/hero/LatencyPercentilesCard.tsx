/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { formatLatencyPartsOrDash } from "@/lib/format-number";
import { Eyebrow } from "../shared";
import { TOOLTIPS } from "../tooltips";
import { HeroCardShell } from "./HeroCardShell";

/**
 * Tail latency beside throughput for the modes whose stats row has no p99 of
 * its own (constant_rps, constant_concurrency, iterations): the first screen
 * answers "how fast, and how slow at the tail" without a scroll. Values cover
 * the run so far - the live tick's cumulative percentiles, or the final
 * report's once the run completes - so the mean and median beside the tail
 * describe the same population (issue #2385), not the last 100 ms.
 */
export function LatencyPercentilesCard({
	p95,
	p99,
	meanLatency,
	medianLatency,
}: {
	p95?: number;
	p99?: number;
	meanLatency?: number;
	medianLatency?: number;
}) {
	return (
		<HeroCardShell label="Latency" tip={TOOLTIPS.latencyPercentiles}>
			<div className="grid grid-cols-2 gap-4 items-end mt-1">
				<PercentileValue label="p95" ms={p95} />
				<PercentileValue label="p99" ms={p99} />
			</div>
			<TailSubLine p99={p99} meanLatency={meanLatency} medianLatency={medianLatency} />
		</HeroCardShell>
	);
}

/**
 * The mean and median beside the tail. A run that recorded no latency (`p99`
 * absent) has nothing to say; a live run with `p99` still 0 is waiting.
 */
function TailSubLine({
	p99,
	meanLatency,
	medianLatency,
}: {
	p99: number | undefined;
	meanLatency: number | undefined;
	medianLatency: number | undefined;
}) {
	if (p99 === undefined) return null;
	return (
		<p className="text-label text-muted-foreground font-mono mt-0.5">
			{p99 > 0 ? (
				<>
					mean <LatencyFigure ms={meanLatency} />
					{medianLatency !== undefined && medianLatency > 0 && (
						<>
							{" · "}median <LatencyFigure ms={medianLatency} />
						</>
					)}
				</>
			) : (
				<span className="italic">awaiting samples</span>
			)}
		</p>
	);
}

/** A mean or median inside the sub-line: the figure in the foreground, its unit beside it. */
function LatencyFigure({ ms }: { ms: number | undefined }) {
	const { value, unit } = formatLatencyPartsOrDash(ms);
	return (
		<>
			<span className="text-foreground font-semibold">{value}</span> {unit}
		</>
	);
}

function PercentileValue({ label, ms }: { label: string; ms: number | undefined }) {
	const { value, unit } = formatLatencyPartsOrDash(ms);
	return (
		<div>
			<div className="text-metric leading-none font-bold font-mono tabular-nums text-foreground">
				{value}
				<span className="text-xs text-muted-foreground font-sans font-normal ml-1">
					{unit}
				</span>
			</div>
			<Eyebrow size="xs" className="mt-1.5">
				{label}
			</Eyebrow>
		</div>
	);
}
