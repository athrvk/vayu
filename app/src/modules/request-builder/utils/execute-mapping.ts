/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The two pure ends of the execute pipeline: editor state to the body the
 * engine takes, and the engine's result back to the response pane's state.
 *
 * Both were inline in `request-builder/index.tsx` and then copied wholesale
 * into the History run view when it grew its own send path. That is the
 * "hand-rolled copy does not receive the primitive's fixes" trap - the copies
 * had already drifted cosmetically before anyone read them side by side. The
 * body branches and the ~20-field response mapping are pure functions of their
 * inputs, so they live here and both callers use them.
 *
 * Deliberately *not* moved: auth resolution (already shared via
 * `auth-resolution.ts`), the script-part list (each caller builds a different one -
 * the builder walks the live collection chain, the run view replays what was
 * recorded), and the header/URL resolution, which differs in which variables
 * are in scope.
 */

import type {
	ExampleSentRequest,
	FileRef,
	RequestBody,
	ResolvedElement,
	SanityResult,
} from "@/types";
import type { RequestState, ResponseState } from "../types";
import { toKeyValueEntries } from "@/components/shared/KeyValueEditor/key-value";
import { LARGE_BODY_BYTES } from "@/components/shared/response-viewer/utils";
import { wireRequestHeadersField } from "@/components/shared/response-viewer/wire-headers";
import { noFile, withoutFileTrust } from "@/lib/file-trust";
import { formatJson } from "@/lib/json-format";
import { receivedHeaderLines, receivedRedirects, sentHeaderLines } from "@/lib/header-lines";
import { decodeResponseBody, responseBodyType } from "./response-bytes";

/** The body shape `POST /request` and `POST /run` accept. */
export interface ExecBody {
	mode: string;
	content?: string;
	fields?: ExecField[];
	/** A `binary` body's file - a path, never bytes. */
	file?: WireFileRef;
}

/** A file reference as a payload carries it: no trust flag. */
export type WireFileRef = Omit<FileRef, "unresolved">;

/**
 * One form field on the wire payload. A file part sends its path and what the
 * part should declare about itself - never bytes: the engine opens the file, so
 * a renderer that read it would be copying the upload through two processes.
 * No trust flag: the engine decides from its allowed folders and grants
 * (`lib/file-trust.ts`).
 */
export interface ExecField {
	key: string;
	value: string;
	enabled: boolean;
	type?: "text" | "file";
	src?: string;
	fileName?: string;
	contentType?: string;
}

/**
 * A binary body's file as the stored and the wire shape both take it: empty
 * optional members and the engine's `unresolved` answer left out
 * (`lib/file-trust.ts`).
 */
export function toFileRef(
	file: FileRef | undefined,
	resolveString: (input: string) => string = (s) => s
): WireFileRef {
	if (!file) return noFile();
	const ref: WireFileRef = { src: resolveString(file.src ?? "") };
	if (file.fileName) ref.fileName = resolveString(file.fileName);
	if (file.contentType) ref.contentType = resolveString(file.contentType);
	return ref;
}

/**
 * The flattened editor body as the wire's discriminated `RequestBody`, with
 * `{{vars}}` left as written - the stored shape, not the sent one (that is
 * `buildExecBody` below). Shared by the builder's save, the "gone" pane's cURL
 * snippet (issue #1436) and the Send snapshot `sentRequestOf` takes.
 */
export function toBodyPayload(
	request: Pick<RequestState, "bodyMode" | "body" | "formData" | "urlEncoded" | "binaryFile">
): RequestBody {
	if (request.bodyMode === "form-data") {
		return { mode: "form-data", fields: withoutFileTrust(toKeyValueEntries(request.formData)) };
	}
	if (request.bodyMode === "x-www-form-urlencoded") {
		return { mode: "x-www-form-urlencoded", fields: toKeyValueEntries(request.urlEncoded) };
	}
	if (request.bodyMode === "binary") {
		return { mode: "binary", file: toFileRef(request.binaryFile) };
	}
	if (request.bodyMode !== "none") {
		return {
			mode: request.bodyMode as "json" | "text" | "graphql" | "jsonrpc" | "xml",
			content: request.body ?? "",
		};
	}
	return { mode: "none" };
}

