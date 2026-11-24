/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Restore a design-mode response from a stored run result. A `POST /execute` with a `runId` records
 * one result row whose `trace_data` holds the whole exchange: the outgoing request, the response
 * headers and body, and the per-phase timing. The renderer keeps the response only in memory, so on
 * a cold start this is how a restored tab gets its response pane back. Everything mapped here comes
 * from `record_design_result` (`engine/src/http/routes/execution.cpp`) and its `build_result_trace`
 * (`engine/src/http/request_exchange.cpp`); keep them in step.
 */

import type { RunReport } from "@/types";
import type { ResponseState, ResponseTiming } from "../types";
import { buildRawRequest } from "@/components/shared/response-viewer";
import { receivedWarnings } from "@/lib/exchange-warnings";
import { receivedHeaderLines, receivedRedirects, sentHeaderLines } from "@/lib/header-lines";
import { wireRequestHeadersField } from "@/components/shared/response-viewer/wire-headers";
import { authProvenance, paneBody } from "./execute-mapping";
import { decodeResponseBody, heldBodySize } from "./response-bytes";

/** One element of `RunReport.results` - the shape `GET /runs/:id/report` returns. */
export type RunResultSample = NonNullable<RunReport["results"]>[number];

/**
 * The timing breakdown from a stored trace. Trace and live `/execute` body share one key convention
 * (`dnsMs`...`downloadMs`), so nothing is renamed, only defaulted for rows from older engines,
 * which omitted zero phases (a reused connection stored no `connectMs`/`tlsMs`) and never stored
 * `wireMs`/`queueWaitMs`. The current writer stores all eight, so a fresh row's Timing tab shows
 * what the live one did; on an old row a missing phase is zero and Wire/Queue stay absent.
 * `engineMs` and `scriptMs` are stored only by a buffered send: absent on a stream, an auth failure
 * and old rows. `undefined` when the trace has no phase, so no all-zero Timing tab is shown.
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
		// Flat on the trace, nested under `timing` on the live body (#2132, #3676).
		...(typeof trace.engineMs === "number" && { engineMs: trace.engineMs }),
		...(typeof trace.scriptMs === "number" && { scriptMs: trace.scriptMs }),
		dnsMs: trace.dnsMs ?? 0,
		connectMs: trace.connectMs ?? 0,
		tlsMs: trace.tlsMs ?? 0,
		firstByteMs: trace.firstByteMs ?? 0,
		downloadMs: trace.downloadMs ?? 0,
	};
}

/**
 * The stored `events` node as the pane's four fields (#574). Only a **streaming** design run's
 * trace has it (`stream_trace_node`, `engine/src/http/sse_stream.cpp`), so an absent one says "not
 * a stream" rather than "a stream with nothing": hence `undefined`, not an empty list.
 * `totalEvents` and `eventsTruncated` are carried, not recomputed from `items.length`: the engine
 * compared the true total with what it stored, and the cap at run time is unknown here, so
 * recomputing would make a truncated list look complete. `startedAt` returns as `sentAt`, the
 * fallback for a stream the renderer holds no live start for (every one reopened from History); a
 * renderer that sent it stamps its own (`withSendSnapshot`). A row from before the node has no key,
 * so every field defaults.
 */
export function eventsFromTrace(
	trace: NonNullable<RunResultSample["trace"]>
): Pick<
	ResponseState,
	"events" | "totalEvents" | "eventsTruncated" | "streamEndReason" | "streamText" | "sentAt"
> {
	const node = trace.events;
	if (!node) return {};

	const items = Array.isArray(node.items) ? node.items : [];
	return {
		events: items,
		totalEvents: typeof node.totalEvents === "number" ? node.totalEvents : items.length,
		eventsTruncated: node.eventsTruncated === true,
		// Absent rather than guessed: a node naming no reason gets no termination banner. Every
		// node the current engine writes has one.
		...(node.endReason && { streamEndReason: node.endReason }),
		// The engine's start, not recomputed from the run's end (#3805): the zero of the Events
		// offsets and the Timing tab's first event. Absent on a node stored before the field.
		...(typeof node.startedAt === "number" && { sentAt: node.startedAt }),
		// The engine joins it over every stored event, past the item cap, so it beats joining
		// `items`, which stops at the cap.
		...(typeof node.streamText === "string" && { streamText: node.streamText }),
	};
}

/**
 * The stored `scripts` node as the pane's script fields (#575; on every design send, #725;
 * `scriptRequests`, #3633). Both transports write it: a stream was answered `202` before its
 * post-request script ran, so the trace is its results' only route; a buffered send stores the
 * object its `/execute` body returns. A trace from before #725 has no node, so absent reads as "no
 * results", not a failure. The keys are the engine's (`build_script_result_node`), the live body's,
 * so nothing is renamed: a rename would be the one place the live and restored panes could drift.
 */
