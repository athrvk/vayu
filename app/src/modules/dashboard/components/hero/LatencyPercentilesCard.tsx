/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { formatMs } from "@/lib/format-number";
import { Eyebrow } from "../shared";
import { TOOLTIPS } from "../tooltips";
import { HeroCardShell } from "./HeroCardShell";

/**
 * Tail latency beside throughput for the modes whose stats row has no p99 of
 * its own (constant_rps, constant_concurrency, iterations): the first screen
 * answers "how fast, and how slow at the tail" without a scroll. Values are the
 * live tick's percentiles, or the final report's once the run completes.
 */
export function LatencyPercentilesCard({
	p95,
	p99,
	meanLatency,
	medianLatency,
}: {
	p95: number;
	p99: number;
	meanLatency: number;
	medianLatency: number;
}) {
	return (
		<HeroCardShell label="Latency" tip={TOOLTIPS.latencyPercentiles}>
			<div className="grid grid-cols-2 gap-4 items-end mt-1">
				<PercentileValue label="p95" ms={p95} />
				<PercentileValue label="p99" ms={p99} />
			</div>
			<p className="text-label text-muted-foreground font-mono mt-0.5">
				{p99 > 0 ? (
					<>
						mean{" "}
						<span className="text-foreground font-semibold">
							{formatMs(meanLatency)}
						</span>{" "}
						ms
						{medianLatency > 0 && (
							<>
								{" · "}median{" "}
								<span className="text-foreground font-semibold">
									{formatMs(medianLatency)}
								</span>{" "}
								ms
							</>
						)}
					</>
				) : (
					<span className="italic">awaiting samples</span>
				)}
			</p>
		</HeroCardShell>
	);
}

function PercentileValue({ label, ms }: { label: string; ms: number }) {
	return (
		<div>
			<div className="text-metric leading-none font-bold font-mono tabular-nums text-foreground">
				{formatMs(ms)}
				<span className="text-xs text-muted-foreground font-sans font-normal ml-1">ms</span>
			</div>
			<Eyebrow size="xs" className="mt-1.5">
				{label}
			</Eyebrow>
		</div>
	);
}
