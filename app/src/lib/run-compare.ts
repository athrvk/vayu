/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file run-compare.ts
 * @brief Pure diff of two run reports: "did my change regress?" as latency, throughput, error-rate,
 *        status-code, stream and shared custom-metric deltas, each labelled with which direction
 *        counts as an improvement, plus the `comparability` list that says whether the two runs were
 *        the same experiment at all (mode, virtual users, duration, status, ...).
 *
 * **This file is mirrored, on purpose, by `electron/mcp/compare.ts`.** The two processes cannot
 * share a source file: `tsconfig.node.json` emits the main process with `rootDir: "electron"`, so
 * it cannot compile a file from `src/` (TS6059), and the renderer cannot import one from
 * `electron/` either, since that is a referenced composite project (TS6305; excluding a file from
 * it to dodge that is TS6307). So the mirror is pinned the way this repo pins its other
 * cross-boundary copies (`lib/dynamic-variables.ts`, `McpDataEntity`):
 * `electron/mcp/compare.conformance.test.ts` runs *both* implementations over
 * `engine/tests/fixtures/run-compare-conformance.json` and fails on any divergence, in either
 * direction. The engine's run-report export is a third copy (`engine/src/core/run_compare.cpp`)
 * replaying the same fixture. Change this file and change the other two.
 *
 * Defensive against missing fields throughout: it reads reports from any engine version and any run
 * type, and a metric a report does not carry is `null` rather than a zero that would read as a real
 * measurement. So is a figure the report carries but says the engine did not record
 * (`summary.summaryMissing`, `summary.partial`, #2904), per side: see `recordedNum`.
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
 * Like {@link num}, but for a flag whose absence is itself meaningful (#1488, #2516): a report from
 * before `metadata.configuration.acceptEncoding` or `expectContinue` existed carries no such key,
 * and reads as `false` here, which is what every such run actually sent, not an unknown value
 * defaulted away.
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
 * Which way is better for a metric: the half of a delta a number cannot carry. `neutral` is not a
 * hedge: `summary.totalRequests` moves with how long a run was told to run, so calling either
 * direction an improvement would paint a shorter run as a regression.
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
 * What a delta means, for a reader or a colour. Here rather than in the component so the renderer
 * and an agent reading `direction` cannot come to disagree about which way is up. `unknown` is a
 * metric one of the two runs did not record, which is not the claim "it did not move" and must not
 * be painted as one.
 */
export type DeltaVerdict = "improved" | "regressed" | "unchanged" | "unknown";

export function deltaVerdict(metric: MetricDelta): DeltaVerdict {
	if (metric.delta === null) return "unknown";
	if (metric.delta === 0 || metric.direction === "neutral") return "unchanged";
	const isDown = metric.delta < 0;
	return (metric.direction === "lower-is-better") === isDown ? "improved" : "regressed";
}

/**
 * One reason the two runs are not the same experiment, so the deltas beside it are not a clean "did
 * it regress" (#2162). `base` and `target` are the two values as a reader should see them, already
 * formatted ("20 s" against "3 s, stopped"), and `code` is the stable key a consumer switches on.
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
	 * The mcp failure classes (#3828) of two runs that both recorded them,
	 * `{}` when either did not: a run stored before the engine counted them has
	 * no figure, and reading it as 0 would show a regression that never
	 * happened. `protocolCodes` is not compared.
	 */
	errorClasses: ErrorClassDeltas;
	/**
	 * The report's top-level `stream` figures, one row for each both runs carry (`stream.timeToFirstEvent.p50`
	 * ... `stream.eventsPerSecond`); `[]` when either run never streamed (#3781).
	 */
	stream: MetricDelta[];
	/**
	 * The custom metrics both runs recorded under the same type (`customMetrics.<name>.p50`,
	 * `.p95` or `.value`), `neutral`: the data carries no direction (#3781).
	 */
	customMetrics: MetricDelta[];
	/**
	 * Whether the two runs negotiated a compressed response differently (#1488). A run recorded
	 * before `loadNegotiateCompression`'s default flipped in 0.26 reads as `false`, so an older
	 * baseline against a newer run reports a difference exactly when the newer one negotiated and
	 * the older did not. `true` means the byte and latency deltas above are not measuring the same
	 * thing. The same fact is the `compression` entry of {@link RunComparison.comparability}, which
	 * is what a reader renders; this flag stays for a consumer that wants only the one answer.
	 */
	compressionNegotiationDiffers: boolean;
	/**
	 * Every way the two runs differ in what they measured, in a fixed order (`run_type`, `mode`,
	 * `concurrency`, `target_rps`, `duration`, `status`, `http_version`, `data_file`, `request`,
	 * `compression`, `expect_continue`); empty for a like-for-like pair. When both reports carry
	 * `metadata.runType`, a `mode`, `concurrency` or `target_rps` only one of them recorded is a
	 * difference, its missing side `not recorded`; otherwise a field a report does not carry is
	 * unknown, not a difference, except a data file, where none against one is a real difference.
	 * Read this before the deltas: a short stopped run against a long one always looks like a
	 * throughput and tail-latency regression.
	 */
	comparability: ComparabilityWarning[];
}

/**
 * The status-code mix as `[code, count]` pairs, from either wire shape. The engine's report carries
 * `std::map<int, size_t> status_codes`, and a map whose keys are not strings cannot be a JSON
 * object, so nlohmann renders it as an **array of `[code, count]` pairs**. Reports reaching this
 * side have been through `RunReportTransformer.toFrontend`, which folds that array into a record,
 * so the record form is what the strip reads; the array form is what the MCP mirror reads, straight
 * off `GET /runs/:id/report`.
 *
 * Both shapes are read here anyway, because the mirror reads both and a difference between the two
 * implementations is the defect this pair exists to prevent: an agent and the UI must not report
 * different mixes for the same pair of runs. The array check comes first: an array is an object
 * too.
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

const runType = (report: Report): string | null => str(report, "metadata", "runType");

/** The run type as the app names it in History. */
function runTypeLabel(type: string): string {
	switch (type) {
		case "design":
			return "Send";
		case "load":
			return "Load test";
		case "scenario":
			return "Collection run";
		default:
			return type;
	}
}

const NOT_RECORDED = "not recorded";

/**
 * {@link warnIfDiffer} for a field of the run's configuration (#2438). `metadata.runType` marks a
 * report from an engine that records each field a run was given, so once both reports carry it, a
 * field only one recorded is one the other run was not given: a real difference, not an older
 * engine's silence.
 */
function warnIfConfigDiffers<T>(
	code: string,
	message: string,
	base: Report,
	target: Report,
	read: (report: Report) => T | null,
	show: (value: T) => string = String
): ComparabilityWarning | null {
	const b = read(base);
	const t = read(target);
	const recordedOnOneSide = (b === null) !== (t === null);
	if (recordedOnOneSide && runType(base) !== null && runType(target) !== null) {
		const label = (value: T | null): string => (value === null ? NOT_RECORDED : show(value));
		return { code, message, base: label(b), target: label(t) };
	}
	return warnIfDiffer(code, message, b, t, show);
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
const dataFileCast = (report: Report): boolean => bool(report, ...CONFIG, "dataFileCastNumbers");

/** The file's name with the start of its hash, or `null` for a run that bound none. */
function dataFileLabel(report: Report): string | null {
	const hash = dataFileHash(report);
	if (hash === null) return null;
	const name = str(report, ...CONFIG, "dataFileName");
	const label = name === null ? hash.slice(0, 8) : `${name} (${hash.slice(0, 8)})`;
	return dataFileCast(report) ? `${label}, numbers read as numbers` : label;
}

/**
 * Unlike the other fields, no file on one side and a file on the other is a
 * real difference. The hash is of the file's bytes, so one file read with and
 * without its numbers cast (#2540) differs too.
 */
function dataFileWarning(base: Report, target: Report): ComparabilityWarning | null {
	const hash = dataFileHash(base);
	const sameReading = hash === null || dataFileCast(base) === dataFileCast(target);
	if (hash === dataFileHash(target) && sameReading) return null;
	return {
		code: "data_file",
		message: "Data file differs.",
		base: dataFileLabel(base) ?? "none",
		target: dataFileLabel(target) ?? "none",
	};
}

const requestMethod = (report: Report): string | null => str(report, "metadata", "requestMethod");

/**
 * The URL with its userinfo, query and fragment dropped. A comparison is embedded verbatim in an
 * agent's context, and unlike `get_run_report` it is not masked, so a credential in `?token=` must
 * never reach `comparability`. The cost: two runs differing only in a query string read as the same
 * request, the right call for a comparison of "which endpoint".
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

function expectContinueWarning(base: Report, target: Report): ComparabilityWarning | null {
	const b = bool(base, ...CONFIG, "expectContinue");
	const t = bool(target, ...CONFIG, "expectContinue");
	if (b === t) return null;
	const show = (allowed: boolean): string => (allowed ? "allowed" : "not allowed");
	return {
		code: "expect_continue",
		message:
			"Expect: 100-continue handling differs, so large-body latency figures are not directly comparable.",
		base: show(b),
		target: show(t),
	};
}

/** In the order `RunComparison.comparability` documents; the conformance test pins it. */
const COMPARABILITY_RULES: ((base: Report, target: Report) => ComparabilityWarning | null)[] = [
	// A collection's load run is `load` too, so it compares with a single
	// request's load run without this entry.
	(base, target) =>
		warnIfDiffer(
			"run_type",
			"Run types differ, so these figures measure different things.",
			runType(base),
			runType(target),
			runTypeLabel
		),
	(base, target) =>
		warnIfConfigDiffers("mode", "Test mode differs.", base, target, (report) =>
			str(report, ...CONFIG, "mode")
		),
	(base, target) =>
		warnIfConfigDiffers("concurrency", "Virtual users differ.", base, target, virtualUsers),
	(base, target) =>
		warnIfConfigDiffers(
			"target_rps",
			"Target request rate differs.",
			base,
			target,
			(report) => num(report, ...CONFIG, "targetRps"),
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
	expectContinueWarning,
];

/**
 * A figure of the report's `latency` or `summary` block, or `null` where the engine did not record
 * it (#2904): `summary.summaryMissing` (a failed run with no summary) leaves the counts and the
 * latency block unreliable, and `summary.partial` (reconciled after a crash) leaves the latency
 * block out (#2938); the flag is still checked, for an export that predates the omission and
 * carries zeros. A 0 read through here would be a measurement no run made, and a delta against it a
 * regression no run showed. Read per side, so one unrecorded run nulls only its own column. Mirrors
 * `unrecordedFiguresOf` (`modules/history/main/components/unrecorded-figures.ts`).
 */
function recordedNum(report: Report, section: "latency" | "summary", key: string): number | null {
	if (bool(report, "summary", "summaryMissing")) return null;
	if (section === "latency" && bool(report, "summary", "partial")) return null;
	return num(report, section, key);
}

/**
 * The classes `summary.errorClasses` counts (#3828), in the order every reader
 * shows them. `protocolCodes` is the engine's finer split of `protocol` and is
 * not compared.
 */
export const ERROR_CLASS_KEYS = ["transport", "protocol", "tool"] as const;

export type ErrorClassKey = (typeof ERROR_CLASS_KEYS)[number];

/** Each class a run counted, `{ base, target }`; a class neither run counted is absent. */
export type ErrorClassDeltas = Partial<Record<ErrorClassKey, { base: number; target: number }>>;

/**
 * `summary.errorClasses` as the report carries it, or `null` for a run that
 * never recorded one (stored before #3828). `{}` is a recording: nothing
 * failed. Told apart here because an unrecorded side read as 0 would fake a
 * regression against it.
 */
function recordedErrorClasses(report: Report): Record<string, unknown> | null {
	const summary = report.summary;
	if (summary === null || typeof summary !== "object") return null;
	const classes = (summary as Report).errorClasses;
	if (classes === null || typeof classes !== "object" || Array.isArray(classes)) return null;
	return classes as Record<string, unknown>;
}

/**
 * Per-class counts of the two runs, only when both recorded them. A class
 * either side counted as a finite number is listed, the other side's missing
 * count being 0; any other value reads as not counted.
 */
function errorClassDeltas(base: Report, target: Report): ErrorClassDeltas {
	const baseCounts = recordedErrorClasses(base);
	const targetCounts = recordedErrorClasses(target);
	const deltas: ErrorClassDeltas = {};
	if (baseCounts === null || targetCounts === null) return deltas;
	const counted = (value: unknown) =>
		typeof value === "number" && Number.isFinite(value) ? value : null;
	for (const key of ERROR_CLASS_KEYS) {
		const from = counted(baseCounts[key]);
		const to = counted(targetCounts[key]);
		if (from === null && to === null) continue;
		deltas[key] = { base: from ?? 0, target: to ?? 0 };
	}
	return deltas;
}

/**
 * A row for `path` only when both reports carry a finite number there (#3781): a run that never
 * streamed, or never recorded the metric, has no figure, and a 0 read in its place would show a
 * change that never happened. Unlike {@link delta}, a side is never `null`.
 */
function sharedDelta(
	metric: string,
	direction: MetricDirection,
	base: Report,
	target: Report,
	path: string[]
): MetricDelta[] {
	const from = num(base, ...path);
	const to = num(target, ...path);
	return from === null || to === null ? [] : [delta(metric, direction, from, to)];
}

/**
 * In the order the report documents them. `stream.events.p50` is how many events a stream
 * delivered, which no direction improves.
 */
const STREAM_METRICS: readonly (readonly [path: string, direction: MetricDirection])[] = [
	["stream.timeToFirstEvent.p50", "lower-is-better"],
	["stream.timeToFirstEvent.p95", "lower-is-better"],
	["stream.timeToFirstMatch.p50", "lower-is-better"],
	["stream.timeToFirstMatch.p95", "lower-is-better"],
	["stream.maxEventGap.p95", "lower-is-better"],
	["stream.eventRate.p50", "higher-is-better"],
	["stream.eventsPerSecond", "higher-is-better"],
	["stream.events.p50", "neutral"],
];

function streamDeltas(base: Report, target: Report): MetricDelta[] {
	return STREAM_METRICS.flatMap(([path, direction]) =>
		sharedDelta(path, direction, base, target, path.split("."))
	);
}

/** The figures a custom metric of `type` is compared on; none for a type the engine does not name. */
function customMetricFields(type: string): readonly string[] {
	if (type === "trend") return ["p50", "p95"];
	if (type === "counter" || type === "rate") return ["value"];
	return [];
}

/** The report's `customMetrics` names, or none when the block is absent or not an object. */
function customMetricNames(report: Report): string[] {
	const block = report.customMetrics;
	if (block === null || typeof block !== "object" || Array.isArray(block)) return [];
	// The engine walks its keys in byte order of the UTF-8 name; a plain sort is UTF-16 code-unit
	// order, which agrees with it for every name outside the astral planes.
	return Object.keys(block).sort();
}

/**
 * Every name both reports carry as the same type, in name order, each on its type's figures. A name
 * recorded as one type by one run and another by the other compares nothing: a trend's percentile
 * is not a counter's total. No direction is recorded for a custom metric, so none is claimed.
 */
function customMetricDeltas(base: Report, target: Report): MetricDelta[] {
	return customMetricNames(base).flatMap((name) => {
		const type = str(base, "customMetrics", name, "type");
		if (type === null || type !== str(target, "customMetrics", name, "type")) return [];
		return customMetricFields(type).flatMap((field) =>
			sharedDelta(`customMetrics.${name}.${field}`, "neutral", base, target, [
				"customMetrics",
				name,
				field,
			])
		);
	});
}

/** Compare two engine run reports and return a structured delta. */
export function compareReports(
	baseRunId: string,
	targetRunId: string,
	base: Report,
	target: Report
): RunComparison {
	const latency = ["p50", "p90", "p95", "p99", "avg", "max"].map((p) =>
		delta(
			`latency.${p}`,
			"lower-is-better",
			recordedNum(base, "latency", p),
			recordedNum(target, "latency", p)
		)
	);
	const throughput = [
		delta(
			"summary.avgRps",
			"higher-is-better",
			recordedNum(base, "summary", "avgRps"),
			recordedNum(target, "summary", "avgRps")
		),
		delta(
			"summary.throughput",
			"higher-is-better",
			recordedNum(base, "summary", "throughput"),
			recordedNum(target, "summary", "throughput")
		),
	];
	const reliability = [
		delta(
			"summary.errorRate",
			"lower-is-better",
			recordedNum(base, "summary", "errorRate"),
			recordedNum(target, "summary", "errorRate")
		),
		delta(
			"summary.totalRequests",
			"neutral",
			recordedNum(base, "summary", "totalRequests"),
			recordedNum(target, "summary", "totalRequests")
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
		errorClasses: errorClassDeltas(base, target),
		stream: streamDeltas(base, target),
		customMetrics: customMetricDeltas(base, target),
		compressionNegotiationDiffers,
		comparability,
	};
}