export function scriptsFromTrace(
	trace: NonNullable<RunResultSample["trace"]>
): Pick<
	ResponseState,
	"testResults" | "consoleLogs" | "preScriptError" | "postScriptError" | "scriptRequests"
> {
	const node = trace.scripts;
	if (!node) return {};

	return {
		...(Array.isArray(node.testResults) && { testResults: node.testResults }),
		...(Array.isArray(node.consoleLogs) && { consoleLogs: node.consoleLogs }),
		...(node.preScriptError && { preScriptError: node.preScriptError }),
		...(node.postScriptError && { postScriptError: node.postScriptError }),
		...(Array.isArray(node.scriptRequests) && { scriptRequests: node.scriptRequests }),
	};
}

/**
 * The stored `elements` node (#1512), verbatim; script kinds keep their own node
 * (`scriptsFromTrace`). Absent on a trace with no non-script elements and on older rows.
 */
export function elementsFromTrace(
	trace: NonNullable<RunResultSample["trace"]>
): Pick<ResponseState, "elements"> {
	return Array.isArray(trace.elements) ? { elements: trace.elements } : {};
}

/**
 * The stored `validation` node (#628), verbatim. The engine stores the object the live `/execute`
 * body carried, so nothing is derived: `responseFromRunResult` and `responseFromExecuteResult` are
 * the pair most often found drifted, and they cannot drift if neither computes.
 */
export function validationFromTrace(
	trace: NonNullable<RunResultSample["trace"]>
): Pick<ResponseState, "validation"> {
	const node = trace.validation;
	return node && typeof node === "object" ? { validation: node } : {};
}

/**
 * The parts of a restored response that are the same whether the run succeeded or failed: what was
 * sent.
 *
 * `trace.request.rawRequest` is the engine's wire message (#348), preferred because only it holds
 * what libcurl added, above all the jar's `Cookie` line, which the composed `headers` never held
 * (without it a send showed `Cookie` and the reload none). `buildRawRequest` stays as the fallback
 * for rows written before it. `trace.response?.httpVersion` is there whenever a header block
 * arrived (`build_result_trace`, #3423): a failure after one keeps the node beside its error, and a
 * run that reached no server has none, so `buildRawRequest` uses its HTTP/1.1 default, as for an
 * old row.
 *
 * `trace.request.sentHeaders` is the same preference for the structured map (#664). The panel is
 * labelled as what was sent, and `headers` is the *composed* request: it names a blank `Cookie` row
 * that joined nothing and a `form-data` `Content-Type` libcurl wrote itself, and lacks the
 * body-implied `Content-Type` and default `User-Agent` the engine derives, so the live and restored
 * panels disagreed. The composed map is the fallback for older rows, and stays in the trace because
 * `history/main/design-run-seed.ts` reseeds a tab from it, a different question. `buildRawRequest`
 * is still handed `headers`: it synthesizes a message for a row that stored none, and every such
 * row predates both fields.
 */
