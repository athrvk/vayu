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
 * **Every phase is a fixed categorical hue.** Two were not: TTFB took
 * `--primary` and Download took `--success`. `--primary` tracks the user's
 * accent, which the design system forbids for a chart series precisely because
 * of what happened here - under the green scheme `--primary` is hue 142 and
 * `--success` is hue 142, three points of lightness apart, so two of the five
 * phases rendered as the same swatch. Under the default orange, TTFB sat 14
 * degrees from Connect's amber. `--success` was the second problem on its own
 * terms: a status token spent on a series that has no status.
 *
 * They are `--chart-3` (violet) and `--chart-6` (moss) now. `--chart-6` was
 * added for this - the set had four fixed hues and this chart needs five.
 *
 * Mirrors the dashboard TimingWaterfall's visual idiom (same --chart-* tokens),
 * but is driven by a single response's timing object rather than run averages.
 */

import { type ReactNode } from "react";
import { formatDuration, formatPhaseDuration } from "@/components/shared/response-viewer/utils";
import { PHASE_TIPS } from "@/components/shared/response-viewer/phase-tips";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Eyebrow } from "@/components/ui";
import type { ResponseTiming } from "../../types";

interface Phase {
	key: string;
	label: string;
	value: number;
	color: string;
	tip: ReactNode;
}

/**
 * Tiny "i" affordance with a Radix tooltip.
 *
 * Hand-rolled rather than `TooltipIconButton`: that primitive's icon-size
 * `Button` would dwarf a 14px dot. Same treatment as the GraphQL schema-refresh
 * control, for the same reason.
 *
 * No `TooltipProvider` of its own. It had one *inside* this component, so a
 * five-phase timing tab mounted five of them; the delay is set once at the app
 * root (main.tsx) now, so even one here would only re-declare what it inherits.
 *
 * `border-rule`, not `border-border`. This tab sits inside a pane that declares
 * `surface-card`, and on a card `--border` is the same colour as `--card` in
 * dark - so the dot had no outline in one theme.
 */
function InfoTip({ tip }: { tip: ReactNode }) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					className="ml-1 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-rule bg-accent text-muted-foreground hover:border-primary/40 hover:bg-primary/10 hover:text-primary transition-colors cursor-help align-middle"
					aria-label="More information"
				>
					<Info className="h-2.5 w-2.5" />
				</button>
			</TooltipTrigger>
			<TooltipContent className="max-w-[260px] text-[11px] leading-relaxed">
				{tip}
			</TooltipContent>
		</Tooltip>
	);
}

export interface ResponseTimingTabProps {
	timing: ResponseTiming;
}

export default function ResponseTimingTab({ timing }: ResponseTimingTabProps) {
	const phases: Phase[] = [
		{
			key: "dns",
			label: "DNS",
			value: timing.dnsMs,
			color: "hsl(var(--chart-2))",
			tip: PHASE_TIPS.dns,
		},
		{
			key: "connect",
			label: "Connect",
			value: timing.connectMs,
			color: "hsl(var(--chart-4))",
			tip: PHASE_TIPS.connect,
		},
		{
			key: "tls",
			label: "TLS",
			value: timing.tlsMs,
			color: "hsl(var(--chart-5))",
			tip: PHASE_TIPS.tls,
		},
		{
			key: "ttfb",
			label: "TTFB",
			value: timing.firstByteMs,
			color: "hsl(var(--chart-3))",
			tip: PHASE_TIPS.ttfb,
		},
		{
			key: "download",
			label: "Download",
			value: timing.downloadMs,
			color: "hsl(var(--chart-6))",
			tip: PHASE_TIPS.download,
		},
	];

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
							background: p.color,
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
							style={{ background: p.color }}
							aria-hidden
						/>
						<span className="text-xs text-muted-foreground inline-flex items-center">
							{p.label}
							<InfoTip tip={p.tip} />
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
				<InfoTip tip={tip} />
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
