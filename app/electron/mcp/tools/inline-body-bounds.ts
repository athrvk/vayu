/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @brief How much of a body, a trace and a run report one tool result carries
 *        inline (#767, #769).
 */

import { HEADER_BODY_SEPARATOR } from "../withhold.js";
import { isRecord } from "./kit.js";

/**
 * How much of a body a tool result carries inline (issue #767).
 *
 * A tool-result budget, not an engine one. No engine cap fits. The config entry
 * that bounds a single response, `maxResponseBodyBytes`, is still the load
 * path's alone ("Design-mode sends are not affected"); `maxTraceBodyBytes`
 * (5MB) is a storage bound sized for a human opening one full trace in the UI;
 * and `maxDesignResponseBodyBytes` (32MB, issue #1157) does bound a design send
 * - it is why an agent can no longer be handed an unbounded body - but 32MB is
 * a "keep the engine's memory finite" number, three orders of magnitude past
 * what a tool result can carry. Between them a design send returns every byte
 * it read up to 32MB: an ordinary page fetch came back as 1.3M characters and
 * exceeded the tool-result token limit outright, with nothing in between the
 * engine's answer and the agent.
 *
 * 32KB is not a new number: it is `maxSampleBodyBytes`
 * (`DEFAULT_MAX_SAMPLE_BODY_BYTES`, engine `constants.hpp`), this codebase's own
 * answer to "how much of a body does an automated reader get" for load-run
 * captures. Fixed rather than read from live config: `run_request` has just
 * sent a real request and should not pay a second round trip for a number that
 * only has to be reasonable, and a constant is what the tests can pin.
 */
export const MAX_INLINE_BODY_BYTES = 32_768;

/**
 * The start of the UTF-8 character byte @p at of @p buf falls in: @p at itself
 * unless it is a continuation byte. A cut there never lands mid-character, where
 * a split code point comes back as a replacement glyph, which an agent reads as
 * content the response never carried.
 */
export function utf8CharStart(buf: Uint8Array, at: number): number {
	let start = at;
	while (start > 0 && (buf[start] & 0xc0) === 0x80) start--;
	return start;
}

/** Cut a string to at most `maxBytes` UTF-8 bytes on a character boundary, reporting its true size. */
export function boundText(
	text: string,
	maxBytes = MAX_INLINE_BODY_BYTES
): { text: string; truncated: boolean; bytes: number } {
	const buf = Buffer.from(text, "utf8");
	if (buf.byteLength <= maxBytes) return { text, truncated: false, bytes: buf.byteLength };
	const end = utf8CharStart(buf, maxBytes);
	return { text: buf.subarray(0, end).toString("utf8"), truncated: true, bytes: buf.byteLength };
}

/**
 * Cut standard base64 text to at most `maxBytes` *decoded* bytes, reporting the
 * decoded size: the engine's `cap_base64_node_body`, rule for rule.
 *
 * Whole four-character groups only, so the prefix is itself valid base64 of the
 * first bytes; a cut inside a group would not decode.
 */
function boundBase64(
	text: string,
	maxBytes = MAX_INLINE_BODY_BYTES
): { text: string; truncated: boolean; bytes: number } {
	let unpadded = text.length;
	while (unpadded > 0 && text[unpadded - 1] === "=") unpadded--;
	const bytes = Math.floor((unpadded * 3) / 4);
	if (bytes <= maxBytes) return { text, truncated: false, bytes };
	return { text: text.slice(0, Math.floor(maxBytes / 3) * 4), truncated: true, bytes };
}

/**
 * Bound the body a record carries in @p text, by the spelling its sibling
 * `bodyEncoding` names (#2458): `"base64"` is counted and cut in decoded bytes,
 * and anything else, absent included, is UTF-8 text.
 */
function boundBody(
	record: Record<string, unknown>,
	text: string
): { text: string; truncated: boolean; bytes: number } {
	return record.bodyEncoding === "base64" ? boundBase64(text) : boundText(text);
}

/**
 * Bound a node's `rawRequest` wire message, cutting the body half only.
 *
 * The engine's rule for this field, kept rather than re-decided
 * (`cap_node_raw_request`, `engine/src/utils/json.cpp`): the header block is the
 * reason the field exists - it carries the `Cookie` line libcurl attached, which
 * appears nowhere else - so a cut that ate the headers would take exactly what
 * the reader opened it for. A message with no blank line has no body to cut.
 *
 * Unlike the engine, this records the cut explicitly. The engine can lean on the
 * `bodyTruncated` pair beside it because both are capped at one limit at write
 * time; a tool result has to say so on its own, since the field an agent reads
 * here sits beside the *response*'s size fields, not the request body's.
 *
 * Returns the node unchanged (same reference) when nothing was cut, so callers
 * can tell "bounded" from "untouched" without re-comparing content.
 */
function boundWireMessage(node: Record<string, unknown>): Record<string, unknown> {
	const raw = node.rawRequest;
	if (typeof raw !== "string") return node;
	const separator = raw.indexOf(HEADER_BODY_SEPARATOR);
	if (separator === -1) return node;
	const bodyStart = separator + HEADER_BODY_SEPARATOR.length;
	const bounded = boundText(raw.slice(bodyStart));
	if (!bounded.truncated) return node;
	return {
		...node,
		rawRequest: raw.slice(0, bodyStart) + bounded.text,
		rawRequestTruncated: true,
		rawRequestBytes: Buffer.byteLength(raw, "utf8"),
	};
}

/**
 * Bound one `POST /execute` response - what `run_request` hands back.
 *
 * `bodySize` is the engine's own byte count for this body and is exactly what a
 * truncation flag refers to, so it is used rather than recomputed; it is only
 * filled in when the engine sent no usable one.
 *
 * The engine's `bodyCapped` (issue #1157) is carried through untouched, and the
 * two flags must stay distinguishable: `bodyTruncated` set here means this tool
 * result is showing less than the engine returned, which `read_body` pages
 * out of the stored trace, while `bodyCapped` means the engine never read more than
 * this - re-sending returns the same prefix, and only raising
 * `maxDesignResponseBodyBytes` changes it. Both can be true of one response.
 */
export function boundExecuteResponse(value: unknown): unknown {
	if (!isRecord(value)) return value;
	let out = value;
	const bodyRaw = value.bodyRaw;
	if (typeof bodyRaw === "string") {
		const bounded = boundBody(value, bodyRaw);
		if (bounded.truncated) {
			out = {
				...out,
				bodyRaw: bounded.text,
				// The parsed body holds the same payload verbatim, so leaving it
				// would hand back in full the very bytes `bodyRaw` now says were
				// cut - the JSON-doubling case. Null rather than deleted:
				// `serialize(Response)` always emits this key, and null is already
				// its "nothing parsed here" value, so a truncated response keeps
				// the shape every reader of this tool already parses.
				body: null,
				bodyTruncated: true,
				...(typeof value.bodySize === "number" ? {} : { bodySize: bounded.bytes }),
			};
		}
	}
	return boundWireMessage(out);
}

/**
 * Bound one stored-trace node (`trace.request` or `trace.response`).
 *
 * Mirrors the engine's own disclosure pair for a cut body
 * (`cap_node_body`): `bodyTruncated` plus `bodyBytes` holding the *original*
 * size, so an agent that has read one convention recognises the other.
 */
export function boundTraceNode(node: unknown): unknown {
	if (!isRecord(node)) return node;
	let out = node;
	const body = node.body;
	if (typeof body === "string") {
		const bounded = boundBody(node, body);
		if (bounded.truncated) {
			out = {
				...out,
				body: bounded.text,
				bodyTruncated: true,
				// Only when the engine recorded none. A trace it already cut at
				// `maxTraceBodyBytes` carries the true original size here, and
				// overwriting that with the size of the 5MB slice we re-cut would
				// replace a real number with a smaller one that looks just as real.
				...(typeof node.bodyBytes === "number" ? {} : { bodyBytes: bounded.bytes }),
			};
		}
	}
	return boundWireMessage(out);
}

/**
 * How many bytes of stored trace one run report carries in total (issue #769).
 *
 * The per-node bound above does not bound the *result*: the report route caps
 * `results[]` at 100 rows for a single-request run (every stored step for a
 * scenario run, bounded when written), and each row may keep up to
 * `MAX_INLINE_BODY_BYTES` on each of three nodes, so a 100-step scenario
 * measured at 3.3M characters with every node honestly flagged as truncated -
 * 2.5x the 1.3M that made #767 fail in the first place. Truncation stops being the binding constraint at
 * that row count: 100 steps of an 8KB body, well under the per-node bound and
 * so never touched, still totalled 845K characters.
 *
 * 96KB is `MAX_INLINE_BODY_BYTES * 3`: the largest single row the per-node
 * bound can produce (a request body, a response body and a `rawRequest`, each
 * at the cap), derived from the existing bound rather than invented beside it.
 * That is the number with a reason - a budget below it would drop rows for
 * being merely as big as one row is allowed to be - and it leaves the whole
 * result an order of magnitude under the 1.3M characters that failed in #767,
 * or dozens of rows when the bodies are ordinary.
 *
 * It bounds the traces, not the report: the row scalars (id, status, latency,
 * step identity) are ~200 bytes a row, so 100 of them are noise beside one
 * body, and they are never dropped - the run's shape is the answer even when
 * the payloads cannot come along, which is why no second row cap is needed.
 */
export const MAX_REPORT_TRACE_BYTES = MAX_INLINE_BODY_BYTES * 3;

/**
 * Whether a row's trace is one to keep first when the budget cannot hold them
 * all, mirroring the engine's own thinning rule for `stepsStored`
 * (`ScenarioStepStore::add`, called with `outcome != Passed`) so the two do not
 * disagree about which steps matter.
 *
 * A row the engine stamped no outcome on is a design-mode row, where the engine
 * has no rule to disagree with; its transport error is the only failure signal
 * it carries.
 */
function isPriorityTraceRow(row: Record<string, unknown>): boolean {
	const trace = row.trace;
	if (isRecord(trace) && typeof trace.outcome === "string") return trace.outcome !== "passed";
	return typeof row.error === "string" && row.error !== "";
}

/** The nodes a trace, and each `pm.sendRequest` record on it, holds an exchange in. */
const EXCHANGE_NODES = ["request", "response"] as const;

type JsonRecord = Record<string, unknown>;

/**
 * @p holder with its `request` and `response` nodes each passed through
 * @p perNode; same reference when neither changed. An absent node stays
 * absent: a skipped step's erased `response` must not come back as a server
 * that answered with nothing.
 */
function mapExchangeNodes(holder: JsonRecord, perNode: (node: unknown) => unknown): JsonRecord {
	let out = holder;
	for (const key of EXCHANGE_NODES) {
		if (!(key in holder)) continue;
		const next = perNode(holder[key]);
		if (next !== holder[key]) out = { ...out, [key]: next };
	}
	return out;
}

/**
 * @p holder with each of its `scriptRequests` records (#3633) passed through
 * @p perRecord; same reference when none changed. The member sits on a trace's
 * `scripts` node and on a `lifecycle` row alike.
 */
function mapScriptRequests(
	holder: JsonRecord,
	perRecord: (record: JsonRecord) => JsonRecord
): JsonRecord {
	const records = holder.scriptRequests;
	if (!Array.isArray(records)) return holder;
	const next = records.map((record) => (isRecord(record) ? perRecord(record) : record));
	return next.some((record, i) => record !== records[i])
		? { ...holder, scriptRequests: next }
		: holder;
}

/** @p trace with its `scripts` node passed through @p change, when it has one. */
function mapScriptsNode(
	trace: JsonRecord,
	change: (scripts: JsonRecord) => JsonRecord
): JsonRecord {
	if (!isRecord(trace.scripts)) return trace;
	const scripts = change(trace.scripts);
	return scripts === trace.scripts ? trace : { ...trace, scripts };
}

/** A `pm.sendRequest` record with its two nodes bounded as a trace's are. */
function boundRecordNodes(record: JsonRecord): JsonRecord {
	return mapExchangeNodes(record, boundTraceNode);
}

/**
 * A node with its body given up whole, written as the engine writes a record
 * body its shared budget had no room left for: `""` beside `bodyTruncated` and
 * the true `bodyBytes`, so a shed body reads like one the engine shed.
 */
function shedNodeBody(node: unknown): unknown {
	if (!isRecord(node) || typeof node.body !== "string" || node.body === "") return node;
	const bytes =
		typeof node.bodyBytes === "number" ? node.bodyBytes : boundBody(node, node.body).bytes;
	return { ...node, body: "", bodyTruncated: true, bodyBytes: bytes };
}

/**
 * @p holder with every body of its `scriptRequests` records given up and
 * `scriptRequestBodiesOmitted: true` beside them; same reference when there was
 * no body to give up. The records themselves stay: without their bodies they
 * are each call's method, URL, status, headers and timing.
 */
function shedScriptRequestBodies(holder: JsonRecord): JsonRecord {
	const shed = mapScriptRequests(holder, (record) => mapExchangeNodes(record, shedNodeBody));
	return shed === holder ? holder : { ...shed, scriptRequestBodiesOmitted: true };
}

/** The members of a record, top level and `request`, that its summary keeps. */
const SUMMARY_MEMBERS = ["source", "scope", "status", "error_type", "totalMs"] as const;
const SUMMARY_REQUEST_MEMBERS = ["method", "url"] as const;

function pickMembers(from: JsonRecord, keys: readonly string[]): JsonRecord {
	return Object.fromEntries(keys.filter((key) => key in from).map((key) => [key, from[key]]));
}

/**
 * A record cut to which call it was and how it ended: its source and scope,
 * `request.method` and `request.url`, status, error code and total time. What
 * is gone is what has no fixed size: the header maps and lines, the redirect
 * hops, the timing phases and the response node.
 */
function summarizeRecord(record: JsonRecord): JsonRecord {
	const summary = pickMembers(record, SUMMARY_MEMBERS);
	if (isRecord(record.request)) {
		summary.request = pickMembers(record.request, SUMMARY_REQUEST_MEMBERS);
	}
	return summary;
}

/**
 * @p holder with every `scriptRequests` record cut to its summary and
 * `scriptRequestDetailOmitted: true` beside them; same reference when it has no
 * records. The array keeps its order, so a console line's `scriptRequest`
 * index still names its call.
 */
function summarizeScriptRequests(holder: JsonRecord): JsonRecord {
	const records = holder.scriptRequests;
	if (!Array.isArray(records) || records.length === 0) return holder;
	return {
		...holder,
		scriptRequests: records.map((record) =>
			isRecord(record) ? summarizeRecord(record) : record
		),
		scriptRequestDetailOmitted: true,
	};
}

/**
 * @p holder without its `scriptRequests`, their count in `scriptRequestsOmitted`
 * instead; same reference when it has no records. The earlier steps' flags go
 * with the records they described.
 */
function omitScriptRequests(holder: JsonRecord): JsonRecord {
	const records = holder.scriptRequests;
	if (!Array.isArray(records) || records.length === 0) return holder;
	const out: JsonRecord = { ...holder, scriptRequestsOmitted: records.length };
	delete out.scriptRequests;
	delete out.scriptRequestBodiesOmitted;
	delete out.scriptRequestDetailOmitted;
	return out;
}

/**
 * What a holder of `scriptRequests` gives up, least first, while it is over
 * what is left of its budget: the records' bodies, then each record's detail
 * down to its summary, then the records themselves. The last step leaves
 * nothing of the records to measure, so a holder that is still over after it
 * is over on its own account, never theirs.
 */
const SCRIPT_REQUEST_SHEDS: readonly ((holder: JsonRecord) => JsonRecord)[] = [
	shedScriptRequestBodies,
	summarizeScriptRequests,
	omitScriptRequests,
];

/**
 * @p value after the fewest {@link SCRIPT_REQUEST_SHEDS} steps that bring it
 * within @p remaining, each applied through @p apply, with its size by
 * @p measure; every step applied when none does. @p bytes is @p value's size.
 */
function shedToFit(
	value: JsonRecord,
	bytes: number,
	remaining: number,
	apply: (value: JsonRecord, shed: (holder: JsonRecord) => JsonRecord) => JsonRecord,
	measure: (value: JsonRecord) => number
): { value: JsonRecord; bytes: number } {
	let out = { value, bytes };
	for (const shed of SCRIPT_REQUEST_SHEDS) {
		if (out.bytes <= remaining) break;
		const next = apply(out.value, shed);
		if (next !== out.value) out = { value: next, bytes: measure(next) };
	}
	return out;
}

/** @p trace with every node bounded per node, its `pm.sendRequest` records' included. */
function boundTrace(trace: JsonRecord): JsonRecord {
	return mapScriptsNode(mapExchangeNodes(trace, boundTraceNode), (scripts) =>
		mapScriptRequests(scripts, boundRecordNodes)
	);
}

function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** One report row that carries a trace, with that trace bounded per node and measured. */
interface TracedRow {
	row: JsonRecord;
	/** The per-node-bounded trace, the records' nodes included. */
	trace: JsonRecord;
	/** The compact size of {@link TracedRow.trace}, what the row would embed. */
	bytes: number;
	priority: boolean;
}

/**
 * The trace @p entry embeds out of the @p remaining budget, or undefined when
 * it embeds none. A trace over what is left gives up its script requests
 * (#3633) step by step ({@link SCRIPT_REQUEST_SHEDS}) before anything of its
 * own, so the records never cost a row its main exchange; only a trace still
 * over with no records left loses it. The @p first trace is embedded whatever
 * it costs, but sheds the same way before it is, so a lone design row is
 * bounded too.
 */
function fitTrace(
	entry: TracedRow,
	remaining: number,
	first: boolean
): { trace: JsonRecord; bytes: number } | undefined {
	const fitted = shedToFit(entry.trace, entry.bytes, remaining, mapScriptsNode, jsonBytes);
	return first || fitted.bytes <= remaining
		? { trace: fitted.value, bytes: fitted.bytes }
		: undefined;
}

function isTraced(entry: TracedRow | undefined): entry is TracedRow {
	return entry !== undefined;
}

/**
 * The report's `results` with every trace bounded per node, and the traces
 * together held to {@link MAX_REPORT_TRACE_BYTES} (see {@link boundRunReport}).
 */
function boundResultTraces(report: JsonRecord): JsonRecord {
	if (!Array.isArray(report.results)) return report;
	const results: unknown[] = report.results;
	const traced = results.map((row): TracedRow | undefined => {
		if (!isRecord(row) || !isRecord(row.trace)) return undefined;
		const trace = boundTrace(row.trace);
		return { row, trace, bytes: jsonBytes(trace), priority: isPriorityTraceRow(row) };
	});

	// Spend the budget on the rows that matter first, then in run order.
	const candidates = traced.filter(isTraced);
	const spendOrder = [
		...candidates.filter((entry) => entry.priority),
		...candidates.filter((entry) => !entry.priority),
	];
	const kept = new Map<TracedRow, JsonRecord>();
	let spent = 0;
	for (const entry of spendOrder) {
		const fitted = fitTrace(entry, MAX_REPORT_TRACE_BYTES - spent, kept.size === 0);
		if (!fitted) break;
		kept.set(entry, fitted.trace);
		spent += fitted.bytes;
	}

	const omitted = spendOrder.length - kept.size;
	const untouched = [...kept].every(([entry, trace]) => trace === entry.row.trace);
	if (omitted === 0 && untouched) return report;

	const bounded = results.map((row, i) => {
		const entry = traced[i];
		if (!entry) return row;
		const trace = kept.get(entry);
		if (trace === entry.row.trace) return row;
		if (trace) return { ...entry.row, trace };
		const withoutTrace = { ...entry.row };
		delete withoutTrace.trace;
		return { ...withoutTrace, traceOmitted: true };
	});

	if (omitted === 0) return { ...report, results: bounded };
	return {
		...report,
		results: bounded,
		tracesOmitted: omitted,
		traceBudgetBytes: MAX_REPORT_TRACE_BYTES,
	};
}

/**
 * The report's `lifecycle` rows (`script.setup` / `script.teardown`) with their
 * `pm.sendRequest` records (#3633) bounded as a trace's are: every node per
 * node, then the rows' records together held to
 * {@link MAX_REPORT_TRACE_BYTES} in run order, setup before teardown, a row
 * past what is left giving them up as a trace does
 * ({@link SCRIPT_REQUEST_SHEDS}). A budget of its own rather than a share of
 * the traces': a setup script's token fetch is not a step, and should not cost
 * one its trace.
 */
function boundLifecycleRecords(report: JsonRecord): JsonRecord {
	const lifecycle = report.lifecycle;
	if (!isRecord(lifecycle)) return report;
	const recordBytes = (row: JsonRecord) => jsonBytes(row.scriptRequests ?? []);
	let spent = 0;
	const boundRow = (row: unknown): unknown => {
		if (!isRecord(row)) return row;
		const bounded = mapScriptRequests(row, boundRecordNodes);
		const fitted = shedToFit(
			bounded,
			recordBytes(bounded),
			MAX_REPORT_TRACE_BYTES - spent,
			(holder, shed) => shed(holder),
			recordBytes
		);
		spent += fitted.bytes;
		return fitted.value;
	};

	let next = lifecycle;
	for (const phase of ["setup", "teardown"] as const) {
		const rows = lifecycle[phase];
		if (!Array.isArray(rows)) continue;
		const bounded = rows.map(boundRow);
		if (bounded.some((row, i) => row !== rows[i])) next = { ...next, [phase]: bounded };
	}
	return next === lifecycle ? report : { ...report, lifecycle: next };
}

/**
 * Bound the stored traces in a run report - what `get_run_report` hands back.
 *
 * Two bounds, because one does not imply the other: every trace node is cut to
 * `MAX_INLINE_BODY_BYTES` (issue #767), and the traces together are cut to
 * `MAX_REPORT_TRACE_BYTES` (issue #769). Rows past the total budget keep every
 * scalar and lose only their trace, flagged `traceOmitted` on the row with
 * `tracesOmitted` and `traceBudgetBytes` on the report - the same disclose-in-
 * band shape `list_runs` uses for its 100-row page, so an agent that reads a
 * short report never mistakes it for the whole run. The first trace is always
 * embedded, whatever it costs: a design run's report is one row, and a report
 * that dropped it would answer nothing at all.
 *
 * A trace's `scripts.scriptRequests` (#3633), one record per `pm.sendRequest`,
 * has each record's nodes cut the same way, and a trace over the budget gives
 * up those records' bodies, then their detail, then the records, before
 * anything of its own. The engine bounds only their bodies, to
 * `maxTraceBodyBytes` together, so left alone they would cost a row its main
 * exchange. A `lifecycle` row's records are bounded the same way.
 *
 * Design and scenario rows only: a load run's results never go through
 * `build_result_trace` (it is called from `record_design_result` and the
 * scenario runner, never the load hot path), so they carry no `trace` node and
 * the walk leaves them untouched. Rebuilt rather than mutated so a report with
 * nothing over either bound comes back as the object the engine returned.
 */
export function boundRunReport(value: unknown): unknown {
	if (!isRecord(value)) return value;
	return boundLifecycleRecords(boundResultTraces(value));
}