/**
 * The request as the user wrote it, in the stored request-column shapes
 * (issue #1763) - the same row mapping the builder's save sends, path rows
 * included. The engine reads it with its own `savedFrom` reader, which checks
 * only the outer shapes (an HTTP method, a string url, arrays of rows, an
 * object body), not with a request save's appliers. Taken at Send and
 * carried on the response as `sentRequest`.
 */
export function sentRequestOf(request: RequestState): ExampleSentRequest {
	return {
		method: request.method,
		url: request.url,
		params: toKeyValueEntries(request.params),
		headers: toKeyValueEntries(request.headers),
		body: toBodyPayload(request),
	};
}

/**
 * Build the outgoing body from the flat editor fields, resolving `{{vars}}` on
 * the way. Returns `undefined` for a request that carries no body, so the field
 * is omitted rather than sent as an empty object.
 *
 * The two field-based modes resolve each key and value individually; the
 * content-based modes resolve the whole string, and `binary` resolves its
 * file's three strings. `mode: "none"` and an empty body both mean "no body".
 */
export function buildExecBody(
	request: RequestState,
	resolveString: (input: string) => string
): ExecBody | undefined {
	if (request.bodyMode === "form-data") {
		return {
			mode: "form-data",
			fields: toKeyValueEntries(request.formData).map((e): ExecField => {
				const field: ExecField = {
					key: resolveString(e.key),
					value: resolveString(e.value),
					enabled: e.enabled,
				};
				if (e.type !== "file") return field;
				// A file part's path, declared name and type are as templatable
				// as its key - a fixture directory is what an environment
				// variable holds - and the engine resolves the same three.
				field.type = "file";
				field.value = "";
				field.src = resolveString(e.src ?? "");
				if (e.fileName) field.fileName = resolveString(e.fileName);
				if (e.contentType) field.contentType = resolveString(e.contentType);
				return field;
			}),
		};
	}

	if (request.bodyMode === "x-www-form-urlencoded") {
		return {
			mode: "x-www-form-urlencoded",
			fields: toKeyValueEntries(request.urlEncoded).map((e) => ({
				key: resolveString(e.key),
				value: resolveString(e.value),
				enabled: e.enabled,
			})),
		};
	}

	// Sent even with an empty path: the engine refuses it as "no file
	// selected", which says more than a request that went out bodiless.
	if (request.bodyMode === "binary") {
		return { mode: "binary", file: toFileRef(request.binaryFile, resolveString) };
	}

	const resolvedBody = request.body ? resolveString(request.body) : request.body;
	if (request.bodyMode !== "none" && resolvedBody) {
		return { mode: request.bodyMode || "text", content: resolvedBody };
	}

	return undefined;
}

/**
 * The identity fields the engine hands the script sandbox as `pm.info`, for
 * the inline half of the compose payload (issue #300).
 *
 * Only the name lives here: `requestId` is attached at execute time by each
 * caller, because the two disagree about where it comes from - the builder
 * sends the saved row's id, the run view sends the id the run was filed under -
 * while both mean the same thing by "the name in the editor right now".
 *
 * It has to come from the client at all because Send executes editor state: an
 * unsaved request has a name and no row to look it up in, and a detached
 * replay copy has a name that is not the stored one. An empty name is omitted
 * rather than sent as `""`, so a script reads `undefined` and its `typeof`
 * check answers truthfully.
 */
export function execIdentity(request: RequestState): { requestName?: string } {
	return request.name ? { requestName: request.name } : {};
}

/**
 * The request's **stored** protocol settings (issue #1765), for the inline half
 * of a compose payload.
 *
 * Always all three, never elided at the default - the `verifySSL` rule: the
 * editor may be ahead of the saved row, so an omitted `false` would let the
 * stored value win, and composition carries them through to `/execute` and
 * `/runs`. `disabledSystemHeaders` is the stored per-request list; the per-send
 * {@link disabledDefaults} beside it is a different field, and the engine
 * unions the two.
 *
 * Shared by the builder's Send (buffered and streaming, one compose), its load
 * run and the History run view's replay.
 */
