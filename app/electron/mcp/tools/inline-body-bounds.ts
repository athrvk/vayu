/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file inline-body-bounds.ts
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
 * Cut a string to at most `maxBytes` UTF-8 bytes, reporting its true size.
 *
 * The cut steps back off a continuation byte rather than landing mid-character:
 * a split code point comes back as a replacement glyph, which an agent reads as
 * content the response never carried.
 */
export function boundText(
	text: string,
	maxBytes = MAX_INLINE_BODY_BYTES
): { text: string; truncated: boolean; bytes: number } {
	const buf = Buffer.from(text, "utf8");
	if (buf.byteLength <= maxBytes) return { text, truncated: false, bytes: buf.byteLength };
	let end = maxBytes;
	while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
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
 * result is showing less than the engine returned, which the app's own history
 * still has in full, while `bodyCapped` means the engine never read more than
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

/** One report row, with its trace bounded per node and measured. */
interface MeasuredRow {
	row: unknown;
	/** Set only for a row that carries a trace; the per-node-bounded copy. */
	traced?: { record: Record<string, unknown>; trace: Record<string, unknown>; priority: boolean };
	/** True when bounding changed the trace, so the row must be rebuilt. */
	rebuilt: boolean;
	bytes: number;
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
 * short report never mistakes it for the whole run.
 *
 * Design and scenario rows only: a load run's results never go through
 * `build_result_trace` (it is called from `record_design_result` and the
 * scenario runner, never the load hot path), so they carry no `trace` node and
 * the walk leaves them untouched. Rebuilt rather than mutated so a report with
 * nothing over either bound comes back as the object the engine returned.
 */
export function boundRunReport(value: unknown): unknown {
	if (!isRecord(value) || !Array.isArray(value.results)) return value;

	let nodeBounded = false;
	const measured: MeasuredRow[] = value.results.map((row) => {
		if (!isRecord(row) || !isRecord(row.trace)) return { row, rebuilt: false, bytes: 0 };
		const trace = row.trace;
		const next: Record<string, unknown> = { ...trace };
		let rebuilt = false;
		for (const key of ["request", "response"] as const) {
			if (!(key in trace)) continue;
			next[key] = boundTraceNode(trace[key]);
			if (next[key] !== trace[key]) rebuilt = true;
		}
		if (rebuilt) nodeBounded = true;
		const bounded = rebuilt ? next : trace;
		// The compact size of what this row would embed. Measured after the
		// per-node cut, since that is what the result would actually carry.
		return {
			row,
			traced: { record: row, trace: bounded, priority: isPriorityTraceRow(row) },
			rebuilt,
			bytes: Buffer.byteLength(JSON.stringify(bounded), "utf8"),
		};
	});

	// Spend the budget on the rows that matter first, then in run order. The
	// first trace is always embedded, whatever it costs: a design run's report
	// is one row, and a report that dropped it would answer nothing at all.
	const spendOrder = [
		...measured.filter((m) => m.traced?.priority),
		...measured.filter((m) => m.traced && !m.traced.priority),
	];
	const keep = new Set<MeasuredRow>();
	let spent = 0;
	for (const entry of spendOrder) {
		if (keep.size > 0 && spent + entry.bytes > MAX_REPORT_TRACE_BYTES) break;
		keep.add(entry);
		spent += entry.bytes;
	}

	const omitted = spendOrder.length - keep.size;
	if (!nodeBounded && omitted === 0) return value;

	const results = measured.map((entry) => {
		if (!entry.traced) return entry.row;
		if (keep.has(entry)) {
			return entry.rebuilt
				? { ...entry.traced.record, trace: entry.traced.trace }
				: entry.row;
		}
		const withoutTrace = { ...entry.traced.record };
		delete withoutTrace.trace;
		return { ...withoutTrace, traceOmitted: true };
	});

	if (omitted === 0) return { ...value, results };
	return {
		...value,
		results,
		tracesOmitted: omitted,
		traceBudgetBytes: MAX_REPORT_TRACE_BYTES,
	};
}
