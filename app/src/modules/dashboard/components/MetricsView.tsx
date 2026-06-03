/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * MetricsView
 *
 * Layout (top to bottom):
 *   1. Hero row    — Rate Fidelity · Send/Throughput · Error Rate w/ status stack
 *   2. Main chart  — Throughput over time (send + throughput + target ref)
 *   3. Sub-row     — HDR percentile plot · Avg request timing waterfall
 *   4. Stat row    — Duration · Total requests · Peak concurrency · Avg latency
 *
 * Each metric label carries an info tooltip (Radix-based) explaining what it
 * means — the audience is developers running load tests.
 */

import { memo, useMemo, type ReactNode } from "react";
import { Activity } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/utils";
import type { RunReport } from "@/types";
import type { MetricsViewProps } from "../types";
import { InfoChip, Eyebrow, EYEBROW_CLASS } from "./shared";
import { DroppedRequestsCard } from "./DroppedRequestsCard";
import {
	isRateLimitedRun,
	buildLatencyChartData,
	buildRampOverlay,
	buildPercentileChartData,
	type RampOverlay,
} from "../utils/metricsTransforms";
import { niceYMax, projectY } from "../utils/chartGeometry";
import { LatencyOverTimeChart } from "./LatencyOverTimeChart";
import { PercentilesOverTimeChart } from "./PercentilesOverTimeChart";

// ============================================================================
// Formatting helpers
// ============================================================================

/** Format a possibly-undefined number, falling back to an em-dash. */
function fmt(v: number | undefined, digits = 1): string {
	return v !== undefined ? v.toFixed(digits) : "—";
}

/** Rate-fidelity tier coloring: ≥95% success, ≥80% warning, else destructive. */
function fidelityColor(achievement: number | undefined): string {
	if (achievement === undefined) return "hsl(var(--muted-foreground))";
	if (achievement >= 95) return "hsl(var(--success))";
	if (achievement >= 80) return "hsl(var(--warning))";
	return "hsl(var(--destructive))";
}

// ============================================================================
// Shared SVG geometry — HDR plot + skeleton must stay dimensionally identical
// (that's the whole point of the skeleton state — no layout shift on completion).
// ============================================================================

const HDR_DIMS = { VW: 600, VH: 200, PL: 48, PR: 8, PT: 22, PB: 22 } as const;
const HDR_X_MARKS: Array<{ pct: number; label: string }> = [
	{ pct: 0, label: "0%" },
	{ pct: 50, label: "50%" },
	{ pct: 90, label: "90%" },
	{ pct: 95, label: "95%" },
	{ pct: 99, label: "99%" },
	{ pct: 99.9, label: "99.9%" },
];

// ============================================================================
// Hero cards
// ============================================================================

function RateFidelityCard({ targetRps, actualRps }: { targetRps?: number; actualRps?: number }) {
	const achievement =
		targetRps && targetRps > 0 && actualRps !== undefined
			? (actualRps / targetRps) * 100
			: undefined;
	const color = fidelityColor(achievement);

	return (
		<div className="bg-card border border-border rounded-md p-4 flex flex-col gap-1.5">
			<Eyebrow>
				Rate Fidelity
				<InfoChip
					tip={
						<>
							How closely actual throughput tracked the target RPS. 100% = the engine
							hit the target exactly. Below ~95% means the engine couldn&apos;t keep
							up — either CPU-bound locally or the server is backpressuring.
						</>
					}
				/>
			</Eyebrow>
			<div className="flex items-baseline gap-1 mt-0.5">
				<span
					className="text-[34px] font-bold leading-none font-mono tabular-nums"
					style={{ color }}
				>
					{fmt(achievement, 1)}
				</span>
				<span className="text-xs text-muted-foreground">%</span>
			</div>
			<p className="text-[11px] text-muted-foreground font-mono mt-0.5">
				target <span className="text-foreground font-semibold">{fmt(targetRps, 1)}</span> ·
				actual <span className="text-foreground font-semibold">{fmt(actualRps, 2)}</span>{" "}
				req/s
			</p>
			{achievement !== undefined && targetRps && (
				<div className="relative mt-2 h-1 rounded-sm border border-border bg-accent overflow-hidden">
					<div
						className="absolute inset-y-0 left-0"
						style={{
							width: `${Math.min(100, achievement)}%`,
							background: color,
						}}
					/>
					<span
						className="absolute top-[-3px] bottom-[-3px] w-px bg-primary"
						style={{ left: "100%" }}
					/>
				</div>
			)}
		</div>
	);
}