export function protocolSettings(
	request: Pick<RequestState, "disableCookies" | "disabledSystemHeaders" | "disableUrlEncoding">
): { disableCookies: boolean; disabledSystemHeaders: string[]; disableUrlEncoding: boolean } {
	return {
		disableCookies: request.disableCookies,
		disabledSystemHeaders: request.disabledSystemHeaders,
		disableUrlEncoding: request.disableUrlEncoding,
	};
}

/**
 * The engine defaults this send refuses (issue #1229), as the wire field - or
 * nothing at all.
 *
 * Absent rather than `[]` when the user switched none off, so a payload that
 * refuses nothing is byte-for-byte the payload sent before the field existed.
 * The engine refuses a malformed list with a 400 and ignores a name it adds
 * nothing under, so there is nothing to filter here.
 *
 * Shared by the builder's Send, its stream, its load run and the History run
 * view's replay - the four places a request leaves this app.
 */
export function disabledDefaults(request: Pick<RequestState, "disabledDefaultHeaders">): {
	disabledDefaultHeaders?: string[];
} {
	const names = request.disabledDefaultHeaders;
	return names.length > 0 ? { disabledDefaultHeaders: names } : {};
}

/**
 * The string the pane's `body` holds, given the text the server sent: that text
 * indented when it is JSON (`lib/json-format.ts`), else as received.
 *
 * It is built from @p bodyRaw and never from the engine's parsed `body`, which
 * is key-sorted, collapses a repeated key to its last value and rounds any
 * integer past 2^53 (issue #2459). A JSON `null` or scalar needs no case of its
 * own: its text is its own formatting.
 *
 * Above `LARGE_BODY_BYTES` the pane never calls `formatBody` (`ResponseBody`
 * shows a raw prefix instead), so there the raw text is handed back unindented
 * and a multi-megabyte response costs no pass at all on the send path.
 *
 * Shared with `responseFromRunResult`, which must build the same pane for the
 * same send.
 */
export function paneBody(bodyRaw: string): string {
	if (bodyRaw.length > LARGE_BODY_BYTES) return bodyRaw;
	return formatJson(bodyRaw);
}

/**
 * Map an engine execute result onto the response pane's state.
 *
 * Two subtleties worth keeping:
 *
 * - **status 0 is meaningful**, so it must not be defaulted to 200. It is what
 *   a client-side failure (no server response) reports, and it is what makes
 *   the pane render `ClientErrorView` instead of an empty 200.
 * - **`bodyRaw` is the received text**, carried through unchanged for the Raw
 *   view, Copy, Download and Save as example; `body` is that text formatted for
 *   the Pretty view (`paneBody`).
 */
