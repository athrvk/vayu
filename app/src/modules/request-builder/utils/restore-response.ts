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

/** One element of `RunReport.results` - the shape `GET /run/:id/report` returns. */
export type RunResultSample = NonNullable<RunReport["results"]>[number];

/**
 * Rebuild the timing breakdown from a stored trace.
 *
 * The engine writes each phase only when it is non-zero (a reused connection
 * has no `connectMs`/`tlsMs`), so a missing phase means zero, not unknown.
 * `wire`/`queueWait` are deliberately absent: the design-mode writer records
 * the five phases and `latency_ms` only, and the Timing tab already treats
 * both as optional.
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
		total: latencyMs ?? trace.totalMs ?? 0,
		dns: trace.dnsMs ?? 0,
		connect: trace.connectMs ?? 0,
		tls: trace.tlsMs ?? 0,
		firstByte: trace.firstByteMs ?? 0,
		download: trace.downloadMs ?? 0,
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
					request.body
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

	const raw = trace.response.body;
	const body =
		typeof raw === "string" ? raw : raw === undefined ? "" : JSON.stringify(raw, null, 2);

	return {
		status: result.statusCode || 0,
		statusText: result.statusText || "",
		headers: trace.response.headers || {},
		...sentSide(trace),
		body,
		bodyType: detectBodyType(body),
		size: body.length,
		time: result.latencyMs || 0,
		timing: timingFromTrace(trace, result.latencyMs),
		restoredFrom,
	};
}
