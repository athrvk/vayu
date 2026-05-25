
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * MetricsView Component
 *
 * Displays key metrics, latency breakdown, and charts (pure SVG — no Recharts)
 */

import { useMemo, memo } from "react";
import { Activity } from "lucide-react";
import { formatNumber } from "@/utils";
import type { MetricsViewProps } from "../types";

// ============================================================================
// Mini SVG Sparkline
// ============================================================================

function Sparkline({ data, color }: { data: number[]; color: string }) {
	if (!data || data.length < 2) return null;
	const max = Math.max(...data), min = Math.min(...data), rng = max - min || 1;
	const w = 108, h = 26;
	const pts = data.map((v, i) =>
		`${(1 + (i / (data.length - 1)) * w).toFixed(1)},${(1 + h * (1 - (v - min) / rng)).toFixed(1)}`
	);
	const area = `M1,${h + 1} L${pts.join(" L")} L${w + 1},${h + 1}Z`;
	return (
		<svg width={110} height={28} className="block overflow-visible">
			<path d={area} fill={color} fillOpacity="0.15" />
			<polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
		</svg>
	);
}

// ============================================================================
// SVG Area Chart (replaces Recharts)
// ============================================================================

function SvgAreaChart({
	data,
	dataKey,
	color,
	height = 170,
}: {
	data: Array<Record<string, number>>;
	dataKey: string;
	color: string;
	height?: number;
}) {
	if (!data || data.length < 2) return null;
	const VW = 600, VH = 150;
	const PL = 42, PR = 8, PT = 6, PB = 20;
	const IW = VW - PL - PR, IH = VH - PT - PB;
	const vals = data.map((d) => d[dataKey]);
	const maxV = Math.max(...vals) * 1.08 || 1;
	const toX = (i: number) => PL + (i / (data.length - 1)) * IW;
	const toY = (v: number) => PT + (1 - v / maxV) * IH;
	const pts = data.map((d, i) => `${toX(i).toFixed(1)},${toY(d[dataKey]).toFixed(1)}`);
	const bottomY = (PT + IH).toFixed(1);
	const areaD = `M${PL},${bottomY} L${pts.join(" L")} L${toX(data.length - 1).toFixed(1)},${bottomY}Z`;
	const yTicks = [0.25, 0.5, 0.75, 1.0].map((f) => ({
		y: toY(maxV * f),
		label: maxV * f >= 1000 ? `${((maxV * f) / 1000).toFixed(0)}k` : Math.round(maxV * f),
	}));
	const xStep = Math.max(1, Math.floor(data.length / 6));
	const xTicks = data
		.filter((_, i) => i % xStep === 0)
		.map((d, idx) => ({
			x: toX(idx * xStep),
			label: d.time !== undefined ? `${d.time}s` : `${idx * xStep}`,
		}));
	return (
		<svg viewBox={`0 0 ${VW} ${VH}`} style={{ width: "100%", height, display: "block" }}>
			{yTicks.map((t, i) => (
				<g key={i}>
					<line x1={PL} y1={t.y} x2={VW - PR} y2={t.y} stroke="hsl(var(--border))" strokeDasharray="2 2" />
					<text x={PL - 4} y={t.y + 3.5} textAnchor="end" fontSize="9" fill="hsl(var(--muted-foreground))" fontFamily="'JetBrains Mono', monospace">{t.label}</text>
				</g>
			))}
			{xTicks.map((t, i) => (
				<text key={i} x={t.x} y={VH - 3} textAnchor="middle" fontSize="9" fill="hsl(var(--muted-foreground))" fontFamily="'JetBrains Mono', monospace">{t.label}</text>
			))}
			<path d={areaD} fill={color} fillOpacity="0.12" />
			<polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
		</svg>
	);
}

// ============================================================================
// Latency Distribution Bar
// ============================================================================

