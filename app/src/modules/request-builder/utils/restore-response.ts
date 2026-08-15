/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Restore a design-mode response from a stored run result.
 *
 * A single `POST /request` creates a `type: "design"` run whose one result row
 * carries the whole exchange in `trace_data` - the outgoing request, the
 * response headers/body, and the per-phase timing breakdown. Nothing about the
 * response lives in the renderer beyond the in-memory response store, so on a
 * cold start this is the only way a restored tab gets its response pane back.
 *
 * Everything mapped here comes from `store_result` in
 * `engine/src/http/routes/execution.cpp`; keep the two in step.
 */

import type { RunReport } from "@/types";
import type { ResponseState, ResponseTiming } from "../types";
import { buildRawRequest } from "@/components/shared/response-viewer";

/** One element of `RunReport.results` - the shape `GET /runs/:id/report` returns. */
export type RunResultSample = NonNullable<RunReport["results"]>[number];

/**
 * Rebuild the timing breakdown from a stored trace. The stored trace and the
 * live `/execute` response share one key convention (`dnsMs`…`downloadMs`), so
 * no renaming happens here - only defaulting for rows written by older
 * engines, which omitted zero-valued phases (a reused connection stored no
 * `connectMs`/`tlsMs`) and never stored `wireMs`/`queueWaitMs`. The current
 * writer stores all eight keys, so on fresh rows the restored Timing tab shows
 * exactly what the live one did, Wire and Queue included; on old rows a
 * missing phase means zero and Wire/Queue stay absent.
 *
 * Returns `undefined` when the trace carries no phase at all, so the caller
 * does not surface a Timing tab that would render an all-zero timeline.
 */
export function timingFromTrace(
	trace: NonNullable<RunResultSample["trace"]>,
	latencyMs: number | undefined
): ResponseTiming | undefined {
	const phases = [trace.dnsMs, trace.connectMs, trace.tlsMs, trace.firstByteMs, trace.downloadMs];
	if (!phases.some((v) => typeof v === "number")) return undefined;

	return {
		totalMs: latencyMs ?? trace.totalMs ?? 0,
		...(typeof trace.wireMs === "number" && { wireMs: trace.wireMs }),
		...(typeof trace.queueWaitMs === "number" && { queueWaitMs: trace.queueWaitMs }),
		dnsMs: trace.dnsMs ?? 0,
		connectMs: trace.connectMs ?? 0,
		tlsMs: trace.tlsMs ?? 0,
		firstByteMs: trace.firstByteMs ?? 0,
		downloadMs: trace.downloadMs ?? 0,
	};
}

/**
 * The stored `events` node, as the response pane's four fields (issue #574).
 *
 * Only a **streaming** design run's trace carries this node
 * (`stream_trace_node`, engine/src/http/sse_stream.cpp), so an absent one is
 * what tells the Events tab "this was not a stream" from "this stream produced
 * nothing" - hence `undefined` rather than an empty list.
 *
 * `totalEvents` and `eventsTruncated` are carried across rather than recomputed
 * from `items.length`: the engine compared the true total against what it
 * stored, and a reader here does not know what the cap was when the run
 * happened. Recomputing would quietly turn a truncated list into a complete
 * one.
 *
 * Rows written before the node existed simply have no key, so every field
 * defaults - the same discipline the `rawRequest` and `httpVersion` fallbacks
 * above follow.
 */
export function eventsFromTrace(
	trace: NonNullable<RunResultSample["trace"]>
): Pick<ResponseState, "events" | "totalEvents" | "eventsTruncated" | "streamEndReason"> {
	const node = trace.events;
	if (!node) return {};

	const items = Array.isArray(node.items) ? node.items : [];
	return {
		events: items,
		totalEvents: typeof node.totalEvents === "number" ? node.totalEvents : items.length,
		eventsTruncated: node.eventsTruncated === true,
		// Absent rather than guessed: a stream whose stored node names no reason
		// gets no termination banner, which is honest. Every node the current
		// engine writes carries one.
		...(node.endReason && { streamEndReason: node.endReason }),
	};
}

/**
 * The stored `scripts` node, as the response pane's four script fields
 * (issue #575).
 *
 * Only a **streaming** design run's trace carries it, and for a reason worth
 * knowing here: that send was answered `202` before its post-request script had
 * run, so the trace is the only route its test results ever take. A buffered
 * send's results arrive in the `/execute` body and are not stored, which is why
 * an ordinary restored run still shows no Tests pane.
 *
 * The keys are the engine's own (`build_script_result_node`), identical to the
 * live body's, so nothing is renamed on the way through - a rename here would
 * be the one place the live pane and the restored pane could drift.
 */
export function scriptsFromTrace(
	trace: NonNullable<RunResultSample["trace"]>
): Pick<ResponseState, "testResults" | "consoleLogs" | "preScriptError" | "postScriptError"> {
	const node = trace.scripts;
	if (!node) return {};

	return {
		...(Array.isArray(node.testResults) && { testResults: node.testResults }),
		...(Array.isArray(node.consoleLogs) && { consoleLogs: node.consoleLogs }),
		...(node.preScriptError && { preScriptError: node.preScriptError }),
		...(node.postScriptError && { postScriptError: node.postScriptError }),
	};
}

/** Sniff a body's render mode the same way the live execute path does. */
function detectBodyType(body: string): ResponseState["bodyType"] {
	try {
		JSON.parse(body);
		return "json";
	} catch {
		if (body.includes("<html") || body.includes("<!DOCTYPE")) return "html";
		if (body.includes("<?xml") || body.includes("<xml")) return "xml";
		return "text";
	}
}

