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
 * Mirrors the dashboard TimingWaterfall's visual idiom (same --chart-* tokens),
 * but is driven by a single response's timing object rather than run averages.
 */

import { type ReactNode } from "react";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ResponseTiming } from "../../types";
import { TIMING } from "@/config/timing";

interface Phase {
	key: string;
	label: string;
	value: number;
	color: string;
	tip: ReactNode;
}

/** Tiny "i" affordance with a Radix tooltip (local to keep this tab self-contained). */
function InfoTip({ tip }: { tip: ReactNode }) {
	return (
		<TooltipProvider delayDuration={TIMING.TOOLTIP_DELAY_MS}>
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						className="ml-1 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-border bg-accent text-muted-foreground hover:border-primary/40 hover:bg-primary/10 hover:text-primary transition-colors cursor-help align-middle"
						aria-label="More information"
					>
						<Info className="h-2.5 w-2.5" />
					</button>
				</TooltipTrigger>
				<TooltipContent className="max-w-[260px] text-[11.5px] leading-relaxed">
					{tip}
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}

const fmtMs = (v: number): string =>
	v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);

export interface ResponseTimingTabProps {
	timing: ResponseTiming;
}

export default function ResponseTimingTab({ timing }: ResponseTimingTabProps) {
	const phases: Phase[] = [
		{
			key: "dns",
			label: "DNS",
			value: timing.dns,
			color: "hsl(var(--chart-2))",
			tip: "Hostname → IP resolution. Usually a few ms once cached; >50ms suggests slow DNS or a fresh lookup.",
		},
		{
			key: "connect",
			label: "Connect",
			value: timing.connect,
			color: "hsl(var(--chart-4))",
			tip: "TCP three-way handshake. Zero on connection reuse (HTTP keep-alive / HTTP/2).",
		},
		{
			key: "tls",
			label: "TLS",
			value: timing.tls,
			color: "hsl(var(--chart-5))",
			tip: "SSL/TLS handshake (HTTPS only). Zero for plain HTTP and on resumed connections.",
		},
		{
			key: "ttfb",
			label: "TTFB",
			value: timing.firstByte,
			color: "hsl(var(--primary))",
			tip: "Time to first byte — server processing + propagation. If this dominates, the bottleneck is the server, not the network.",
		},
		{
			key: "download",
			label: "Download",
			value: timing.download,
			color: "hsl(var(--success))",
			tip: "Response body transfer time. Large for big payloads or slow links; near-zero for small JSON.",
		},
	];

	// Bar segments are proportional to the network phases (which sum to ≈ wire).
	const phaseSum = phases.reduce((s, p) => s + Math.max(0, p.value), 0);
	const pct = (v: number) => (phaseSum > 0 ? (Math.max(0, v) / phaseSum) * 100 : 0);

	return (
		<div className="p-4 overflow-auto h-full">
			<p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground mb-3">
				Request timing
			</p>

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
						<span className="text-[12px] text-muted-foreground inline-flex items-center">
							{p.label}
							<InfoTip tip={p.tip} />
						</span>
						<span className="text-right font-mono tabular-nums text-[12px]">
							<span className="text-foreground">{fmtMs(p.value)}</span>
							<span className="text-subtle-foreground ml-0.5">ms</span>
						</span>
						<span className="text-right font-mono tabular-nums text-[11px] text-muted-foreground">
							{pct(p.value).toFixed(0)}%
						</span>
					</div>
				))}
			</div>

			{/* Summary: wire vs generator-side overhead vs perceived total. */}
			<div className="mt-3.5 pt-3 border-t border-dashed border-border flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[11px]">
				{timing.wire !== undefined && (
					<TimingStat
						label="Wire"
						value={timing.wire}
						tip="libcurl transfer time — DNS + connect + TLS + send + receive."
					/>
				)}
				{timing.queueWait !== undefined && (
					<TimingStat
						label="Queue"
						value={timing.queueWait}
						tip="Generator-side overhead (perceived − wire). Near-zero for a single request; grows under load."
					/>
				)}
				<TimingStat
					label="Total"
					value={timing.total}
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
				{fmtMs(value)}
				<span className="text-subtle-foreground ml-0.5">ms</span>
			</span>
		</span>
	);
}
