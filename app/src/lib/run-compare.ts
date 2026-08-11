/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file run-compare.ts
 * @brief Pure diff of two run reports: "did my change regress?" as latency,
 *        throughput, error-rate and status-code deltas, each labelled with
 *        which direction counts as an improvement.
 *
 * **This file is mirrored, on purpose, by `electron/mcp/compare.ts`.** The two
 * processes cannot share a source file: `tsconfig.node.json` emits the main
 * process with `rootDir: "electron"`, so it cannot compile a file from `src/`
 * (TS6059), and the renderer cannot import one from `electron/` either, since
 * that is a referenced composite project (TS6305) - excluding a file from it to
 * dodge that is TS6307. The mirror is therefore pinned the way this repo pins
 * its other cross-boundary copies (`lib/dynamic-variables.ts`,
 * `McpDataEntity`): a conformance test - `electron/mcp/compare.conformance.test.ts` -
 * runs *both* implementations over the same fixtures and fails on any
 * divergence, in either direction. Change this file and change that one.
 *
 * Defensive against missing fields throughout: it reads reports from any engine
 * version and any run type, and a metric a report does not carry is `null`
 * rather than a zero that would read as a real measurement.
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

/**
 * Which way is better for a metric - the half of a delta a number cannot
 * carry. `neutral` is not a hedge: `summary.totalRequests` moves with how long
 * a run was told to run, so calling either direction an improvement would
 * paint a shorter run as a regression.
 */
export type MetricDirection = "lower-is-better" | "higher-is-better" | "neutral";

/** A single before/after metric with absolute and percentage delta. */
export interface MetricDelta {
	metric: string;
	base: number | null;
	target: number | null;
	delta: number | null;
	pctChange: number | null;
	direction: MetricDirection;
}

function delta(
	metric: string,
	direction: MetricDirection,
	base: number | null,
	target: number | null
): MetricDelta {
	let d: number | null = null;
	let pct: number | null = null;
	if (base !== null && target !== null) {
		d = target - base;
		pct = base !== 0 ? (d / base) * 100 : null;
	}
	return { metric, base, target, delta: d, pctChange: pct, direction };
}

/**
 * What a delta means, for a reader or a colour. Kept here rather than in the
 * component so the renderer and an agent reading `direction` cannot come to
 * disagree about which way is up.
 *
 * `unknown` is a metric one of the two runs did not record - which is not the
 * same claim as "it did not move", and must not be painted as one.
 */
export type DeltaVerdict = "improved" | "regressed" | "unchanged" | "unknown";

export function deltaVerdict(metric: MetricDelta): DeltaVerdict {
	if (metric.delta === null) return "unknown";
	if (metric.delta === 0 || metric.direction === "neutral") return "unchanged";
	const isDown = metric.delta < 0;
	return (metric.direction === "lower-is-better") === isDown ? "improved" : "regressed";
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
		delta(`latency.${p}`, "lower-is-better", num(base, "latency", p), num(target, "latency", p))
	);
	const throughput = [
		delta(
			"summary.avgRps",
			"higher-is-better",
			num(base, "summary", "avgRps"),
			num(target, "summary", "avgRps")
		),
		delta(
			"summary.throughput",
			"higher-is-better",
			num(base, "summary", "throughput"),
			num(target, "summary", "throughput")
		),
	];
	const reliability = [
		delta(
			"summary.errorRate",
			"lower-is-better",
			num(base, "summary", "errorRate"),
			num(target, "summary", "errorRate")
		),
		delta(
			"summary.totalRequests",
			"neutral",
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
