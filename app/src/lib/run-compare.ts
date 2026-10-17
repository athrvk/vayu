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
 *        which direction counts as an improvement, plus the
 *        `comparability` list that says whether the two runs were the same
 *        experiment at all (mode, virtual users, duration, status, ...).
 *
 * **This file is mirrored, on purpose, by `electron/mcp/compare.ts`.** The two
 * processes cannot share a source file: `tsconfig.node.json` emits the main
 * process with `rootDir: "electron"`, so it cannot compile a file from `src/`
 * (TS6059), and the renderer cannot import one from `electron/` either, since
 * that is a referenced composite project (TS6305) - excluding a file from it to
 * dodge that is TS6307. The mirror is therefore pinned the way this repo pins
 * its other cross-boundary copies (`lib/dynamic-variables.ts`,
 * `McpDataEntity`): a conformance test - `electron/mcp/compare.conformance.test.ts` -
 * runs *both* implementations over `engine/tests/fixtures/run-compare-conformance.json`
 * and fails on any divergence, in either direction. The engine's run-report
 * export is a third copy (`engine/src/core/run_compare.cpp`) replaying the same
 * fixture. Change this file and change the other two.
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
 * Like {@link num}, but for a flag whose absence is itself meaningful
 * (issue #1488): a report from before `metadata.configuration.acceptEncoding`
 * existed carries no such key, and reads as `false` here - which is what
 * every such run actually sent, not an unknown value defaulted away.
 */
function bool(obj: unknown, ...path: string[]): boolean {
	let cur: unknown = obj;
	for (const key of path) {
		if (cur === null || typeof cur !== "object") return false;
		cur = (cur as Record<string, unknown>)[key];
	}
	return cur === true;
}

/** A non-empty string field, or `null` when absent, empty or not a string. */
function str(obj: unknown, ...path: string[]): string | null {
	let cur: unknown = obj;
	for (const key of path) {
		if (cur === null || typeof cur !== "object") return null;
		cur = (cur as Record<string, unknown>)[key];
	}
	return typeof cur === "string" && cur !== "" ? cur : null;
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

/**
 * One reason the two runs are not the same experiment, so the deltas beside it
 * are not a clean "did it regress" (issue #2162). `base` and `target` are the
 * two values as a reader should see them, already formatted ("20 s" against
 * "3 s, stopped"), and `code` is the stable key a consumer switches on.
 */
export interface ComparabilityWarning {
	code: string;
	message: string;
	base: string;
	target: string;
}

export interface RunComparison {
	baseRunId: string;
	targetRunId: string;
	latency: MetricDelta[];
	throughput: MetricDelta[];
	reliability: MetricDelta[];
	statusCodes: Record<string, { base: number; target: number }>;
	/**
	 * Whether the two runs negotiated a compressed response differently
	 * (issue #1488) - a run recorded before `loadNegotiateCompression`'s
	 * default flipped in 0.26 reads as `false`, so an older baseline against
	 * a newer run reports a difference exactly when the newer one negotiated
	 * and the older did not. `true` means the byte and latency deltas above
	 * are not measuring the same thing. The same fact is the `compression`
	 * entry of {@link RunComparison.comparability}, which is what a reader
	 * renders; this flag stays for a consumer that wants only the one answer.
	 */
	compressionNegotiationDiffers: boolean;
	/**
	 * Every way the two runs differ in what they measured, in a fixed order
	 * (`mode`, `concurrency`, `target_rps`, `duration`, `status`,
	 * `http_version`, `data_file`, `request`, `compression`). Empty for a
	 * like-for-like pair. A field a report does not carry is unknown, not a
	 * difference, except a data file, where none against one is a real
	 * difference. Read this before the deltas: a short stopped run against a
	 * long one always looks like a throughput and tail-latency regression.
	 */
	comparability: ComparabilityWarning[];
}

/**
 * The status-code mix as `[code, count]` pairs, from either wire shape.
 *
 * The engine's report carries `std::map<int, size_t> status_codes`, and a map
 * whose keys are not strings cannot be a JSON object - nlohmann renders it as
 * an **array of `[code, count]` pairs**. Reports reaching this side have been
 * through `RunReportTransformer.toFrontend`, which folds that array into a
 * record, so the record form is what the strip actually reads; the array form
 * is what the MCP mirror reads, straight off `GET /runs/:id/report`.
 *
 * Both shapes are read here anyway, because the mirror reads both and a
 * difference between the two implementations is the defect this pair exists to
 * prevent - an agent and the UI must not report different mixes for the same
 * pair of runs. The array check comes first: an array is an object too.
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

const CONFIG = ["metadata", "configuration"] as const;

/** Past this ratio between two measured durations, the runs are different experiments. */
const DURATION_RATIO_LIMIT = 2;

/**
 * A difference only when both runs recorded a value: a report from another
 * engine version that lacks a field says nothing about it, and a warning built
 * on a missing value would be a claim the data cannot support.
 */
function warnIfDiffer<T>(
	code: string,
	message: string,
	base: T | null,
	target: T | null,
	show: (value: T) => string = String
): ComparabilityWarning | null {
	if (base === null || target === null || base === target) return null;
	return { code, message, base: show(base), target: show(target) };
}

const capitalize = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * What a run was told to vary: its concurrency, and for a ramp the start level
 * and the ramp time too, since a 1-to-50 ramp and a flat 50 are not the same
 * load.
 */
function virtualUsers(report: Report): string | null {
	const peak = num(report, ...CONFIG, "concurrency");
	if (peak === null) return null;
	if (str(report, ...CONFIG, "mode") !== "ramp_up") return String(peak);
	const start = num(report, ...CONFIG, "startConcurrency");
	const ramp = str(report, ...CONFIG, "rampUpDuration");
	return `${start === null ? "" : `${start} to `}${peak}${ramp === null ? "" : `, ramp ${ramp}`}`;
}

/** `auto` negotiates whatever the server offers, so it cannot be said to differ from either. */
function pinnedHttpVersion(report: Report): string | null {
	const version = str(report, ...CONFIG, "httpVersion");
	return version === "auto" ? null : version;
}

/** Seconds, with the status when the run did not finish: "3 s, stopped". */
function durationLabel(report: Report, seconds: number): string {
	const status = str(report, "metadata", "status");
	const unfinished = status === "stopped" || status === "failed" ? `, ${status}` : "";
	return `${Number(seconds.toFixed(1))} s${unfinished}`;
}

function durationWarning(base: Report, target: Report): ComparabilityWarning | null {
	const b = num(base, "summary", "testDuration");
	const t = num(target, "summary", "testDuration");
	if (b === null || t === null || b <= 0 || t <= 0) return null;
	if (Math.max(b, t) / Math.min(b, t) <= DURATION_RATIO_LIMIT) return null;
	return {
		code: "duration",
		message: `Run durations differ by more than ${DURATION_RATIO_LIMIT}x.`,
		base: durationLabel(base, b),
		target: durationLabel(target, t),
	};
}

const dataFileHash = (report: Report): string | null => str(report, ...CONFIG, "dataFileHash");

/** The file's name with the start of its hash, or `null` for a run that bound none. */
function dataFileLabel(report: Report): string | null {
	const hash = dataFileHash(report);
	if (hash === null) return null;
	const name = str(report, ...CONFIG, "dataFileName");
	return name === null ? hash.slice(0, 8) : `${name} (${hash.slice(0, 8)})`;
}

/** Unlike the other fields, no file on one side and a file on the other is a real difference. */
function dataFileWarning(base: Report, target: Report): ComparabilityWarning | null {
	if (dataFileHash(base) === dataFileHash(target)) return null;
	return {
		code: "data_file",
		message: "Data file differs.",
		base: dataFileLabel(base) ?? "none",
		target: dataFileLabel(target) ?? "none",
	};
}

const requestMethod = (report: Report): string | null => str(report, "metadata", "requestMethod");

/**
 * The URL with its userinfo, query and fragment dropped. A comparison is
 * embedded verbatim in an agent's context, and unlike `get_run_report` it is
 * not masked, so a credential in `?token=` must never reach `comparability`.
 * The cost is that two runs differing only in a query string read as the same
 * request, which is the right call for a comparison of "which endpoint".
 */
function requestUrl(report: Report): string | null {
	const url = str(report, "metadata", "requestUrl");
	if (url === null) return null;
	return url.replace(/[?#].*$/s, "").replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, "$1");
}

function requestLabel(report: Report): string {
	return [requestMethod(report), requestUrl(report)].filter((part) => part !== null).join(" ");
}

function requestWarning(base: Report, target: Report): ComparabilityWarning | null {
	const differs = (read: (report: Report) => string | null): boolean => {
		const b = read(base);
		const t = read(target);
		return b !== null && t !== null && b !== t;
	};
	if (!differs(requestMethod) && !differs(requestUrl)) return null;
	return {
		code: "request",
		message: "Request differs.",
		base: requestLabel(base),
		target: requestLabel(target),
	};
}

function compressionWarning(base: Report, target: Report): ComparabilityWarning | null {
	const b = bool(base, ...CONFIG, "acceptEncoding");
	const t = bool(target, ...CONFIG, "acceptEncoding");
	if (b === t) return null;
	const show = (negotiated: boolean): string => (negotiated ? "negotiated" : "not negotiated");
	return {
		code: "compression",
		message:
			"Compression negotiation differs, so byte and latency figures are not directly comparable.",
		base: show(b),
		target: show(t),
	};
}

/** In the order `RunComparison.comparability` documents; the conformance test pins it. */
const COMPARABILITY_RULES: ((base: Report, target: Report) => ComparabilityWarning | null)[] = [
	(base, target) =>
		warnIfDiffer(
			"mode",
			"Test mode differs.",
			str(base, ...CONFIG, "mode"),
			str(target, ...CONFIG, "mode")
		),
	(base, target) =>
		warnIfDiffer(
			"concurrency",
			"Virtual users differ.",
			virtualUsers(base),
			virtualUsers(target)
		),
	(base, target) =>
		warnIfDiffer(
			"target_rps",
			"Target request rate differs.",
			num(base, ...CONFIG, "targetRps"),
			num(target, ...CONFIG, "targetRps"),
			(rps) => `${rps} rps`
		),
	durationWarning,
	(base, target) =>
		warnIfDiffer(
			"status",
			"Run status differs.",
			str(base, "metadata", "status"),
			str(target, "metadata", "status"),
			capitalize
		),
	(base, target) =>
		warnIfDiffer(
			"http_version",
			"HTTP version differs.",
			pinnedHttpVersion(base),
			pinnedHttpVersion(target)
		),
	dataFileWarning,
	requestWarning,
	compressionWarning,
];

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

	const comparability = COMPARABILITY_RULES.flatMap((rule) => rule(base, target) ?? []);
	const compressionNegotiationDiffers = comparability.some((w) => w.code === "compression");

	return {
		baseRunId,
		targetRunId,
		latency,
		throughput,
		reliability,
		statusCodes,
		compressionNegotiationDiffers,
		comparability,
	};
}
