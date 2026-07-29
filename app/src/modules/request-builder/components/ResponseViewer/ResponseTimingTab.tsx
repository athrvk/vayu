/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ResponseTimingTab Component
 *
 * Per-request timing breakdown for a single (design-mode) response. The five
 * network phases (DNS → Connect → TLS → TTFB → Download) are sequential, so
 * they render as one continuous timeline track with proportional segments,
 * followed by a precise legend and a Wire · Queue · Total summary.
 *
 * **Every phase is a fixed categorical hue**, and the list of them - label,
 * hue, tooltip, the field each one reads - now comes from `TIMING_PHASES` in
 * `shared/response-viewer/timing-phases.ts` rather than being declared here.
 * Two hues were once wrong in this file: TTFB took `--primary` and Download
 * took `--success`. `--primary` tracks the user's accent, which the design
 * system forbids for a chart series precisely because of what happened here -
 * under the green scheme `--primary` is hue 142 and `--success` is hue 142,
 * three points of lightness apart, so two of the five phases rendered as the
 * same swatch. Under the default orange, TTFB sat 14 degrees from Connect's
 * amber. `--success` was the second problem on its own terms: a status token
 * spent on a series that has no status.
 *
 * They are `--chart-3` (violet) and `--chart-6` (moss). `--chart-6` was added
 * for this - the set had four fixed hues and this chart needs five. Fixing it
 * here left the dashboard's `TimingWaterfall` painting the same two phases the
 * same wrong way for as long as the two lists were separate, which is the
 * argument for the shared descriptor.
 *
 * Mirrors the dashboard TimingWaterfall's visual idiom (same --chart-* tokens),
 * but is driven by a single response's timing object rather than run averages.
 */

import { type ReactNode } from "react";
import { formatDuration, formatPhaseDuration } from "@/components/shared/response-viewer/utils";
import { phaseColor, phasesFromTrace } from "@/components/shared/response-viewer/timing-phases";
import { Eyebrow, InfoChip } from "@/components/ui";
import type { ResponseTiming } from "../../types";

/**
 * `border-rule`, not the chip's default `border-border`. This tab sits inside a
 * pane that declares `surface-card`, and on a card `--border` is the same
 * colour as `--card` in dark - so the dot had no outline in one theme. `ml-1`
 * rather than the default `ml-1.5` keeps the legend rows tight.
 */
const TIP_CLASS = "ml-1 border-rule";

export interface ResponseTimingTabProps {
	timing: ResponseTiming;
}

export default function ResponseTimingTab({ timing }: ResponseTimingTabProps) {
	const phases = phasesFromTrace(timing);

	// Bar segments are proportional to the network phases (which sum to ≈ wire).
	const phaseSum = phases.reduce((s, p) => s + Math.max(0, p.value), 0);
	const pct = (v: number) => (phaseSum > 0 ? (Math.max(0, v) / phaseSum) * 100 : 0);

	return (
		<div className="p-4 overflow-auto h-full">
			<Eyebrow className="mb-3">Request timing</Eyebrow>

			{/* Continuous timeline: each phase is a sequential segment of the request. */}
			<div className="flex h-2.5 w-full overflow-hidden rounded-sm bg-accent">
				{phases.map((p) => (
					<span
						key={p.key}
						className="block h-full transition-[width] duration-300"
						style={{
							width: `${pct(p.value)}%`,
							background: phaseColor(p),
							boxShadow: "inset -1px 0 0 hsl(var(--card))",
						}}
						aria-hidden
					/>
				))}
			</div>

			{/* Legend: color swatch · phase · value · share of network time. */}
			<div className="mt-3.5 space-y-1.5">
				{phases.map((p) => (
					<div
						key={p.key}
						className="grid grid-cols-[10px_1fr_auto_46px] items-center gap-2.5"
					>
						<span
							className="h-2.5 w-2.5 rounded-sm"
							style={{ background: phaseColor(p) }}
							aria-hidden
						/>
						<span className="text-xs text-muted-foreground inline-flex items-center">
							{p.label}
							<InfoChip tip={p.tip} className={TIP_CLASS} />
						</span>
						<span className="text-right font-mono tabular-nums text-xs">
							<span className="text-foreground">
								{formatPhaseDuration(p.value).value}
							</span>
							<span className="text-subtle-foreground ml-0.5">
								{formatPhaseDuration(p.value).unit}
							</span>
						</span>
						<span className="text-right font-mono tabular-nums text-[11px] text-muted-foreground">
							{pct(p.value).toFixed(0)}%
						</span>
					</div>
				))}
			</div>

			{/* Summary: wire vs generator-side overhead vs perceived total. */}
			<div className="mt-3.5 pt-3 border-t border-dashed border-rule flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[11px]">
				{timing.wireMs !== undefined && (
					<TimingStat
						label="Wire"
						value={timing.wireMs}
						tip="libcurl transfer time - DNS + connect + TLS + send + receive."
					/>
				)}
				{timing.queueWaitMs !== undefined && (
					<TimingStat
						label="Queue"
						value={timing.queueWaitMs}
						tip="Generator-side overhead (perceived − wire). Near-zero for a single request; grows under load."
					/>
				)}
				<TimingStat
					label="Total"
					value={timing.totalMs}
					tip="Perceived latency: submit → completion. What the response header shows."
					emphasized
				/>
			</div>
		</div>
	);
}

function TimingStat({
	label,
	value,
	tip,
	emphasized = false,
}: {
	label: string;
	value: number;
	tip: ReactNode;
	emphasized?: boolean;
}) {
	return (
		<span className="inline-flex items-center gap-1.5">
			<span className="text-muted-foreground inline-flex items-center">
				{label}
				<InfoChip tip={tip} className={TIP_CLASS} />
			</span>
			<span
				className={
					emphasized
						? "font-mono tabular-nums font-semibold text-foreground"
						: "font-mono tabular-nums text-foreground"
				}
			>
				{formatDuration(value).value}
				<span className="text-subtle-foreground ml-0.5">{formatDuration(value).unit}</span>
			</span>
		</span>
	);
}