function ThroughputTwinCard({ sendRate, throughput }: { sendRate?: number; throughput?: number }) {
	const delta =
		sendRate !== undefined && throughput !== undefined
			? Math.max(0, sendRate - throughput)
			: undefined;
	const deltaOk = delta !== undefined && delta < 1;

	return (
		<div className="bg-card border border-border rounded-md p-4 flex flex-col gap-1.5">
			<Eyebrow>
				Send · Throughput
				<InfoChip
					tip={
						<>
							Twin rates from the open-model load generator. <b>Send</b> = requests
							dispatched onto the wire; <b>Throughput</b> = responses received. A
							persistent gap means server-side saturation — the request queue
							(backpressure) grows.
						</>
					}
				/>
			</Eyebrow>
			<div className="grid grid-cols-2 gap-4 items-end mt-1">
				<div>
					<div className="text-[24px] leading-none font-bold font-mono tabular-nums text-foreground">
						{fmt(sendRate, 1)}
						<span className="text-xs text-muted-foreground font-sans font-normal ml-1">
							req/s
						</span>
					</div>
					<div className="text-[10px] uppercase tracking-[0.06em] text-subtle-foreground mt-1.5">
						dispatched
						<InfoChip
							tip={
								<>
									Rate at which Vayu pushed requests onto the wire. Independent of
									how fast they come back — that&apos;s throughput.
								</>
							}
						/>
					</div>
				</div>
				<div>
					<div className="text-[24px] leading-none font-bold font-mono tabular-nums text-foreground">
						{fmt(throughput, 1)}
						<span className="text-xs text-muted-foreground font-sans font-normal ml-1">
							req/s
						</span>
					</div>
					<div className="text-[10px] uppercase tracking-[0.06em] text-subtle-foreground mt-1.5">
						received
						<InfoChip tip="Rate at which responses arrived back from the server. The server's effective serve rate." />
					</div>
				</div>
			</div>
			{delta !== undefined && (
				<p className="text-[11px] text-muted-foreground mt-2 flex items-center gap-2">
					<span
						className={cn(
							"inline-block px-1.5 py-px rounded-sm font-mono text-[10px] font-bold",
							deltaOk
								? "bg-success/10 text-success"
								: "bg-destructive/10 text-destructive"
						)}
					>
						Δ {delta.toFixed(1)}
					</span>
					<span>
						{deltaOk ? "server kept pace with dispatch" : "server is lagging dispatch"}
					</span>
				</p>
			)}
		</div>
	);
}

/** Status-code buckets: stack-bar fill + legend entry share one definition. */
interface StatusSegment {
	key: "s2" | "s4" | "s5" | "err";
	label: string;
	bg: string; // Tailwind bg-* class for the stack bar
	color: string; // CSS color for the legend swatch
	infoTip?: string;
}
const STATUS_SEGMENTS: readonly StatusSegment[] = [
	{ key: "s2", label: "2xx", bg: "bg-success", color: "hsl(var(--success))" },
	{ key: "s4", label: "4xx", bg: "bg-warning", color: "hsl(var(--warning))" },
	{ key: "s5", label: "5xx", bg: "bg-destructive", color: "hsl(var(--destructive))" },
	{
		key: "err",
		label: "err",
		bg: "bg-subtle-foreground",
		color: "hsl(var(--subtle-foreground))",
		infoTip:
			"Transport-layer failures (connection refused, TLS handshake error, DNS failure, timeout). The request never received an HTTP status from the server.",
	},
];

function ErrorRateCard({
	totalRequests,
	failedRequests,
	statusCodes,
}: {
	totalRequests: number;
	failedRequests: number;
	statusCodes: Record<string, number>;
}) {
	const errorRate = totalRequests > 0 ? (failedRequests / totalRequests) * 100 : 0;
	const valueColor = errorRate === 0 ? "hsl(var(--success))" : "hsl(var(--destructive))";

	// Bucket status codes by class
	const buckets = useMemo(() => {
		const out: Record<StatusSegment["key"], number> = { s2: 0, s4: 0, s5: 0, err: 0 };
		for (const [codeStr, count] of Object.entries(statusCodes ?? {})) {
			const code = Number(codeStr);
			if (code >= 200 && code < 300) out.s2 += count;
			else if (code >= 400 && code < 500) out.s4 += count;
			else if (code >= 500 && code < 600) out.s5 += count;
			else out.err += count; // 0 / unknown — transport errors
		}
		const total = out.s2 + out.s4 + out.s5 + out.err;
		return { ...out, total };
	}, [statusCodes]);

	const widthFor = (n: number) => (buckets.total > 0 ? `${(n / buckets.total) * 100}%` : "0%");

	return (
		<div className="bg-card border border-border rounded-md p-4 flex flex-col gap-1.5">
			<Eyebrow>
				Error Rate
				<InfoChip tip="Share of requests that failed at the transport layer (timeout, connection refused, TLS handshake failure, DNS). HTTP responses with 4xx / 5xx status codes are counted separately in the bar below — they don't contribute to this percentage." />
			</Eyebrow>
			<div className="flex items-baseline gap-2 mt-0.5">
				<span
					className="text-[34px] font-bold leading-none font-mono tabular-nums"
					style={{ color: valueColor }}
				>
					{errorRate.toFixed(1)}
				</span>
				<span className="text-xs text-muted-foreground">%</span>
				<span className="ml-auto text-[11px] font-mono text-subtle-foreground">
					{formatNumber(failedRequests)} / {formatNumber(totalRequests)}
				</span>
			</div>
			{/* Always render the stack + legend so the card height doesn't jump
			    when the final report arrives. During live the bar is empty;
			    after completion it fills with the real distribution. */}
			<div className="flex h-2 mt-2 rounded-sm border border-border bg-accent overflow-hidden">
				{STATUS_SEGMENTS.map((s) => (
					<span
						key={s.key}
						className={cn("block h-full transition-[width] duration-300", s.bg)}
						style={{ width: widthFor(buckets[s.key]) }}
					/>
				))}
			</div>
			<div className="flex flex-wrap gap-3 mt-2 text-[11px] font-mono text-muted-foreground">
				{STATUS_SEGMENTS.map((s) => (
					<StatusLegend
						key={s.key}
						color={s.color}
						label={s.label}
						count={buckets[s.key]}
						infoTip={s.infoTip}
					/>
				))}
			</div>
		</div>
	);
}

