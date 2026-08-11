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
 *        percentiles, error rate, throughput, and status-code mix, each
 *        labelled with which direction counts as an improvement. Defensive
 *        against missing fields so it works across run types.
 *
 * **Mirrored by `app/src/lib/run-compare.ts`, which the history view's
 * vs-baseline strip uses.** Neither process can import the other's source:
 * this project emits with `rootDir: "electron"` and so cannot compile a file
 * from `src/` (TS6059), and the renderer cannot import one from here either,
 * because this is a referenced composite project (TS6305 - and excluding a
 * file from it to dodge that is TS6307). So the copy is deliberate, and
 * `compare.conformance.test.ts` runs both implementations over the same
 * fixtures and fails on any divergence. Change this file and change that one.
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
 * What a delta means, for a reader or a colour. Kept beside the diff so the
 * renderer and an agent reading `direction` cannot come to disagree about
 * which way is up.
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

/**
 * The status-code mix as `[code, count]` pairs, from either wire shape.
 *
 * The engine's report carries `std::map<int, size_t> status_codes`, and a map
 * whose keys are not strings cannot be a JSON object - nlohmann renders it as
 * an **array of `[code, count]` pairs**. The renderer never sees that form
 * (`RunReportTransformer.toFrontend` folds it into a record before any query
 * cache holds it), but this file's caller - the MCP `compare_runs` tool - reads
 * `GET /runs/:id/report` raw, so the array is exactly what arrives there.
 * Reading only the record form scored every code as absent and reported an
 * empty mix with no error.
 *
 * Both shapes therefore have to be read here, and the array check has to come
 * first: an array is an object too.
 */
function statusCodeEntries(codes: unknown): [string, unknown][] {
	if (Array.isArray(codes)) {
		const pairs: [string, unknown][] = [];
		for (const entry of codes) {
			// A pair that is not a pair says nothing about any code, so it is
			// dropped rather than keyed under an index.
			if (Array.isArray(entry) && entry.length >= 2) pairs.push([String(entry[0]), entry[1]]);
		}
		return pairs;
	}
	if (codes && typeof codes === "object") {
		return Object.entries(codes as Record<string, unknown>);
	}
	return [];
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
		for (const [code, count] of statusCodeEntries(report.statusCodes)) {
			if (!statusCodes[code]) statusCodes[code] = { base: 0, target: 0 };
			if (typeof count === "number") statusCodes[code][key] = count;
		}
	};
	collect(base, "base");
	collect(target, "target");

	return { baseRunId, targetRunId, latency, throughput, reliability, statusCodes };
}
