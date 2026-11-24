/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The two pure ends of the execute pipeline: editor state to the body the engine takes, and the
 * engine's result back to the response pane's state, shared by the builder and the History run
 * view's send path so no hand-rolled copy misses a fix. Not here: auth resolution
 * (`auth-resolution.ts`), the script-part list (the builder walks the live chain, the run view
 * replays the recording), and header/URL resolution, whose variable scopes differ.
 */

import type {
	ExampleSentRequest,
	FileRef,
	McpTool,
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
import { receivedWarnings } from "@/lib/exchange-warnings";
import { ApiError } from "@/services/http-client";
import { receivedHeaderLines, receivedRedirects, sentHeaderLines } from "@/lib/header-lines";
import { decodeResponseBody } from "./response-bytes";

/** The body shape `POST /request` and `POST /run` accept. */
export interface ExecBody {
	mode: string;
	content?: string;
	fields?: ExecField[];
	/** A `binary` body's file: a path, never bytes. */
	file?: WireFileRef;
	/** An `mcp` body's tool, sent as stored: the engine reads it at send time. */
	mcpTool?: McpTool;
}

/** A file reference as a payload carries it: no trust flag. */
export type WireFileRef = Omit<FileRef, "unresolved">;

/**
 * One wire form field. A file part sends its path and what it declares about itself, never bytes:
 * the engine opens the file, and a renderer reading it would copy the upload through two processes.
 * A text part sends at most its own `contentType` (#2539). No trust flag: the engine decides from
 * its allowed folders and grants (`lib/file-trust.ts`).
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
 * A binary body's file in the stored and wire shape: empty optional members and the engine's
 * `unresolved` left out (`lib/file-trust.ts`).
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
 * The flattened editor body as the wire's discriminated `RequestBody`, `{{vars}}` as written: the
 * stored shape, not the sent one (`buildExecBody`). Shared by the save, the "gone" pane's cURL
 * snippet (#1436) and the Send snapshot `sentRequestOf` takes.
 */
export function toBodyPayload(
	request: Pick<
		RequestState,
		"bodyMode" | "body" | "formData" | "urlEncoded" | "binaryFile" | "mcpTool"
	>
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
	// An absent `mcpTool` stores none, clearing one a previous save wrote: the body is replaced
	// whole.
	if (request.bodyMode === "mcp") {
		return {
			mode: "mcp",
			content: request.body ?? "",
			...(request.mcpTool && { mcpTool: request.mcpTool }),
		};
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
 * The request as written, in stored request-column shapes (#1763), the save's row mapping, path
 * rows included. The engine reads it with its `savedFrom` reader, which checks only outer shapes
 * (an HTTP method, a string url, row arrays, an object body), not a save's appliers. Taken at Send
 * and carried on the response as `sentRequest`.
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
 * The outgoing body from the flat editor fields, resolving `{{vars}}` on the way; `undefined` for a
 * request with no body, so the field is omitted, not an empty object. Field modes resolve each key
 * and value; content modes the whole string; `binary` its file's three strings. `mode: "none"` and
 * an empty body both mean none.
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
				// A text part may declare its own type (a Postman import keeps one), so it is read
				// before the file branch.
				if (e.contentType) field.contentType = resolveString(e.contentType);
				if (e.type !== "file") return field;
				// A file part's path and name are as templatable as its key (a fixture directory is
				// an environment variable), and the engine resolves them with the type.
				field.type = "file";
				field.value = "";
				field.src = resolveString(e.src ?? "");
				if (e.fileName) field.fileName = resolveString(e.fileName);
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

	// Sent even with an empty path: the engine refuses it as "no file selected", clearer than a
	// bodiless request.
	if (request.bodyMode === "binary") {
		return { mode: "binary", file: toFileRef(request.binaryFile, resolveString) };
	}

	const resolvedBody = request.body ? resolveString(request.body) : request.body;
	if (request.bodyMode !== "none" && resolvedBody) {
		// The tool feeds the engine's derived headers, and its schema holds no variables, so it
		// goes unresolved.
		const mcpTool = request.bodyMode === "mcp" ? request.mcpTool : undefined;
		return {
			mode: request.bodyMode || "text",
			content: resolvedBody,
			...(mcpTool && { mcpTool }),
		};
	}

	return undefined;
}

/**
 * The identity the engine gives the sandbox as `pm.info`, for the compose payload's inline half
 * (#300). Only the name: `requestId` is attached by each caller, as they disagree on its source
 * (the saved row's id, or the run's filed id) while meaning the same by "the name in the editor
 * now". From the client because Send executes editor state: an unsaved request has a name but no
 * row, and a detached replay copy a non-stored name. An empty name is omitted, so a script's
 * `typeof` check reads `undefined` truthfully.
 */
export function execIdentity(request: RequestState): { requestName?: string } {
	return request.name ? { requestName: request.name } : {};
}

/**
 * The request's **stored** protocol settings (#1765) for the compose payload's inline half, always
 * all three, never elided (the `verifySSL` rule): the editor may be ahead of the saved row, and an
 * omitted `false` would let the stored value win through composition to `/execute` and `/runs`.
 * `disabledSystemHeaders` is the stored list; the per-send {@link disabledDefaults} is another
 * field, unioned engine-side. Shared by Send (buffered and streaming), its load run and the History
 * replay.
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
 * The engine defaults this send refuses (#1229), as the wire field or nothing: absent, not `[]`,
 * when none, so such a payload is byte-identical to before the field. The engine 400s a malformed
 * list and ignores a name it adds nothing under, so nothing is filtered here. Shared by Send, its
 * stream, its load run and the History replay, the four places a request leaves this app.
 */
export function disabledDefaults(request: Pick<RequestState, "disabledDefaultHeaders">): {
	disabledDefaultHeaders?: string[];
} {
	const names = request.disabledDefaultHeaders;
	return names.length > 0 ? { disabledDefaultHeaders: names } : {};
}

/**
 * The stream text path a streaming send or load run declares (#3773), as the wire field or nothing,
 * beside the composed payload: an inline compose carries no path, only a by-id one reads the stored
 * row's. Absent when not streaming (the engine refuses a path on a buffered send; the field is
 * hidden) and when blank, so a request declaring none sends what it always sent.
 */
export function streamTextPathOf(request: Pick<RequestState, "stream" | "streamTextPath">): {
	streamTextPath?: string;
} {
	const path = request.streamTextPath.trim();
	return request.stream && path ? { streamTextPath: path } : {};
}

/**
 * The first content marker a streaming load run declares (#3774), as the wire field or nothing.
 * Load runs only: a Send checks it and times nothing, so carrying it would be a write nothing
 * reads. Absent when not streaming (refused beside a buffered request) and when empty. Not trimmed:
 * matched as written.
 */
export function streamFirstContentMarkerOf(
	request: Pick<RequestState, "stream" | "streamFirstContentMarker">
): { streamFirstContentMarker?: string } {
	return request.stream && request.streamFirstContentMarker
		? { streamFirstContentMarker: request.streamFirstContentMarker }
		: {};
}

/**
 * The pane's `body` from the server's text: indented when JSON (`lib/json-format.ts`), else as
 * received. Built from @p bodyRaw, never the engine's parsed `body`, which key-sorts, collapses a
 * repeated key to its last value and rounds integers past 2^53 (#2459); a JSON `null` or scalar is
 * its own formatting. Above `LARGE_BODY_BYTES` the pane never calls `formatBody` (`ResponseBody`
 * shows a raw prefix), so the text returns unindented and a huge response costs no pass. Shared
 * with `responseFromRunResult`, which must build the same pane.
 */
export function paneBody(bodyRaw: string): string {
	if (bodyRaw.length > LARGE_BODY_BYTES) return bodyRaw;
	return formatJson(bodyRaw);
}

/**
 * What a send's auth wrote, as `ResponseState` carries it: the live body's top-level keys or the
 * trace's `request` node, written by one engine function. A key stays absent without a name (an
 * empty list or string is none), so both funnels agree.
 */
export function authProvenance(
	source: Pick<SanityResult, "authHeaders" | "authQueryParam">
): Pick<ResponseState, "authHeaders" | "authQueryParam"> {
	return {
		...(Array.isArray(source.authHeaders) &&
			source.authHeaders.length > 0 && { authHeaders: source.authHeaders }),
		...(source.authQueryParam && { authQueryParam: source.authQueryParam }),
	};
}

/**
 * Response codes a refusal's rule code stands for. A buffered send answers a refused file as a
 * response with `UNSENDABLE_FILE`; a streaming one has no response yet, so the engine 400s it under
 * the rule's code (`unsendable_file`, `docs/engine/api-reference/request-body.md`), and
 * `ClientErrorView` knows only the response spelling (#3693).
 */
const RESPONSE_CODE_OF_RULE: Readonly<Record<string, string>> = {
	unsendable_file: "UNSENDABLE_FILE",
};

/**
 * The pane's `errorCode` for a Send that failed without a response: `ENGINE_ERROR` when the engine
 * never answered, else the engine's code spelled as a response carries it; the one place a
 * refusal's code becomes a response's, for buffered and streaming alike.
 */
export function responseCodeOfFailure(error: unknown): string {
	if (!(error instanceof ApiError)) return "ENGINE_ERROR";
	return RESPONSE_CODE_OF_RULE[error.errorCode] ?? error.errorCode;
}

/**
 * An engine execute result as the response pane's state.
 *
 * - **status 0 is meaningful**, never defaulted to 200: it is a client-side failure (no server
 *   response), and it makes the pane render `ClientErrorView`, not an empty 200.
 * - **`bodyRaw` is the received text**, kept unchanged for Raw, Copy, Download and Save as example;
 *   `body` is it formatted for Pretty (`paneBody`).
 */
export function responseFromExecuteResult(result: SanityResult): ResponseState {
	/*
	 * The engine always sends `bodyRaw` (`serialize (Response)`, `utils/json.cpp`): the body's
	 * UTF-8 text, or base64 with `bodyEncoding: "base64"` for non-text bytes, so it is never
	 * rebuilt from `body` while present. `body` is the engine's JSON parse and may be `null`: this
	 * renderer asks `includeParsedBody: false` (`apiService.executeRequest`), so it always is, and
	 * the engine also nulls it for non-JSON, base64 or past 4 MiB. The stringify is a guard for a
	 * producer sending no `bodyRaw`: the bytes are gone, compact is the closest honest
	 * reconstruction, and indenting would invent formatting. A base64 `bodyRaw` (#2458) is decoded
	 * first, so from here `bodyRaw` is text or nothing; the bytes ride `rawBytes`.
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
		// The engine sends `[]` for no headers, the trace omits the key; `receivedHeaderLines`
		// makes both absent, so the funnels agree and Cookies can tell a legacy answer from a
		// received one (#2460).
		headerLines: receivedHeaderLines(result.headerLines),
		// Same normalisation, for the hops before this response (issue #2461).
		redirects: receivedRedirects(result.redirects),
		requestHeaders: result.requestHeaders,
		// `[]` when nothing was recorded, absent from older engines and from a trace:
		// `sentHeaderLines` makes all of them absent.
		requestHeaderLines: sentHeaderLines(result.requestHeaderLines),
		rawRequest: result.rawRequest,
		...wireRequestHeadersField(status !== 0, result.rawRequest),
		httpVersion: result.httpVersion,
		httpVersionDowngraded: result.httpVersionDowngraded,
		// Omitted by the engine when silent; `|| undefined` also keeps a `""` from drawing an empty
		// banner, so both funnels agree (#2474).
		authNotice: result.authNotice || undefined,
		// Absent when auth wrote none, on both funnels (`sentSide` reads the trace's).
		...authProvenance(result),
		// Always present live, `[]` when empty (#3307); the trace writes the key only when
		// non-empty, so both funnels read it through `receivedWarnings`.
		warnings: receivedWarnings(result.warnings),
		// `""` means no certificate matched, nothing to show: `undefined`, so both funnels agree
		// (`clientCertificateFromTrace`).
		clientCertificate: result.clientCertificate || undefined,
		body,
		bodyRaw,
		// The engine read only this much (#1157), carried on both funnels so a restored response
		// says what the live one did. `false` becomes `undefined` as `clientCertificate`'s `""`
		// does: live always has the key, the trace only when it happened, so the funnels would
		// otherwise differ in type on every uncapped one.
		bodyCapped: result.bodyCapped || undefined,
		// Absent for a `"utf8"` body, normalised as `bodyCapped`: the trace marks only base64.
		...(decoded.bytes && { rawBytes: decoded.bytes }),
		// When it arrived, not how long it took: the status bar's age is what tells a fresh
		// response from one sent before the request was edited.
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
		// Spread, not assigned: the stored node writes the key only when a script sent something,
		// and both funnels must agree.
		...(Array.isArray(result.scriptRequests) && { scriptRequests: result.scriptRequests }),
		// Absent stays absent: the engine writes no `validation` for a collection with no document,
		// and a key set to `undefined` would render "unchecked" for a response never going to be
		// checked.
		...(result.validation ? { validation: result.validation } : {}),
	};
}

/**
 * Whether elements that ran could have written a variable the UI shows, so the environment, globals
 * and collection caches need invalidating. Every kind counts (#1512): `extract.json` / `.regex` /
 * `.header` write `env` / `collection` / `globals` like `pm.environment.set`, and post-request
 * scripts persist engine-side like pre-request ones; with `refetchOnWindowFocus` off nothing else
 * would correct a stale editor. A non-empty list is write-capable; an empty one, no element.
 */
export function elementsMayWriteVariables(elements?: ResolvedElement[]): boolean {
	return Boolean(elements?.length);
}