function sentSide(trace: NonNullable<RunResultSample["trace"]>, answered: boolean) {
	const request = trace.request;
	if (!request) return { requestHeaders: {}, rawRequest: undefined };

	const requestHeaders = request.sentHeaders || request.headers || {};

	return {
		requestHeaders,
		// The live funnel's rule; a row stored before the key has none, and the tab lists the
		// folded record above.
		requestHeaderLines: sentHeaderLines(request.sentHeaderLines),
		// About what was sent, so it lives here and reaches a failed exchange too (#2474).
		authNotice: request.authNotice || undefined,
		...authProvenance(request),
		// Only the engine's frame, and only for an answered exchange: the fallback below is
		// fabricated, and a failed send's frame may be too, server headers included. The live
		// funnel judges it by the same status (`wireRequestHeadersField`).
		...wireRequestHeadersField(answered, request.rawRequest),
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
 * The client-certificate entry this exchange presented (#707), or nothing. A spread so an absent
 * key stays absent: the live funnel maps `""` to `undefined` for the same reason, and both must
 * produce the same `ResponseState` (`response-funnels.test.ts` compares them).
 */
function clientCertificateFromTrace(trace: NonNullable<RunResultSample["trace"]>) {
	return trace.clientCertificate ? { clientCertificate: trace.clientCertificate } : {};
}

/**
 * The warnings the engine recorded (#3307), or nothing; read from the trace's top level, so a
 * failure that received no headers (no `response` node) gets them too.
 */
function warningsFromTrace(trace: NonNullable<RunResultSample["trace"]>) {
	const warnings = receivedWarnings(trace.warnings);
	return warnings ? { warnings } : {};
}

type StoredTrace = NonNullable<RunResultSample["trace"]>;

/**
 * The recorded failure as the two fields the live funnel maps off the `/execute` body, or nothing.
 * `error_type` uses the live `errorCode`'s words (`to_string (ErrorCode)`,
 * `engine/include/vayu/types.hpp`). @p fallbackMessage is the row's `error` column, which older
 * rows and the load-test writer fill instead of `error_message`. A caller with a response node
 * leaves it out: a scenario step whose post-request script threw fills that column for an exchange
 * that succeeded (`classify_step`), and its pane is the response, not the error view.
 */
function failureFromTrace(
	trace: StoredTrace,
	fallbackMessage?: string
): Pick<ResponseState, "errorCode" | "errorMessage"> | undefined {
	const errorMessage = trace.error_message || fallbackMessage;
	if (!trace.error_type && !errorMessage) return undefined;
	return { errorCode: trace.error_type, errorMessage };
}

/**
 * What the stored `response` node says about the reply: headers, redirects, protocol and body, with
 * the pane's byte count. The same whether the exchange then succeeded or failed (#3423): a failure
 * after the header block stores the node beside its error, so both read it here. The stored body is
 * an opaque string, capped by the engine on a character boundary, so it is what the server sent
 * less what storage cut. It is carried as `bodyRaw`; `body` is that text formatted for Pretty by
 * the live funnel's `paneBody`, so a send reads the same live or from History. A base64 one (#2458)
 * goes through the live decoder, so both hold the same text and bytes. The stringify is for an
 * older row holding a parsed object: its text is gone, so compact is the closest honest
 * reconstruction, which `paneBody` indents.
 */
export function responseHeadFromTrace(node: NonNullable<StoredTrace["response"]>) {
	const raw = node.body;
	const headers = node.headers || {};
	const decoded =
		typeof raw === "string"
			? decodeResponseBody({ bodyRaw: raw, bodyEncoding: node.bodyEncoding, headers })
			: undefined;
	const bodyRaw = decoded ? decoded.text : raw === undefined ? "" : JSON.stringify(raw);
	const body = paneBody(bodyRaw);
	const rawBytes = decoded?.bytes;

	return {
		headers,
		// Same rule as the live funnel: an empty list is an absent one.
		headerLines: receivedHeaderLines(node.headerLines),
		redirects: receivedRedirects(node.redirects),
		httpVersion: node.httpVersion,
		httpVersionDowngraded: node.httpVersionDowngraded,
		body,
		bodyRaw,
		...(rawBytes && { rawBytes }),
		// The pane's byte count. The engine records the body's UTF-8 bytes as `bodyBytes` on every
		// response (#3423), the original length when storage cut the body, so it wins; an older row
		// has it only when cut, and falls back to the stored slice's bytes.
		size: node.bodyBytes ?? heldBodySize({ body, bodyRaw, rawBytes }),
		bodyTruncated: node.bodyTruncated,
		bodyBytes: node.bodyBytes,
		// A separate fact (#1157): the live send stopped *reading* at `maxDesignResponseBodyBytes`.
		// Both can hold (the engine read a prefix, then storage cut even that) and they are
		// different notices, so neither is derived from the other.
		bodyCapped: node.bodyCapped,
	};
}

/**
 * A `ResponseState` from the last stored design-run result; `null` when it has neither a response
 * trace nor an error (a run recorded before the exchange was captured, or a skipped scenario step),
 * so the pane stays empty rather than showing a hollow 0-byte response.
 */
export function responseFromRunResult(
	result: RunResultSample | undefined,
	runId?: string
): ResponseState | null {
	const trace = result?.trace;
	if (!result || !trace) return null;

	const failure = failureFromTrace(trace, trace.response ? undefined : result.error);
	if (!trace.response && !failure) return null;

	const common = {
		time: result.latencyMs || 0,
		timing: timingFromTrace(trace, result.latencyMs),
		restoredFrom: { runId, at: new Date(result.timestamp).toISOString() },
		// A failed stream still received what it did before failing, and the node is written on
		// that path too.
		...eventsFromTrace(trace),
		...scriptsFromTrace(trace),
		...elementsFromTrace(trace),
		...validationFromTrace(trace),
		...clientCertificateFromTrace(trace),
		...warningsFromTrace(trace),
	};

	/*
	 * A request that reached no server stores no `response` node, but `error_type` and
	 * `error_message` (`build_result_trace`). The status-0 shape a live failure has lets
	 * `ClientErrorView` render it, icon, hint and code included.
	 */
	if (!trace.response) {
		return {
			status: 0,
			statusText: result.statusText || "Error",
			headers: {},
			...sentSide(trace, false),
			body: failure?.errorMessage || "",
			size: 0,
			...failure,
			...common,
		};
	}

	/*
	 * A failure after the header block stores the node *and* the error (#3423), as the live answer
	 * holds both: a failed exchange (status 0, so `ClientErrorView` renders) keeping the server's
	 * headers and body for the Headers tab and the notices.
	 */
	return {
		status: failure ? 0 : result.statusCode || 0,
		statusText: failure ? result.statusText || "Error" : result.statusText || "",
		...responseHeadFromTrace(trace.response),
		...sentSide(trace, !failure),
		...failure,
		...common,
	};
}