function LatencyBar({ p50, p95, p99 }: { p50: number; p95: number; p99: number }) {
	const mx = Math.max(p99 * 1.2, 120);
	const pct = (v: number) => `${((v / mx) * 100).toFixed(1)}%`;
	const markers = [
		{ lbl: "p50", v: p50, col: "#22c55e" },
		{ lbl: "p95", v: p95, col: "#f59e0b" },
		{ lbl: "p99", v: p99, col: "#ef4444" },
	];
	return (
		<div className="bg-card border border-border rounded-md p-4 pb-8">
			<p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground mb-6">
				Latency Distribution
			</p>
			<div className="relative h-14">
				{/* gradient track */}
				<div
					className="absolute top-2.5 inset-x-0 h-1 rounded-sm border border-border"
					style={{
						background:
							"linear-gradient(to right, rgba(34,197,94,.18), rgba(245,158,11,.18), rgba(239,68,68,.18))",
					}}
				/>
				{markers.map(({ lbl, v, col }) => (
					<div
						key={lbl}
						className="absolute top-0"
						style={{ left: pct(v), transform: "translateX(-50%)" }}
					>
						<div className="w-px h-4 mx-auto opacity-85" style={{ background: col }} />
						<div
							className="w-2 h-2 rounded-full mx-auto -mt-1"
							style={{ background: col, boxShadow: "0 0 0 2px hsl(var(--card))" }}
						/>
						<div className="text-center mt-2 whitespace-nowrap">
							<div className="text-[13px] font-bold font-mono" style={{ color: col }}>
								{v.toFixed(1)}ms
							</div>
							<div className="text-[10px] text-muted-foreground">{lbl}</div>
						</div>
					</div>
				))}
				<div className="absolute text-[10px] text-muted-foreground" style={{ top: 18, left: 0 }}>
					0
				</div>
				<div className="absolute text-[10px] text-muted-foreground" style={{ top: 18, right: 0 }}>
					{mx.toFixed(0)}ms
				</div>
			</div>
		</div>
	);
}

// ============================================================================
// Hero Card
// ============================================================================