function StatusLegend({
	color,
	label,
	count,
	infoTip,
}: {
	color: string;
	label: string;
	count: number;
	infoTip?: string;
}) {
	const dim = count === 0;
	return (
		<span className={cn(dim && "text-subtle-foreground")}>
			<span
				className="inline-block w-2 h-2 rounded-sm mr-1.5 align-[1px]"
				style={{ background: color }}
			/>
			{label} {count}
			{infoTip && <InfoChip tip={infoTip} />}
		</span>
	);
}

// ============================================================================
// Throughput over time chart (SVG)
// ============================================================================

interface ThroughputPoint {
	time: number;
	rps: number;
	sendRate: number;
}

function ThroughputOverTimeChart({
	data,
	targetRps,
	isCompleted,
	rampOverlay,
}: {
	data: ThroughputPoint[];
	targetRps?: number;
	isCompleted: boolean;
	rampOverlay?: RampOverlay | null;
}) {
	if (data.length < 2) return null;

	const VW = 1080;
	const VH = 240;
	const PL = 56;
	const PR = 12;
	const PT = 16;
	const PB = 28;
	const IW = VW - PL - PR;
	const IH = VH - PT - PB;

	const yMax = niceYMax([...data.map((d) => Math.max(d.rps, d.sendRate)), targetRps ?? 0], {
		floor: 1,
		headroom: 1.15,
	});

	const toX = (i: number) => PL + (i / (data.length - 1)) * IW;
	const toY = (v: number) => projectY(v, yMax, PT, IH);

	const ptsRps = data.map((d, i) => `${toX(i).toFixed(1)},${toY(d.rps).toFixed(1)}`).join(" ");
	const ptsSend = data
		.map((d, i) => `${toX(i).toFixed(1)},${toY(d.sendRate).toFixed(1)}`)
		.join(" ");

	const baselineY = PT + IH;
	const areaRps = `M${PL},${baselineY} L${ptsRps} L${toX(data.length - 1).toFixed(1)},${baselineY}Z`;

	const yTicks = [0.25, 0.5, 0.75, 1.0].map((f) => {
		const v = yMax * f;
		return {
			y: toY(v),
			label: v >= 1000 ? `${(v / 1000).toFixed(0)}k` : Math.round(v).toString(),
		};
	});

	// Up to 8 x-axis labels
	const xCount = Math.min(8, data.length);
	const xStride = Math.max(1, Math.floor((data.length - 1) / (xCount - 1)));
	const xLabels: Array<{ x: number; label: string }> = [];
	for (let i = 0; i < data.length; i += xStride) {
		xLabels.push({ x: toX(i), label: `${data[i].time.toFixed(1)}s` });
	}
	const lastIdx = data.length - 1;
	if (xLabels[xLabels.length - 1]?.label !== `${data[lastIdx].time.toFixed(1)}s`) {
		xLabels.push({ x: toX(lastIdx), label: `${data[lastIdx].time.toFixed(1)}s` });
	}

	const targetY = targetRps !== undefined && targetRps > 0 ? toY(targetRps) : null;

	return (
		<svg viewBox={`0 0 ${VW} ${VH}`} style={{ width: "100%", height: 220, display: "block" }}>
			{/* horizontal grid */}
			<g stroke="hsl(var(--border))" strokeDasharray="2 2">
				{yTicks.map((t, i) => (
					<line key={i} x1={PL} x2={VW - PR} y1={t.y} y2={t.y} />
				))}
			</g>

			{/* y labels */}
			<g fill="hsl(var(--subtle-foreground))" fontSize="10" fontFamily="JetBrains Mono">
				{yTicks.map((t, i) => (
					<text key={i} x={PL - 6} y={t.y + 3.5} textAnchor="end">
						{t.label}
					</text>
				))}
			</g>

			{/* target reference line */}
			{targetY !== null && (
				<>
					<line
						x1={PL}
						x2={VW - PR}
						y1={targetY}
						y2={targetY}
						stroke="hsl(var(--subtle-foreground))"
						strokeDasharray="4 4"
					/>
					<g>
						<rect
							x={VW - PR - 58}
							y={targetY - 7}
							width={58}
							height={13}
							rx={2}
							fill="hsl(var(--accent))"
							stroke="hsl(var(--border))"
						/>
						<text
							x={VW - PR - 29}
							y={targetY + 3}
							fontSize="9.5"
							fill="hsl(var(--muted-foreground))"
							textAnchor="middle"
							fontFamily="JetBrains Mono"
						>
							target {targetRps}
						</text>
					</g>
				</>
			)}

			{/* send rate line */}
			<polyline
				fill="none"
				stroke="hsl(var(--info))"
				strokeWidth="1.5"
				strokeLinejoin="round"
				strokeLinecap="round"
				points={ptsSend}
			/>

			{/* throughput area + line */}
			<path d={areaRps} fill="hsl(var(--primary) / 0.14)" />
			<polyline
				fill="none"
				stroke="hsl(var(--primary))"
				strokeWidth="1.8"
				strokeLinejoin="round"
				strokeLinecap="round"
				points={ptsRps}
			/>

			{/* x labels */}
			<g
				fill="hsl(var(--subtle-foreground))"
				fontSize="10"
				fontFamily="JetBrains Mono"
				textAnchor="middle"
			>
				{xLabels.map((t, i) => (
					<text key={i} x={t.x} y={VH - 8}>
						{t.label}
					</text>
				))}
			</g>

			{/* live dot at end of throughput line */}
			{!isCompleted && (
				<circle
					cx={toX(lastIdx)}
					cy={toY(data[lastIdx].rps)}
					r={3.5}
					fill="hsl(var(--primary))"
				>
					<animate
						attributeName="opacity"
						values="1;0.3;1"
						dur="1.6s"
						repeatCount="indefinite"
					/>
				</circle>
			)}

			{/* ramp_up concurrency overlay — right Y-axis */}
			{rampOverlay &&
				rampOverlay.points.length > 1 &&
				(() => {
					const cMax = niceYMax([rampOverlay.target], { floor: 1, headroom: 1.15 });
					const n = rampOverlay.points.length;
					const cx = (i: number) => PL + (i / (n - 1)) * IW;
					const cy = (v: number) => projectY(v, cMax, PT, IH);
					const conf = rampOverlay.points.map(
						(p, i) => `${cx(i).toFixed(1)},${cy(p.configured).toFixed(1)}`
					);
					const ach = rampOverlay.points.map(
						(p, i) => `${cx(i).toFixed(1)},${cy(p.achieved).toFixed(1)}`
					);
					const lagPath = `M${conf.join(" L")} L${[...ach].reverse().join(" L")} Z`;
					const rTicks = [0, 0.5, 1.0].map((f) => ({
						y: cy(cMax * f),
						label: `${Math.round(cMax * f)}`,
					}));
					return (
						<g>
							<g
								fill="hsl(var(--subtle-foreground))"
								fontSize="10"
								fontFamily="JetBrains Mono"
								textAnchor="start"
							>
								{rTicks.map((t, i) => (
									<text key={i} x={VW - PR + 4} y={t.y + 3.5}>
										{t.label}
									</text>
								))}
							</g>
							<path d={lagPath} fill="hsl(var(--warning) / 0.25)" />
							<polyline
								fill="none"
								stroke="hsl(var(--subtle-foreground))"
								strokeWidth="1.5"
								strokeDasharray="4 4"
								points={conf.join(" ")}
							/>
							<polyline
								fill="none"
								stroke="hsl(var(--success))"
								strokeWidth="1.8"
								strokeLinejoin="round"
								strokeLinecap="round"
								points={ach.join(" ")}
							/>
						</g>
					);
				})()}
		</svg>
	);
}

