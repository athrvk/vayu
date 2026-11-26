/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One design-mode response's timing breakdown. The five network phases (DNS → Connect → TLS → TTFB
 * → Download) are sequential, so one continuous track with proportional segments, then a legend and
 * a Wire · Queue · Vayu · Scripts · Total summary. The dashboard `TimingWaterfall`'s idiom (the
 * same `--chart-*` tokens), from one response's timing rather than run averages.
 *
 * **Every phase is a fixed categorical hue** from `TIMING_PHASES`
 * (`shared/response-viewer/timing-phases.ts`), shared with the dashboard so the two lists cannot
 * diverge. TTFB is `--chart-3` (violet), Download `--chart-6` (moss, added since four fixed hues
 * were too few). Not `--primary`: it tracks the user's accent, and under the green scheme it equals
 * `--success`'s hue 142 three lightness points apart, two phases one swatch (under orange, 14
 * degrees from Connect's amber). Not `--success`: a status token on a series with no status.
 */

import { type ReactNode } from "react";
import {
	ENGINE_COST_TIP,
	SCRIPT_TIME_TIP,
	formatDuration,
	formatPhaseDuration,
	isReportedMs,
} from "@/components/shared/response-viewer/utils";
import { phaseColor, phasesFromTrace } from "@/components/shared/response-viewer/timing-phases";
import { Eyebrow, InfoChip } from "@/components/ui";
import { formatFixed } from "@/lib/format-number";
import { pluralize } from "@/modules/dashboard/utils/format";
import type { RedirectHop } from "@/types/domain";
import type { ResponseTiming } from "../../types";

/**
 * `border-rule`, not the chip's `border-border`: in this `surface-card` pane `--border` equals
 * `--card` in dark, leaving the dot unoutlined. `ml-1`, not `ml-1.5`, keeps legend rows tight.
 */
const TIP_CLASS = "ml-1 border-rule";

/**
 * The engine adds each followed hop's libcurl timers into the phase fields (`add_phase_times`), so
 * after a redirect TTFB sums the waits at every server, which the shared `PHASE_TIPS.ttfb` ("the
 * server") misdescribes. Kept here; the dashboard and history keep the shared tip for single
 * requests.
 */
const SUMMED_TTFB_TIP =
	"Time to first byte, summed over every request in the redirect chain - server processing + propagation at each hop. It is not one server's wait.";

const FIRST_EVENT_TIP =
	"Time from the send until the first event of the stream arrived. TTFB above is when the response headers did, which for a stream comes long before the first event.";

export interface ResponseTimingTabProps {
	timing: ResponseTiming;
	/** The hops followed before the final response; their phases are in `timing`. */
	redirects?: RedirectHop[];
	/**
	 * A stream's first event, ms after the send (#3775); absent without an event or a known send
	 * time. A stream's TTFB is when headers arrived, saying nothing about the first token.
	 */
	firstEventMs?: number;
}

/** One request per followed redirect, plus the one that answered finally. */
function summedPhasesNote(redirectCount: number): string {
	return `Phases are summed over ${redirectCount + 1} requests: ${redirectCount} ${pluralize(redirectCount, "redirect")} and the final response.`;
}

export default function ResponseTimingTab({
	timing,
	redirects,
	firstEventMs,
}: ResponseTimingTabProps) {
	const redirectCount = redirects?.length ?? 0;
	const summed = redirectCount > 0;
	const phases = phasesFromTrace(timing).map((p) =>
		summed && p.key === "ttfb" ? { ...p, tip: SUMMED_TTFB_TIP } : p
	);

	// Segments are proportional to the network phases, which sum to about wire time.
	const phaseSum = phases.reduce((s, p) => s + Math.max(0, p.value), 0);
	const pct = (v: number) => (phaseSum > 0 ? (Math.max(0, v) / phaseSum) * 100 : 0);

	return (
		<div className="p-4 overflow-auto h-full">
			<Eyebrow className="mb-3">Request timing</Eyebrow>
			{summed && (
				<p className="mb-3 text-label text-muted-foreground">
					{summedPhasesNote(redirectCount)}
				</p>
			)}

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
						<span className="text-right font-mono tabular-nums text-label text-muted-foreground">
							{formatFixed(pct(p.value), 0)}%
						</span>
					</div>
				))}
			</div>

			<div className="mt-3.5 pt-3 border-t border-dashed border-rule flex flex-wrap items-center gap-x-5 gap-y-1.5 text-label">
				{timing.wireMs !== undefined && (
					<TimingStat
						label="Wire time"
						value={timing.wireMs}
						tip="libcurl transfer time - DNS + connect + TLS + send + receive."
					/>
				)}
				{timing.queueWaitMs !== undefined && (
					<TimingStat
						label="Queue"
						value={timing.queueWaitMs}
						tip="Time before the wire - generator queue and any wait for a connection slot (perceived − wire). Near-zero for a single request; grows under load."
					/>
				)}
				{isReportedMs(timing.engineMs) && (
					<TimingStat label="Vayu" value={timing.engineMs} tip={ENGINE_COST_TIP} />
				)}
				{isReportedMs(timing.scriptMs) && (
					<TimingStat label="Scripts" value={timing.scriptMs} tip={SCRIPT_TIME_TIP} />
				)}
				{firstEventMs !== undefined && (
					<TimingStat label="First event" value={firstEventMs} tip={FIRST_EVENT_TIP} />
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
