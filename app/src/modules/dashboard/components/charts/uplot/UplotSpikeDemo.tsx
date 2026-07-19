/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * UplotSpikeDemo — SPIKE (N3) showcase, not shipped UI.
 *
 * Renders three stacked charts (RPS, latency percentiles, error rate) that share
 * ONE cursor via `syncKey`, plus the capacity-breakpoint annotation on all three.
 * This is the "understand the service" thesis in one screen: hover anywhere and
 * every chart reports its value at that instant, so you can read *"at t≈38s, when
 * concurrency crossed ~180, p99 jumped past the 200ms SLO and errors began to
 * climb"* — a correlation you cannot make from three independent tooltips.
 *
 * Drag horizontally on any chart to zoom the shared time window into the moment
 * of degradation; double-click to reset. Feed it real `/stats` per-tick data in
 * place of the synthetic ramp to evaluate against actual runs.
 */

import { useMemo } from "react";
import type uPlot from "uplot";
import { TimeSeriesUPlot } from "./TimeSeriesUPlot";
import type { Annotation } from "./plugins";

const SLO_MS = 200;
const SYNC_KEY = "vayu-spike";

/** Synthetic ramp_up run: concurrency climbs, p99 elbows past the SLO, errors follow. */
function buildSyntheticRun(seconds = 120) {
	const t: number[] = [];
	const rps: number[] = [];
	const p50: number[] = [];
	const p95: number[] = [];
	const p99: number[] = [];
	const errRate: number[] = [];
	const concurrency: number[] = [];

	for (let i = 0; i <= seconds; i++) {
		const conc = Math.round((i / seconds) * 400); // ramp 0 → 400
		const past = Math.max(0, conc - 180); // degradation past the elbow
		t.push(i);
		concurrency.push(conc);
		rps.push(Math.min(5000, conc * 14) * (1 - past / 900));
		p50.push(20 + past * 0.15);
		p95.push(45 + past * 0.6);
		p99.push(80 + past * 1.4);
		errRate.push(Math.min(35, past * 0.09));
	}
	return { t, rps, p50, p95, p99, errRate, concurrency };
}

export function UplotSpikeDemo() {
	const run = useMemo(() => buildSyntheticRun(), []);

	// Capacity breakpoint: first tick p99 crosses the SLO (mirrors computeBreakpoint).
	const breakpoint = useMemo<Annotation[]>(() => {
		const idx = run.p99.findIndex((v) => v > SLO_MS);
		if (idx < 0) return [];
		return [
			{
				x: run.t[idx],
				label: `SLO ${SLO_MS}ms · ~${run.concurrency[idx]} conc`,
				color: "hsl(var(--warning))",
			},
		];
	}, [run]);

	const rpsData: uPlot.AlignedData = useMemo(() => [run.t, run.rps], [run]);
	const latData: uPlot.AlignedData = useMemo(() => [run.t, run.p50, run.p95, run.p99], [run]);
	const errData: uPlot.AlignedData = useMemo(() => [run.t, run.errRate], [run]);

	const ms: (v: number | null | undefined) => string = (v) =>
		v == null ? "—" : `${v.toFixed(0)}ms`;

	return (
		<div className="space-y-4">
			<div>
				<p className="text-sm font-medium text-foreground">Requests / sec</p>
				<TimeSeriesUPlot
					data={rpsData}
					syncKey={SYNC_KEY}
					annotations={breakpoint}
					yFormat={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`)}
					series={[
						{
							label: "RPS",
							role: "primary",
							fill: "primary",
							format: (v) => (v == null ? "—" : `${(v as number).toFixed(0)}/s`),
						},
					]}
				/>
			</div>

			<div>
				<p className="text-sm font-medium text-foreground">Latency percentiles</p>
				<TimeSeriesUPlot
					data={latData}
					syncKey={SYNC_KEY}
					annotations={breakpoint}
					series={[
						{ label: "p50", role: "success", format: ms },
						{ label: "p95", role: "warning", format: ms },
						{ label: "p99", role: "destructive", width: 1.8, format: ms },
					]}
				/>
			</div>

			<div>
				<p className="text-sm font-medium text-foreground">Error rate</p>
				<TimeSeriesUPlot
					data={errData}
					syncKey={SYNC_KEY}
					annotations={breakpoint}
					height={140}
					yFormat={(v) => `${v.toFixed(0)}%`}
					series={[
						{
							label: "Errors",
							role: "destructive",
							fill: "destructive",
							format: (v) => (v == null ? "—" : `${(v as number).toFixed(1)}%`),
						},
					]}
				/>
			</div>
		</div>
	);
}
