/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the session Console's ring (`stores/console-store.ts`) is handed (#3634).
 *
 * {@link sendConsoleRows} is the one builder both Send completions call, the
 * buffered one in `request-builder/index.tsx` and the streamed one in
 * `stream-finalization.ts`: two builders would be a field one path writes and
 * the other does not. A Send contributes its rows in execution order, the
 * pre-request script's lines and requests, the Send itself, then the
 * post-response script's, placed by the response pane's own `consoleRows`.
 *
 * The Send row is built from the live response, so it is masked here before
 * it enters the ring: header values by name plus the `authHeaders` the
 * response carries, the URL by `maskUrlCredentials` plus `authQueryParam`.
 * Script requests arrive masked by the engine (#3633) and are kept as written.
 * Bodies are not judged, as in an export.
 */

import type { ScriptRequestRecord } from "@/types";
import {
	useConsoleStore,
	type ConsoleBody,
	type ConsoleRowInput,
	type ConsoleScriptRequestRow,
	type ConsoleSendRow,
} from "@/stores/console-store";
import { maskSensitiveHeaders } from "@/lib/sensitive-headers";
import { maskUrlCredentials } from "@/lib/url-credentials";
import type { ResponseState } from "@/modules/request-builder/types";
import { timingFromTrace } from "@/modules/request-builder/utils/restore-response";
import {
	consoleRows,
	isScriptRequestRow,
	type ConsoleRow as ResponseConsoleRow,
} from "@/modules/request-builder/components/ResponseViewer/console/console-rows";
import { parseConsoleLogs } from "@/modules/request-builder/components/ResponseViewer/console/parse-logs";

/** A Send that finished, with what each completion knows about what it sent. */
export interface CompletedSend {
	/** As sent: the composed request's on the buffered path, the stored trace's on a stream. */
	method: string;
	url: string;
	response: ResponseState;
	requestId?: string;
	runId?: string;
}

/** A body as a row keeps it, or nothing for an absent or empty one. */
function bodyOf(body: unknown, encoding?: string): ConsoleBody | undefined {
	if (body === undefined || body === null || body === "") return undefined;
	const text = typeof body === "string" ? body : JSON.stringify(body);
	return encoding === "base64" ? { text, base64: true } : { text };
}

/** The body half of a recorded request frame: what follows the blank line that ends its headers. */
function rawRequestBody(rawRequest: string | undefined): ConsoleBody | undefined {
	if (!rawRequest) return undefined;
	const match = /\r?\n\r?\n/.exec(rawRequest);
	return match ? bodyOf(rawRequest.slice(match.index + match[0].length)) : undefined;
}

/**
 * The response body a Send row keeps: the received text. A binary body keeps
 * none (its size is on the row), and a failure that received no header block
 * keeps none either, since the pane's body is then the error message.
 */
function sendResponseBody(response: ResponseState): ConsoleBody | undefined {
	const answered = !response.errorCode || Object.keys(response.headers).length > 0;
	if (!answered || response.rawBytes) return undefined;
	return bodyOf(response.bodyRaw ?? response.body);
}

function sendRow(send: CompletedSend): ConsoleSendRow {
	const { response } = send;
	const authHeaders = response.authHeaders ?? [];
	return {
		kind: "send",
		method: send.method,
		url: maskUrlCredentials(send.url, response.authQueryParam ? [response.authQueryParam] : []),
		status: response.status,
		statusText: response.statusText,
		timeMs: response.time,
		sizeBytes: response.size,
		...(response.errorCode && { errorCode: response.errorCode }),
		...(response.errorMessage && { errorMessage: response.errorMessage }),
		...(send.requestId && { requestId: send.requestId }),
		...(send.runId && { runId: send.runId }),
		exchange: {
			requestHeaders: maskSensitiveHeaders(response.requestHeaders ?? {}, authHeaders),
			requestBody: rawRequestBody(response.rawRequest),
			responseHeaders: maskSensitiveHeaders(response.headers, authHeaders),
			responseBody: sendResponseBody(response),
			timing: response.timing,
		},
	};
}

/** The size of a script request's response, by the engine's count when it kept one. */
function recordSize(record: ScriptRequestRecord): number {
	const response = record.response;
	if (!response) return 0;
	if (typeof response.bodyBytes === "number") return response.bodyBytes;
	return typeof response.body === "string" ? response.body.length : 0;
}

function scriptRequestRow(
	row: Extract<ResponseConsoleRow, { record: ScriptRequestRecord }>,
	requestId: string | undefined
): ConsoleScriptRequestRow {
	const { record } = row;
	return {
		kind: "scriptRequest",
		source: row.source,
		...(row.scope && { scope: row.scope }),
		...(requestId && { requestId }),
		...(row.line && { line: row.line.message }),
		method: record.request.method ?? "",
		url: record.request.url ?? "",
		status: record.status,
		...(record.statusText && { statusText: record.statusText }),
		timeMs: record.totalMs ?? 0,
		sizeBytes: recordSize(record),
		...(record.error_type && { errorCode: record.error_type }),
		...(record.error_message && { errorMessage: record.error_message }),
		exchange: {
			requestHeaders: record.request.sentHeaders ?? record.request.headers ?? {},
			requestBody: bodyOf(record.request.body),
			responseHeaders: record.response?.headers ?? {},
			responseBody: bodyOf(record.response?.body, record.response?.bodyEncoding),
			timing: timingFromTrace(record, record.totalMs),
		},
	};
}

function scriptRow(row: ResponseConsoleRow, requestId: string | undefined): ConsoleRowInput {
	if (isScriptRequestRow(row)) return scriptRequestRow(row, requestId);
	return {
		kind: "line",
		source: row.source,
		...(row.scope && { scope: row.scope }),
		level: row.level,
		message: row.message,
		...(requestId && { requestId }),
	};
}

/** A completed Send as Console rows, in the order it ran. */
export function sendConsoleRows(send: CompletedSend): ConsoleRowInput[] {
	const { response, requestId } = send;
	const scripted = consoleRows(
		parseConsoleLogs(response.consoleLogs ?? []),
		response.scriptRequests
	).map((row) => ({ source: row.source, row: scriptRow(row, requestId) }));
	return [
		...scripted.filter((entry) => entry.source === "pre").map((entry) => entry.row),
		sendRow(send),
		...scripted.filter((entry) => entry.source !== "pre").map((entry) => entry.row),
	];
}

/** Append a completed Send's rows to the session Console. */
export function appendSendToConsole(send: CompletedSend): void {
	useConsoleStore.getState().append(sendConsoleRows(send));
}