export function responseFromExecuteResult(result: SanityResult): ResponseState {
	/*
	 * The engine always sends `bodyRaw` (`json["bodyRaw"] = response.body` in
	 * `utils/json.cpp`), and it is the field whose entire job is to be what the
	 * server actually sent, so it is never rebuilt from the parsed `body` while
	 * it is there. The stringify below is only a guard against a producer that
	 * sends no `bodyRaw`: the original bytes are already gone by then, and compact
	 * is the closest honest reconstruction - indenting would invent formatting
	 * the server never sent.
	 *
	 * A base64 `bodyRaw` (issue #2458) is decoded first, so from here on
	 * `bodyRaw` is text or nothing: the bytes ride `rawBytes`.
	 */
	const decoded = decodeResponseBody({
		bodyRaw: result.bodyRaw ?? "",
		bodyEncoding: result.bodyEncoding,
		headers: result.headers,
	});
	const bodyRaw =
		decoded.text ||
		(typeof result.body === "object" && result.body !== null
			? JSON.stringify(result.body)
			: String(result.body || ""));

	const body = paneBody(bodyRaw);

	const status = result.status !== undefined && result.status !== null ? result.status : 200;

	return {
		status,
		statusText: result.statusText || "",
		headers: result.headers || {},
		// The engine sends `[]` for a response with no headers, the stored trace
		// omits the key: `receivedHeaderLines` makes both absent, so the funnels
		// agree and the Cookies tab can tell a legacy answer from a received
		// one (issue #2460).
		headerLines: receivedHeaderLines(result.headerLines),
		// Same normalisation, for the hops before this response (issue #2461).
		redirects: receivedRedirects(result.redirects),
		requestHeaders: result.requestHeaders,
		// `[]` when nothing was recorded, absent from an engine before the key and
		// from a stored trace: `sentHeaderLines` makes all of them absent.
		requestHeaderLines: sentHeaderLines(result.requestHeaderLines),
		rawRequest: result.rawRequest,
		...wireRequestHeadersField(status !== 0, result.rawRequest),
		httpVersion: result.httpVersion,
		httpVersionDowngraded: result.httpVersionDowngraded,
		// The engine omits the key when it has nothing to say; `|| undefined` also
		// keeps a producer's `""` from drawing an empty banner, so this funnel and
		// the restored one agree whatever they are handed (issue #2474).
		authNotice: result.authNotice || undefined,
		// `""` means no certificate matched, and the pane has nothing to show
		// for that - mapped to `undefined` so this funnel and the restored one
		// build the same state (see `clientCertificateFromTrace`).
		clientCertificate: result.clientCertificate || undefined,
		body,
		bodyRaw,
		// The engine read only this much of it (issue #1157). Carried on both
		// funnels - `responseFromRunResult` reads the same fact off the stored
		// trace - because a restored response must say what the live one said.
		//
		// `false` becomes `undefined` for the same reason `clientCertificate`'s
		// `""` does: the live body always carries the key while the stored trace
		// writes it only when it happened, so without this the two funnels would
		// disagree in type on every uncapped response.
		bodyCapped: result.bodyCapped || undefined,
		// Absent for a `"utf8"` body, the same normalisation as `bodyCapped`: the
		// stored trace marks only a base64 one.
		...(decoded.bytes && { rawBytes: decoded.bytes }),
		bodyType: responseBodyType(result.headers, decoded.bytes),
		// When it arrived, as opposed to how long it took. The status bar shows
		// it as an age, which is the only thing distinguishing a fresh response
		// from one sent before the request beside it was edited.
		receivedAt: new Date().toISOString(),
		time: result.timing?.totalMs || 0,
		timing: result.timing,
		size: result.bodySize || 0,
		errorCode: result.errorCode,
		errorMessage: result.errorMessage,
		consoleLogs: result.consoleLogs,
		testResults: result.testResults,
		elements: result.elements,
		preScriptError: result.preScriptError,
		postScriptError: result.postScriptError,
		// Absent stays absent: the engine writes no `validation` at all for a
		// request whose collection binds no document, and spreading a key with
		// `undefined` would make the pane render an "unchecked" state for a
		// response nothing was ever going to check.
		...(result.validation ? { validation: result.validation } : {}),
	};
}

/**
 * Whether an execute that ran these elements could have written a variable
 * the UI is showing, and so needs the environment/globals/collection caches
 * invalidated.
 *
 * Every kind counts, not just scripts (issue #1512): `extract.json` /
 * `extract.regex` / `extract.header` write to `env` / `collection` / `globals`
 * scope exactly as `pm.environment.set` does, so treating only `script.*` as
 * write-capable would leave a stale variables editor after a plain extractor
 * ran. `pm.environment.set` / `pm.globals.set` / `pm.collectionVariables.set`
 * persist engine-side from a post-request script exactly as from a
 * pre-request one, so a request whose only script was in the Tests tab stored
 * the value while the variables editor and the resolver kept showing the old
 * one - `refetchOnWindowFocus` is off, so nothing else was coming to correct
 * it. A non-empty resolved list is treated as write-capable; an empty one, as
 * no element at all.
 */
export function elementsMayWriteVariables(elements?: ResolvedElement[]): boolean {
	return Boolean(elements?.length);
}