/**
 * The parts of a restored response that are the same whether the run succeeded
 * or failed: what was sent.
 *
 * `trace.request.rawRequest` is the engine's own wire message, stored since
 * issue #348. Preferred whenever it is there, because it is the only version
 * that carries what libcurl added on our behalf - the `Cookie` line the jar
 * matched above all, which the composed `headers` map has never held. Without
 * it the same exchange showed a `Cookie` header right after a send and none
 * after a reload.
 *
 * `buildRawRequest` stays as the fallback rather than being replaced: every row
 * written before that change has no such field, and a restored run from last
 * week must still render. Same shape as the `trace.response?.httpVersion`
 * fallback below it.
 *
 * `trace.response?.httpVersion` is only present when a response was actually
 * received (`build_result_trace` omits the whole `response` node on an error
 * path, see execution.cpp) - so a run that never reached a server has nothing
 * here, and `buildRawRequest` falls back to its own HTTP/1.1 default, the same
 * as a pre-migration stored row.
 *
 * `trace.request.sentHeaders` is the same preference one field over, for the
 * structured map (issue #664). The panel this fills is labelled as what was
 * sent, and `headers` is the *composed* request: it names a value-less header
 * libcurl dropped and a `form-data` `Content-Type` it wrote itself, and it is
 * missing the body-implied `Content-Type` and default `User-Agent` the engine
 * derives - so the live and restored panels disagreed about one exchange. The
 * composed map stays as the fallback for the rows written before the field, and
 * stays in the trace because `design-run-seed.ts` reseeds a request tab from
 * it, which is a different question with a different right answer.
 *
 * `buildRawRequest` below is still handed `headers`, not the sent record: it
 * synthesizes a wire message for a row that stored none, and every such row
 * predates both fields.
 */
function sentSide(trace: NonNullable<RunResultSample["trace"]>) {
	const request = trace.request;
	if (!request) return { requestHeaders: {}, rawRequest: undefined };

	return {
		requestHeaders: request.sentHeaders || request.headers || {},
		rawRequest:
			request.rawRequest ||
			buildRawRequest(
				request.method || "GET",
				request.url || "",
				request.headers || {},
				request.body,
				trace.response?.httpVersion
			),
	};
}

/**
 * Reconstruct a `ResponseState` from the last stored design-run result.
 *
 * Returns `null` when the result carries neither a response trace nor an error
 * (a run recorded before the exchange was captured) - the caller then leaves
 * the response pane empty rather than showing a hollow 0-byte response.
 */
export function responseFromRunResult(
	result: RunResultSample | undefined,
	runId?: string
): ResponseState | null {
	const trace = result?.trace;
	if (!result || !trace) return null;

	const restoredFrom = { runId, at: new Date(result.timestamp).toISOString() };

	/*
	 * A request that never reached a server stores no `response` node -
	 * `store_result` writes `error_type`/`error_message` instead. Mapping it to
	 * the same status-0 shape a live failure produces is what lets the builder's
	 * `ClientErrorView` render it, icon, hint and code included. `error_type`
	 * uses the same words as the live `errorCode` (`to_string(ErrorCode)` in
	 * engine/include/vayu/types.hpp).
	 */
	if (!trace.response) {
		const errorMessage = trace.error_message || result.error;
		if (!trace.error_type && !errorMessage) return null;

		return {
			status: 0,
			statusText: result.statusText || "Error",
			headers: {},
			...sentSide(trace),
			body: errorMessage || "",
			bodyType: "text",
			size: 0,
			time: result.latencyMs || 0,
			timing: timingFromTrace(trace, result.latencyMs),
			restoredFrom,
			errorCode: trace.error_type,
			errorMessage,
			// A stream that failed still received whatever it received before it
			// did, and the node is written on the failure path too.
			...eventsFromTrace(trace),
			...scriptsFromTrace(trace),
		};
	}

	/*
	 * The stored trace keeps the body as an opaque string - the engine caps it
	 * on a raw byte boundary, so what comes back is what the server sent. That
	 * string is the raw body, and it is carried through as `bodyRaw` rather than
	 * left undefined.
	 *
	 * It used to be omitted, and the Raw view was correct only by accident:
	 * `ResponseBody` falls back to `body`, which happened to be the same string.
	 * The moment a trace arrives holding a parsed object instead - the branch
	 * below exists because that can happen - `body` becomes pretty-printed and
	 * Raw would have silently shown formatting the server never sent.
	 */
	const raw = trace.response.body;
	const body =
		typeof raw === "string" ? raw : raw === undefined ? "" : JSON.stringify(raw, null, 2);
	const bodyRaw = typeof raw === "string" ? raw : raw === undefined ? "" : JSON.stringify(raw);

	return {
		status: result.statusCode || 0,
		statusText: result.statusText || "",
		headers: trace.response.headers || {},
		...sentSide(trace),
		httpVersion: trace.response.httpVersion,
		httpVersionDowngraded: trace.response.httpVersionDowngraded,
		body,
		bodyRaw,
		bodyType: detectBodyType(body),
		// `size` is what the pane's byte count shows. When the body was truncated
		// for storage the stored slice is not the real size, so prefer the
		// original `bodyBytes` the engine recorded and fall back to the slice.
		size: trace.response.bodyBytes ?? body.length,
		bodyTruncated: trace.response.bodyTruncated,
		bodyBytes: trace.response.bodyBytes,
		time: result.latencyMs || 0,
		timing: timingFromTrace(trace, result.latencyMs),
		restoredFrom,
		...eventsFromTrace(trace),
		...scriptsFromTrace(trace),
	};
}
