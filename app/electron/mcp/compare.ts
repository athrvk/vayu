/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file compare.ts
 * @brief Pure server-side diff of two run reports (the `compare_runs` tool's
 *        core). Answers "did my change regress?" by comparing latency
 *        percentiles, error rate, throughput, and status-code mix. Defensive
 *        against missing fields so it works across run types.
 */

type Report = Record<string, unknown>;

function num(obj: unknown, ...path: string[]): number | null {
	let cur: unknown = obj;
	for (const key of path) {
		if (cur === null || typeof cur !== "object") return null;
		cur = (cur as Record<string, unknown>)[key];
	}
	return typeof cur === "number" && Number.isFinite(cur) ? cur : null;
}

/** A single before/after metric with absolute and percentage delta. */
export interface MetricDelta {
	metric: string;
	base: number | null;
	target: number | null;
	delta: number | null;
	pctChange: number | null;
}

function delta(metric: string, base: number | null, target: number | null): MetricDelta {
	let d: number | null = null;
	let pct: number | null = null;
	if (base !== null && target !== null) {
		d = target - base;
		pct = base !== 0 ? (d / base) * 100 : null;
	}
	return { metric, base, target, delta: d, pctChange: pct };
}

export interface RunComparison {
	baseRunId: string;
	targetRunId: string;
	latency: MetricDelta[];
	throughput: MetricDelta[];
	reliability: MetricDelta[];
	statusCodes: Record<string, { base: number; target: number }>;
}

/** Compare two engine run reports and return a structured delta. */
export function compareReports(
	baseRunId: string,
	targetRunId: string,
	base: Report,
	target: Report
): RunComparison {
	const latency = ["p50", "p90", "p95", "p99", "avg", "max"].map((p) =>
		delta(`latency.${p}`, num(base, "latency", p), num(target, "latency", p))
	);
	const throughput = [
		delta("summary.avgRps", num(base, "summary", "avgRps"), num(target, "summary", "avgRps")),
		delta(
			"summary.throughput",
			num(base, "summary", "throughput"),
			num(target, "summary", "throughput")
		),
	];
	const reliability = [
		delta(
			"summary.errorRate",
			num(base, "summary", "errorRate"),
			num(target, "summary", "errorRate")
		),
		delta(
			"summary.totalRequests",
			num(base, "summary", "totalRequests"),
			num(target, "summary", "totalRequests")
		),
	];

	const statusCodes: Record<string, { base: number; target: number }> = {};
	const collect = (report: Report, key: "base" | "target") => {
		const codes = report.statusCodes;
		if (codes && typeof codes === "object") {
			for (const [code, count] of Object.entries(codes as Record<string, unknown>)) {
				if (!statusCodes[code]) statusCodes[code] = { base: 0, target: 0 };
				if (typeof count === "number") statusCodes[code][key] = count;
			}
		}
	};
	collect(base, "base");
	collect(target, "target");

	return { baseRunId, targetRunId, latency, throughput, reliability, statusCodes };
}