// ============================================================================
// HDR percentile plot — sourced from finalReport.latency
// ============================================================================

interface PercentilePoint {
	pct: number; // 0..100
	value: number; // latency ms
}

/** Log-scale percentile mapping: 0% → 0, 99.99% → 1.
 *  Uses log10(1 / (1 - p/100)) ramp so the tail dominates. */
function pctToX(pct: number): number {
	const p = Math.min(99.99, Math.max(0, pct));
	if (p === 0) return 0;
	const numerator = Math.log10(1 / (1 - p / 100));
	const maxNumerator = Math.log10(1 / (1 - 99.99 / 100)); // = 4
	return numerator / maxNumerator;
}

function HdrPercentilePlot({ report }: { report: RunReport | null }) {
	if (!report?.latency) return null;
	const { latency } = report;

	const points: PercentilePoint[] = [];
	const push = (pct: number, value: number | undefined) => {
		if (value !== undefined && value >= 0) points.push({ pct, value });
	};
	push(0, latency.min);
	push(50, latency.p50);
	push(75, latency.p75);
	push(90, latency.p90);
	push(95, latency.p95);
	push(99, latency.p99);
	push(99.9, latency.p999);
	push(99.99, latency.max);

	if (points.length < 3) return null;

	const { VW, VH, PL, PR, PT, PB } = HDR_DIMS;
	const IW = VW - PL - PR;
	const IH = VH - PT - PB;

	const maxV = niceYMax(
		points.map((p) => p.value),
		{ floor: 1, headroom: 1.08 }
	);
	const toX = (pct: number) => PL + pctToX(pct) * IW;
	const toY = (v: number) => projectY(v, maxV, PT, IH);

	const path = points
		.map((p, i) => `${i === 0 ? "M" : "L"}${toX(p.pct).toFixed(1)},${toY(p.value).toFixed(1)}`)
		.join(" ");
	const area = `${path} L${toX(points[points.length - 1].pct).toFixed(1)},${PT + IH} L${toX(points[0].pct).toFixed(1)},${PT + IH} Z`;

	const yTicks = [0.25, 0.5, 0.75, 1.0].map((f) => {
		const v = maxV * f;
		return {
			y: toY(v),
			label: v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}`,
		};
	});

	const markers: Array<{ pct: number; value?: number; label: string; color: string }> = [
		{ pct: 50, value: latency.p50, label: "p50", color: "hsl(var(--success))" },
		{ pct: 95, value: latency.p95, label: "p95", color: "hsl(var(--warning))" },
		{ pct: 99, value: latency.p99, label: "p99", color: "hsl(var(--destructive))" },
	];

	return (
		<svg viewBox={`0 0 ${VW} ${VH}`} style={{ width: "100%", height: 200, display: "block" }}>
			{/* y grid */}
			<g stroke="hsl(var(--border))" strokeDasharray="2 2">
				{yTicks.map((t, i) => (
					<line key={i} x1={PL} x2={VW - PR} y1={t.y} y2={t.y} />
				))}
			</g>
			<g fill="hsl(var(--subtle-foreground))" fontSize="9" fontFamily="JetBrains Mono">
				{yTicks.map((t, i) => (
					<text key={i} x={PL - 4} y={t.y + 3} textAnchor="end">
						{t.label}
					</text>
				))}
			</g>

			{/* curve area + line */}
			<path d={area} fill="hsl(var(--primary) / 0.10)" />
			<path
				d={path}
				fill="none"
				stroke="hsl(var(--primary))"
				strokeWidth="1.8"
				strokeLinejoin="round"
				strokeLinecap="round"
			/>

			{/* percentile markers */}
			{markers.map(
				(m) =>
					m.value !== undefined && (
						<g key={m.label}>
							<line
								x1={toX(m.pct)}
								x2={toX(m.pct)}
								y1={PT}
								y2={PT + IH}
								stroke={m.color}
								strokeDasharray="2 3"
								opacity={0.7}
							/>
							<circle cx={toX(m.pct)} cy={toY(m.value)} r={3} fill={m.color} />
							<rect
								x={toX(m.pct) - 22}
								y={4}
								width={44}
								height={12}
								rx={2}
								fill={m.color}
								fillOpacity={0.15}
								stroke={m.color}
								strokeOpacity={0.4}
							/>
							<text
								x={toX(m.pct)}
								y={12.5}
								fontSize="9"
								fill={m.color}
								textAnchor="middle"
								fontFamily="JetBrains Mono"
								fontWeight={700}
							>
								{m.label} {Math.round(m.value)}
							</text>
						</g>
					)
			)}

			{/* x labels */}
			<g
				fill="hsl(var(--subtle-foreground))"
				fontSize="9"
				fontFamily="JetBrains Mono"
				textAnchor="middle"
			>
				{HDR_X_MARKS.map((m, i) => (
					<text key={i} x={toX(m.pct)} y={VH - 6}>
						{m.label}
					</text>
				))}
			</g>
		</svg>
	);
}

// ============================================================================
// Skeleton HDR plot — same dimensions as the real plot, drawn during live so
// the card doesn't pop in height when the final report arrives.
// ============================================================================

function SkeletonHdrPlot({ message }: { message: string }) {
	const { VW, VH, PL, PR, PT, PB } = HDR_DIMS;
	const IW = VW - PL - PR;
	const skelToX = (pct: number) => PL + pctToX(pct) * IW;
	const yTicks = [0.25, 0.5, 0.75, 1.0].map((f, i) => ({
		y: PT + (1 - f) * (VH - PT - PB),
		key: i,
	}));
	return (
		<svg viewBox={`0 0 ${VW} ${VH}`} style={{ width: "100%", height: 200, display: "block" }}>
			<g stroke="hsl(var(--border))" strokeDasharray="2 2">
				{yTicks.map((t) => (
					<line key={t.key} x1={PL} x2={VW - PR} y1={t.y} y2={t.y} />
				))}
			</g>
			<g
				fill="hsl(var(--subtle-foreground))"
				fontSize="9"
				fontFamily="JetBrains Mono"
				textAnchor="middle"
			>
				{HDR_X_MARKS.map((m, i) => (
					<text key={i} x={skelToX(m.pct)} y={VH - 6}>
						{m.label}
					</text>
				))}
			</g>
			<text
				x={VW / 2}
				y={VH / 2}
				fontSize="11"
				fill="hsl(var(--muted-foreground))"
				textAnchor="middle"
				fontFamily="Space Grotesk, system-ui, sans-serif"
				fontStyle="italic"
			>
				{message}
			</text>
		</svg>
	);
}

// ============================================================================
// Timing waterfall — from report.timingBreakdown.
// Always renders 5 rows so the card height stays constant; during live (no
// report yet) values show "—" and bars are empty.
// ============================================================================

function TimingWaterfall({ report }: { report: RunReport | null }) {
	const tb = report?.timingBreakdown;
	const hasData = !!tb;

	const stages: Array<{ k: string; v: number | undefined; color: string; tip: ReactNode }> = [
		{
			k: "DNS",
			v: tb?.avgDnsMs,
			color: "hsl(var(--chart-2))",
			tip: "Hostname → IP resolution. Usually a few ms once cached; >50ms suggests slow DNS or a fresh lookup per request.",
		},
		{
			k: "Connect",
			v: tb?.avgConnectMs,
			color: "hsl(var(--chart-4))",
			tip: "TCP three-way handshake. Zero on connection reuse (HTTP keep-alive / HTTP/2).",
		},
		{
			k: "TLS",
			v: tb?.avgTlsMs,
			color: "hsl(var(--chart-5))",
			tip: "SSL/TLS handshake (HTTPS only). Zero for plain HTTP and on resumed connections.",
		},
		{
			k: "TTFB",
			v: tb?.avgFirstByteMs,
			color: "hsl(var(--primary))",
			tip: "Time to first byte. Server processing time + propagation. This is where slow endpoints reveal themselves — if TTFB dominates, the bottleneck is the server, not the network.",
		},
		{
			k: "Download",
			v: tb?.avgDownloadMs,
			color: "hsl(var(--success))",
			tip: "Response body transfer time. Big for large payloads or slow links; near-zero for small JSON responses.",
		},
	];

	const total = stages.reduce((s, x) => s + (x.v ?? 0), 0);
	const widthFor = (v: number | undefined) =>
		hasData && total > 0 ? `${((v ?? 0) / total) * 100}%` : "0%";

	return (
		<>
			{stages.map((s) => (
				<div key={s.k} className="grid grid-cols-[68px_1fr_70px] items-center gap-2.5 py-1">
					<span className="text-[11px] text-muted-foreground">
						{s.k}
						<InfoChip tip={s.tip} />
					</span>
					<div className="h-2 rounded-sm bg-accent overflow-hidden">
						<span
							className="block h-full transition-[width] duration-300"
							style={{ width: widthFor(s.v), background: s.color }}
						/>
					</div>
					<span className="text-right font-mono tabular-nums text-[11.5px] font-medium">
						{hasData && s.v !== undefined ? (
							<>
								<span className="text-foreground">{s.v.toFixed(0)}</span>
								<span className="text-subtle-foreground ml-0.5">ms</span>
							</>
						) : (
							<span className="text-subtle-foreground">—</span>
						)}
					</span>
				</div>
			))}
			<div className="mt-2.5 pt-2.5 border-t border-dashed border-border flex justify-between text-[11px] text-muted-foreground">
				<span>Avg total</span>
				<span className="font-mono font-semibold">
					{hasData ? (
						<span className="text-foreground">{total.toFixed(0)} ms</span>
					) : (
						<span className="text-subtle-foreground">— ms</span>
					)}
				</span>
			</div>
		</>
	);
}

// ============================================================================
// Stat card — secondary metric pattern (22px values)
// ============================================================================

function StatCard({
	label,
	value,
	unit,
	sub,
	infoTip,
}: {
	label: string;
	value: ReactNode;
	unit?: string;
	sub?: ReactNode;
	infoTip?: ReactNode;
}) {
	return (
		<div className="bg-card border border-border rounded-md p-3">
			<p className={cn(EYEBROW_CLASS, "mb-1.5")}>
				{label}
				{infoTip && <InfoChip tip={infoTip} />}
			</p>
			<div className="flex items-baseline gap-1">
				<span className="text-[22px] font-bold font-mono tabular-nums text-foreground leading-none">
					{value}
				</span>
				{unit && <span className="text-xs text-muted-foreground">{unit}</span>}
			</div>
			{sub && (
				<div className="mt-1.5 font-mono text-[10.5px] text-subtle-foreground">{sub}</div>
			)}
		</div>
	);
}

// ============================================================================
// Main MetricsView
// ============================================================================

function MetricsView({
	metrics,
	historicalMetrics,
	isCompleted,
	finalReport,
	targetRps,
	mode,
	rampConfig,
}: MetricsViewProps) {
	// Single capped window shared by all time-series charts so their x-axes
	// cover identical time spans (the throughput chart and the RampUp overlay
	// share one x-axis — they must be built from the same window or the
	// configured/achieved lines misalign with throughput on long runs).
	const chartWindow = useMemo(() => historicalMetrics.slice(-2400), [historicalMetrics]);

	// Bucket per-tick history by 0.5s for the chart
	const chartData = useMemo<ThroughputPoint[]>(() => {
		const window = chartWindow;
		const byBucket = new Map<number, ThroughputPoint>();
		for (const m of window) {
			const t = Math.round(m.elapsed_seconds * 2) / 2;
			byBucket.set(t, {
				time: t,
				rps: m.throughput ?? m.current_rps ?? 0,
				sendRate: m.send_rate ?? 0,
			});
		}
		return Array.from(byBucket.values()).sort((a, b) => a.time - b.time);
	}, [chartWindow]);

	const latencyChartData = useMemo(() => buildLatencyChartData(chartWindow), [chartWindow]);

	const percentileChartData = useMemo(() => buildPercentileChartData(chartWindow), [chartWindow]);
	const hasPercentileData = percentileChartData.some((d) => d.p99 > 0);

	const rampOverlay = useMemo(
		() => (mode === "ramp_up" ? buildRampOverlay(chartWindow, rampConfig ?? {}) : null),
		[mode, chartWindow, rampConfig]
	);

	const peakConcurrency = useMemo(() => {
		let max = 0;
		for (const m of historicalMetrics) {
			if (m.current_concurrency > max) max = m.current_concurrency;
		}
		return max;
	}, [historicalMetrics]);

	if (!metrics || typeof metrics.requests_completed === "undefined") {
		return (
			<div className="p-5 text-center py-12 text-muted-foreground">
				<Activity className="w-12 h-12 mx-auto mb-3 text-muted-foreground/30" />
				<p>Waiting for metrics…</p>
			</div>
		);
	}

	// "Rate Fidelity" measures throughput fidelity (responses/sec vs target).
	// Prefer cumulative measures over current_rps (which is a delta-per-100ms
	// and routinely blips to 0 in low-RPS tests).
	const actualRps =
		finalReport?.rateControl?.actualRps ??
		finalReport?.summary?.throughput ??
		metrics.throughput ??
		metrics.current_rps;
	const sendRate = metrics.send_rate ?? finalReport?.summary?.sendRate;
	const throughput = metrics.throughput ?? finalReport?.summary?.throughput;
	const statusCodes = finalReport?.statusCodes ?? {};
	const totalRequests = metrics.requests_completed;
	const failedRequests = metrics.requests_failed ?? 0;

	const setupOverhead = finalReport?.summary?.setupOverhead;
	const testDuration = finalReport?.summary?.testDuration;

	const droppedRequests = metrics.dropped_requests ?? 0;
	const showDropped = isRateLimitedRun(mode, targetRps) && droppedRequests > 0;

	const p99Latency = isCompleted
		? (finalReport?.latency?.p99 ?? metrics.latency_p99_ms ?? 0)
		: (metrics.latency_p99_ms ?? 0);
	const meanLatency = metrics.avg_latency_ms ?? 0;
	const medianLatency = finalReport?.latency?.p50 ?? metrics.latency_p50_ms ?? 0;

	return (
		<div className="p-5 flex flex-col gap-3.5">
			{/* Row 1 — Hero */}
			<div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-3">
				{showDropped ? (
					<DroppedRequestsCard dropped={droppedRequests} completed={totalRequests} />
				) : (
					<RateFidelityCard targetRps={targetRps} actualRps={actualRps} />
				)}
				<ThroughputTwinCard sendRate={sendRate} throughput={throughput} />
				<ErrorRateCard
					totalRequests={totalRequests}
					failedRequests={failedRequests}
					statusCodes={statusCodes}
				/>
			</div>

			{/* Row 2 — Throughput over time */}
			{chartData.length > 1 && (
				<div className="bg-card border border-border rounded-md p-3.5">
					<div className="flex items-baseline justify-between mb-3">
						<h3 className="text-[12px] font-semibold text-foreground">
							Throughput over time
							<InfoChip tip="Per-tick (100ms) snapshot of send rate (dispatched) and throughput (received). Divergence between the two lines indicates the server is saturating. The dashed reference is the configured target." />
						</h3>
						<div className="flex gap-3.5 text-[11px] font-mono text-muted-foreground">
							<span>
								<span
									className="inline-block w-2.5 h-0.5 mr-1.5 align-middle"
									style={{ background: "hsl(var(--primary))" }}
								/>
								throughput
							</span>
							<span>
								<span
									className="inline-block w-2.5 h-0.5 mr-1.5 align-middle"
									style={{ background: "hsl(var(--info))" }}
								/>
								send rate
							</span>
							{targetRps !== undefined && (
								<span className="text-subtle-foreground">
									<span
										className="inline-block w-2.5 h-0.5 mr-1.5 align-middle"
										style={{ background: "hsl(var(--subtle-foreground))" }}
									/>
									target {targetRps}
								</span>
							)}
							{rampOverlay && (
								<>
									<span className="text-subtle-foreground">
										<span
											className="inline-block w-2.5 h-0.5 mr-1.5 align-middle"
											style={{ background: "hsl(var(--subtle-foreground))" }}
										/>
										configured
									</span>
									<span>
										<span
											className="inline-block w-2.5 h-0.5 mr-1.5 align-middle"
											style={{ background: "hsl(var(--success))" }}
										/>
										achieved
									</span>
								</>
							)}
						</div>
					</div>
					<ThroughputOverTimeChart
						data={chartData}
						targetRps={targetRps}
						isCompleted={isCompleted}
						rampOverlay={rampOverlay}
					/>
					{rampOverlay && (
						<div className="flex justify-between gap-3 mt-2.5 pt-2.5 border-t border-dashed border-border text-[11px] font-mono text-muted-foreground">
							<span>
								<span className="text-subtle-foreground">ramp deviation </span>
								<span className="text-foreground font-semibold">
									{rampOverlay.rampDeviationPct.toFixed(1)}%
								</span>
								<InfoChip tip="Mean absolute gap between achieved (measured) and configured concurrency, as a percent of target. Counts both undershoot and overshoot, so a ramp that runs over target reads high." />
							</span>
							<span>
								<span className="text-subtle-foreground">peak achieved </span>
								<span className="text-foreground font-semibold">
									{formatNumber(rampOverlay.peakAchieved)}
								</span>
								<span className="text-subtle-foreground"> / target </span>
								<span className="text-foreground font-semibold">
									{formatNumber(rampOverlay.target)}
								</span>
							</span>
							{rampOverlay.rampDeviationPct > 5 && (
								<span style={{ color: "hsl(var(--warning))" }}>
									⚠ ramp off target
								</span>
							)}
						</div>
					)}
				</div>
			)}

			{/* Row 2.5 — Latency over time (perceived vs wire, queue-wait gap) */}
			{latencyChartData.length > 1 && (
				<div className="bg-card border border-border rounded-md p-3.5">
					<div className="flex items-baseline justify-between mb-3">
						<h3 className="text-[12px] font-semibold text-foreground">
							Latency over time
							<InfoChip tip="Per-tick latency over the run. The amber gap between Latency and Wire shows generator-side queue wait. When the gap grows, your generator is the bottleneck. Identity: latency = wire + queue wait." />
						</h3>
						<div className="flex gap-3.5 text-[11px] font-mono text-muted-foreground">
							<span>
								<span
									className="inline-block w-2.5 h-0.5 mr-1.5 align-middle"
									style={{ background: "hsl(var(--primary))" }}
								/>
								latency
							</span>
							<span>
								<span
									className="inline-block w-2.5 h-0.5 mr-1.5 align-middle"
									style={{ background: "hsl(var(--info))" }}
								/>
								wire
							</span>
							<span>
								<span
									className="inline-block w-2.5 h-2 mr-1.5 align-middle rounded-sm"
									style={{ background: "hsl(var(--warning) / 0.5)" }}
								/>
								queue wait
							</span>
						</div>
					</div>
					<LatencyOverTimeChart data={latencyChartData} isCompleted={isCompleted} />
				</div>
			)}

			{/* Row 2.7 — Response time percentiles over time */}
			{percentileChartData.length > 1 && hasPercentileData && (
				<div className="bg-card border border-border rounded-md p-3.5">
					<div className="flex items-baseline justify-between mb-3">
						<h3 className="text-[12px] font-semibold text-foreground">
							Response time percentiles over time
							<InfoChip tip="Per-tick p50 / p95 / p99 latency over the run. p50 is what most users felt; p99 is the tail — heavy-tail divergence shows up as p99 climbing while p50 stays flat. Sourced from per-tick HdrHistogram snapshots." />
						</h3>
						<div className="flex gap-3.5 text-[11px] font-mono text-muted-foreground">
							<span>
								<span
									className="inline-block w-2.5 h-0.5 mr-1.5 align-middle"
									style={{ background: "hsl(var(--success))" }}
								/>
								p50
							</span>
							<span>
								<span
									className="inline-block w-2.5 h-0.5 mr-1.5 align-middle"
									style={{ background: "hsl(var(--warning))" }}
								/>
								p95
							</span>
							<span>
								<span
									className="inline-block w-2.5 h-0.5 mr-1.5 align-middle"
									style={{ background: "hsl(var(--destructive))" }}
								/>
								p99
							</span>
						</div>
					</div>
					<PercentilesOverTimeChart
						data={percentileChartData}
						isCompleted={isCompleted}
					/>
				</div>
			)}

			{/* Row 3 — HDR plot + Timing waterfall */}
			<div className="grid grid-cols-[repeat(auto-fit,minmax(380px,1fr))] gap-3">
				{/* HDR */}
				<div className="bg-card border border-border rounded-md p-3.5">
					<div className="flex items-baseline justify-between mb-3">
						<h3 className="text-[12px] font-semibold text-foreground">
							Latency distribution
							<InfoChip tip="HDR percentile plot. X is percentile (log-scaled so the tail dominates); Y is latency. The curve's steepness from p95 → p99 is the tail story. Sourced from the engine's HdrHistogram." />
							<span className="ml-2 text-[11px] font-normal text-subtle-foreground">
								HDR percentile plot
							</span>
						</h3>
						<span className="text-[10.5px] font-mono text-subtle-foreground">
							{finalReport ? "from HdrHistogram" : "available after completion"}
						</span>
					</div>
					{/* Render the plot at fixed dimensions whether or not the report is
					    in yet — keeps the card height stable across the live → completed
					    transition. */}
					{finalReport ? (
						<HdrPercentilePlot report={finalReport} />
					) : (
						<SkeletonHdrPlot message="p50 / p95 / p99 finalize after the run completes" />
					)}
					<div className="flex justify-between gap-3 mt-2.5 pt-2.5 border-t border-dashed border-border text-[11px] font-mono text-muted-foreground">
						<LatencyStat k="min" v={finalReport?.latency?.min} />
						<LatencyStat k="mean" v={finalReport?.latency?.avg} />
						<LatencyStat k="p50" v={finalReport?.latency?.p50} />
						<LatencyStat k="p95" v={finalReport?.latency?.p95} />
						<LatencyStat k="p99" v={finalReport?.latency?.p99} />
						<LatencyStat k="max" v={finalReport?.latency?.max} />
					</div>
				</div>

				{/* Timing waterfall */}
				<div className="bg-card border border-border rounded-md p-3.5">
					<div className="flex items-baseline justify-between mb-3">
						<h3 className="text-[12px] font-semibold text-foreground">
							Avg request timing
							<InfoChip tip="Average breakdown of where each HTTP request spent time, in flight order. Computed across the timing-sampled subset of requests (enable save_timing_breakdown to populate). Helps isolate whether latency lives in DNS, network setup, or the server." />
						</h3>
						<span className="text-[10.5px] font-mono text-subtle-foreground">
							{finalReport?.timingBreakdown ? "from timing samples" : "—"}
						</span>
					</div>
					<TimingWaterfall report={finalReport} />
				</div>
			</div>

			{/* Row 4 — Bottom stat row */}
			<div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
				<StatCard
					label="Duration"
					value={fmt(testDuration, 2)}
					unit="s"
					sub={
						<>
							cleanup overhead{" "}
							{setupOverhead !== undefined ? (
								<span className="text-muted-foreground">
									{setupOverhead.toFixed(2)}s
								</span>
							) : (
								<span className="text-subtle-foreground">—</span>
							)}
						</>
					}
					infoTip="Total wall-clock duration of the active attack window. Cleanup overhead is the time the engine spent after the test ended joining the metrics thread and finalising state — it's not counted in the load test duration but is reported for transparency."
				/>
				<StatCard
					label="Total requests"
					value={formatNumber(totalRequests)}
					sub={
						<>
							failed{" "}
							<span
								className={cn(
									failedRequests > 0
										? "text-destructive"
										: "text-muted-foreground"
								)}
							>
								{formatNumber(failedRequests)}
							</span>
						</>
					}
				/>
				<StatCard
					label="Peak concurrency"
					value={formatNumber(peakConcurrency)}
					sub={
						<>
							backpressure{" "}
							<span className="text-muted-foreground">
								{formatNumber(metrics.backpressure ?? 0)}
							</span>
						</>
					}
					infoTip="Maximum simultaneously in-flight HTTP connections during the run. Backpressure = requests dispatched but not yet responded — a growing value indicates the server is slower than the dispatch rate."
				/>
				<StatCard
					label="p99 latency"
					value={p99Latency.toFixed(0)}
					unit="ms"
					sub={
						p99Latency > 0 ? (
							<>
								mean{" "}
								<span className="text-muted-foreground">
									{meanLatency.toFixed(0)} ms
								</span>
								{medianLatency > 0 && (
									<>
										{" · "}median{" "}
										<span className="text-muted-foreground">
											{medianLatency.toFixed(0)} ms
										</span>
									</>
								)}
							</>
						) : (
							<span className="text-subtle-foreground italic">awaiting samples</span>
						)
					}
					infoTip="Tail latency — 99 of every 100 requests completed in this time or less. Real user-impact lives at p99, not the mean; mean (sub-text) is misleading on heavy-tailed distributions."
				/>
			</div>
		</div>
	);
}

function LatencyStat({ k, v }: { k: string; v: number | undefined }) {
	return (
		<span>
			<span className="text-subtle-foreground">{k}</span>{" "}
			<span className="text-foreground font-semibold">{fmt(v, 0)}</span>
		</span>
	);
}

export default memo(MetricsView);
