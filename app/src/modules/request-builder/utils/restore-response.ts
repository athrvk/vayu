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
 * `trace.response?.httpVersion` is only present when a response was actually
 * received (`build_result_trace` omits the whole `response` node on an error
 * path, see execution.cpp) - so a run that never reached a server has nothing
 * here, and `buildRawRequest` falls back to its own HTTP/1.1 default, the same
 * as a pre-migration stored row.
 */
function sentSide(trace: NonNullable<RunResultSample["trace"]>) {
	const request = trace.request;
	return {
		requestHeaders: request?.headers || {},
		rawRequest: request
			? buildRawRequest(
					request.method || "GET",
					request.url || "",
					request.headers || {},
					request.body,
					trace.response?.httpVersion
				)
			: undefined,
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
	};
}