function HeroCard({
	label,
	value,
	unit,
	sub,
	sparkData,
	sparkColor,
	valueColor,
}: {
	label: string;
	value: string;
	unit?: string;
	sub?: string;
	sparkData?: number[];
	sparkColor?: string;
	valueColor?: string;
}) {
	return (
		<div className="bg-card border border-border rounded-md p-4 flex flex-col gap-1">
			<p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
				{label}
			</p>
			<div className="flex items-baseline gap-1.5 mt-0.5">
				<span
					className="text-[34px] font-bold leading-none font-mono tabular-nums"
					style={{ color: valueColor || "hsl(var(--foreground))" }}
				>
					{value}
				</span>
				{unit && <span className="text-xs text-muted-foreground">{unit}</span>}
			</div>
			{sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
			{sparkData && sparkData.length > 1 && (
				<div className="mt-2">
					<Sparkline data={sparkData} color={sparkColor || "hsl(var(--primary))"} />
				</div>
			)}
		</div>
	);
}

// ============================================================================
// Secondary Stat Card
// ============================================================================

function StatCard({ label, value, unit }: { label: string; value: string; unit?: string }) {
	return (
		<div className="bg-card border border-border rounded-md p-3">
			<p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground mb-1.5">
				{label}
			</p>
			<div className="flex items-baseline gap-1">
				<span className="text-[22px] font-bold font-mono text-foreground">{value}</span>
				{unit && <span className="text-xs text-muted-foreground">{unit}</span>}
			</div>
		</div>
	);
}

// ============================================================================
// Main MetricsView
// ============================================================================

function MetricsView({ metrics, historicalMetrics, isCompleted }: MetricsViewProps) {
	if (!metrics || typeof metrics.requests_completed === "undefined") {
		return (
			<div className="text-center py-12 text-muted-foreground">
				<Activity className="w-16 h-16 mx-auto mb-4 text-muted-foreground/30" />
				<p>Waiting for metrics...</p>
			</div>
		);
	}

	// Prepare chart data - last 300 points, deduplicated by 0.5s, to keep charts fast
	const chartData = useMemo(() => {
		const window = historicalMetrics.slice(-300);
		const dataByHalfSec = new Map<number, { time: number; rps: number; concurrency: number }>();
		window.forEach((m) => {
			const t = Math.round(m.elapsed_seconds * 2) / 2;
			dataByHalfSec.set(t, {
				time: t,
				rps: m.current_rps,
				concurrency: m.current_concurrency,
			});
		});
		return Array.from(dataByHalfSec.values()).sort((a, b) => a.time - b.time);
	}, [historicalMetrics]);

	// Sparkline data from last 40 historical points
	const rpsSparkData = useMemo(
		() => historicalMetrics.slice(-40).map((m) => m.current_rps),
		[historicalMetrics]
	);

	// Error rate
	const errorRate =
		metrics.requests_completed > 0
			? ((metrics.requests_failed || 0) / metrics.requests_completed) * 100
			: 0;
	const errorRateStr = `${errorRate.toFixed(1)}%`;
	const errorColor = errorRate === 0 ? "#22c55e" : "#ef4444";

	const totalReqs = formatNumber(metrics.requests_completed);
	const liveRps = formatNumber(Math.round(metrics.current_rps ?? 0));

	return (
		<div className="p-5 flex flex-col gap-3.5 max-w-[1080px]">
			{/* Row 1 — Hero cards */}
			<div className="grid grid-cols-3 gap-3">
				<HeroCard
					label="Throughput"
					value={liveRps}
					unit="req/s"
					sub={isCompleted ? "Avg RPS" : "Live — instantaneous"}
					sparkData={rpsSparkData}
					sparkColor="hsl(var(--primary))"
				/>
				<HeroCard
					label="Error Rate"
					value={errorRateStr}
					valueColor={errorColor}
					sub={`${totalReqs} total · ${formatNumber(metrics.requests_failed ?? 0)} failed`}
				/>
				<HeroCard
					label={isCompleted ? "P99 Latency" : "Avg Latency"}
					value={
						isCompleted
							? (metrics.latency_p99_ms != null ? `${metrics.latency_p99_ms.toFixed(0)}ms` : "—")
							: (metrics.avg_latency_ms != null && metrics.avg_latency_ms > 0 ? `${metrics.avg_latency_ms.toFixed(0)}ms` : "—")
					}
					sub={
						isCompleted
							? `p50: ${metrics.latency_p50_ms?.toFixed(0) ?? "—"}ms · p95: ${metrics.latency_p95_ms?.toFixed(0) ?? "—"}ms`
							: "Live average — p50/p95/p99 after test"
					}
					sparkColor="#ef4444"
				/>
			</div>

			{/* Row 2 — Latency distribution bar (completed only) */}
			{isCompleted &&
				metrics.latency_p50_ms != null &&
				metrics.latency_p95_ms != null &&
				metrics.latency_p99_ms != null && (
					<LatencyBar
						p50={metrics.latency_p50_ms}
						p95={metrics.latency_p95_ms}
						p99={metrics.latency_p99_ms}
					/>
				)}

			{/* Row 3 — RPS chart */}
			{chartData.length > 1 && (
				<div className="bg-card border border-border rounded-md p-3.5">
					<div className="flex items-center gap-2 mb-3">
						<span className="text-[12px] font-semibold text-foreground">
							Requests per Second
						</span>
						{!isCompleted && (
							<span
								className="text-[10px] font-bold text-[#22c55e] tracking-[0.05em]"
								style={{ animation: "vayu-fadepulse 2s ease-in-out infinite" }}
							>
								● LIVE
							</span>
						)}
					</div>
					<SvgAreaChart data={chartData} dataKey="rps" color="hsl(var(--primary))" height={170} />
				</div>
			)}

			{/* Row 4 — Connections chart */}
			{chartData.length > 1 && (
				<div className="bg-card border border-border rounded-md p-3.5">
					<p className="text-[12px] font-semibold text-foreground mb-3">Active Connections</p>
					<SvgAreaChart data={chartData} dataKey="concurrency" color="#6366f1" height={120} />
				</div>
			)}

			{/* Row 5 — Secondary stats */}
			<div className="grid grid-cols-4 gap-3">
				<StatCard label="Total Requests" value={totalReqs} />
				<StatCard
					label="Active Connections"
					value={formatNumber(metrics.current_concurrency ?? 0)}
				/>
				<StatCard
					label="Backpressure"
					value={formatNumber(metrics.backpressure ?? 0)}
					unit="queued"
				/>
				<StatCard
					label="Send Rate"
					value={formatNumber(Math.round(metrics.send_rate ?? 0))}
					unit="req/s"
				/>
			</div>
		</div>
	);
}

export default memo(MetricsView);
