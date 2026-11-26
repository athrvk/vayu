/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @brief `run_request`: one HTTP request sent through the engine in design mode.
 */

import { z } from "zod";
import { checkComposedTarget, targetPolicyRefusal } from "../safety.js";
import { VARIABLE_PRECEDENCE_SENTENCE, VARIABLE_RESOLUTION_URI } from "../variable-origins.js";
import { HTTP_VERSIONS } from "../http-versions.js";
import { withheldPointer } from "../withhold.js";
import type { McpTool, ToolContext } from "./contract.js";
import {
	callEngineForRunOutput,
	elementsArg,
	engineErrorResult,
	errorResult,
	guardErrorResult,
	isRecord,
	str,
	ToolArgError,
	withCaveat,
} from "./kit.js";
import { boundExecuteResponse, MAX_INLINE_BODY_BYTES } from "./inline-body-bounds.js";
import { inlineFileInput } from "./request-body.js";
import { runRequestResultSchema } from "./output-schemas.js";
import {
	agentScriptGateSentence,
	applyDefaultHeaderOptOuts,
	composeViaEngine,
	readAuthArg,
	readRequestOverrides,
	readValidationScript,
	refuseAgentScripts,
	resolveEnvironmentId,
	asMcpSend,
	runStreamingRequest,
	scriptElement,
	setStreamFlag,
} from "./compose.js";
import {
	authInput,
	collectionIdInput,
	dataRowInput,
	defaultHeaderOptOutsInput,
	elementSchema,
	ENGINE_DEFAULT_HEADERS_SENTENCE,
	environmentIdInput,
	eventsInput,
	INSECURE_TLS_REFUSAL,
	maxStreamEventsInput,
	requestHeadersInput,
	streamBudgetMsInput,
	streamInput,
	streamTextPathSendInput,
	validationScriptAliasInput,
	validationScriptInput,
	verifySSLSendInput,
} from "./input-schemas.js";

const NO_TARGET_ERROR = 'Pass "url" for an ad-hoc send, or "requestId" to send a saved request.';

const LINK_ONLY_CAVEAT =
	'Both "url" and "requestId" were given, so this was sent ad hoc: the saved request\'s stored auth, scripts, elements and settings were NOT applied, and "requestId" only linked the run in History and named the collection its scripts read. Omit "url" to send the saved request as stored.';

/**
 * The ad-hoc scripts as the `elements` entries `/execute` takes: it refuses
 * `preRequestScript` / `postRequestScript` / `tests` outright (issue #1514),
 * and `/compose` copies an inline request's keys onto the payload verbatim, so
 * the old names would surface as a 400 from the send rather than from
 * composition. Scripts ride through composition untouched - the engine never
 * interpolates them. An `elements` argument (issue #1517) joins the same list.
 */
function adHocElements(args: Record<string, unknown>): unknown[] {
	const elements: unknown[] = [];
	const preScript = str(args, "preRequestScript");
	if (preScript !== undefined) {
		elements.push(scriptElement("pre", preScript, "mcp-script-pre"));
	}
	const postScript = readValidationScript(args);
	if (postScript !== undefined) {
		elements.push(scriptElement("post", postScript, "mcp-script-post"));
	}
	elements.push(...(elementsArg(args) ?? []));
	return elements;
}

/** The inline fields the call gave, as `/compose` takes them over a stored request or alone. */
function requestFields(args: Record<string, unknown>, ctx: ToolContext): Record<string, unknown> {
	const fields = readRequestOverrides(args, ctx);
	const authArg = readAuthArg(args, ctx);
	if (authArg) fields.auth = authArg;
	return fields;
}

/**
 * What `/compose` is asked to compose, or undefined when the call names no target. A `url` is an
 * ad-hoc request: `requestId` does not reach `/compose`, which would compose the *stored* row
 * instead of the arguments the agent gave. Without one, `requestId` is the target and the call's
 * inline fields lay over the stored request. The ad-hoc `elements` stay out of that overlay because
 * the engine replaces the whole stored list with an inline one; they join the stored list in a
 * second composition ({@link composeWithAdHocElements}).
 */
function composeTarget(
	args: Record<string, unknown>,
	ctx: ToolContext,
	url: string | undefined,
	savedId: string | undefined
): Record<string, unknown> | undefined {
	const fields = requestFields(args, ctx);
	if (url !== undefined) {
		const elements = adHocElements(args);
		// Ad hoc only: a by-id compose carries the saved request's own path, and
		// `setStreamFlag` drops it again when this send does not stream.
		const streamTextPath = str(args, "streamTextPath");
		return {
			request: {
				...fields,
				url,
				method: fields.method ?? "GET",
				...(elements.length > 0 ? { elements } : {}),
				...(streamTextPath !== undefined ? { streamTextPath } : {}),
			},
		};
	}
	if (savedId === undefined) return undefined;
	// An empty `url` is "absent" for the branch choice, so it must not ride along.
	delete fields.url;
	return { requestId: savedId, ...(Object.keys(fields).length > 0 ? { request: fields } : {}) };
}

/**
 * The by-id branch's composition with its ad-hoc scripts and `elements` after
 * the stored and inherited ones rather than replacing them. The engine's
 * inline overlay replaces the whole list, so the chain's list is read off
 * @p composed and the whole list composed again: composition decides from the
 * elements it sees whether a pre-request script runs before the send (#2521),
 * and a name an ad-hoc `preRequestScript` sets must be left for it.
 */
async function composeWithAdHocElements(
	client: ToolContext["client"],
	composeBody: Record<string, unknown>,
	composed: Record<string, unknown>,
	args: Record<string, unknown>,
	signal?: AbortSignal
): Promise<Record<string, unknown>> {
	const extra = adHocElements(args);
	if (extra.length === 0) return composed;
	const stored = Array.isArray(composed.elements) ? composed.elements : [];
	const fields = isRecord(composeBody.request) ? composeBody.request : {};
	return composeViaEngine(
		client,
		{ ...composeBody, request: { ...fields, elements: [...stored, ...extra] } },
		signal
	);
}

/**
 * Whether this send streams. A `stream` argument wins either way; without one,
 * a send by `requestId` follows the saved request's Event stream setting, which
 * a by-id compose always carries (#3561), and an ad-hoc send buffers.
 */
function streamsThisSend(
	args: Record<string, unknown>,
	composed: Record<string, unknown>,
	sendsSaved: boolean
): boolean {
	if (typeof args.stream === "boolean") return args.stream;
	return sendsSaved && composed.stream === true;
}

export const RUN_REQUEST_TOOLS: McpTool[] = [
	{
		name: "run_request",
		category: "execute",
		retry: "never-blind",
		invalidates: ["run", "cookie", "variables"],
		description: (config) =>
			"Send a single HTTP request through Vayu (Design mode) and return the response, timing, and any test results. Omit `url` and pass `requestId` to send the saved request as the app's Send does (stored auth, inherited auth, the chain's and the request's scripts and elements, settings); `headers`, `body`, `method`, `auth` and the other fields you add then replace the stored ones for this send, and a `preRequestScript`, `postRequestScript` or `elements` you add run after the stored ones. Pass `url` to send ad hoc; `requestId` then links the run in History and scopes its scripts' collection, and nothing else stored is applied. The target host must be on Vayu's MCP allowlist, checked on the resolved URL. {{variables}} in the URL, headers, and body are resolved against the environment and, with a collectionId, its chain, using the same precedence as the app; the environment's cookie jar is the one the send uses, and its History row names it. " +
			VARIABLE_PRECEDENCE_SENTENCE +
			` See ${VARIABLE_RESOLUTION_URI}.` +
			" Pass an `auth` block to have the engine apply bearer/basic/apikey/oauth2 auth. " +
			agentScriptGateSentence(
				"`preRequestScript`, `postRequestScript`, `tests`, or an `elements` entry of a `script.*` kind"
			) +
			" Extractors, assertions and timers in `elements` are not scripts and pass. With write access off, nothing a script or extractor sets is stored: the value is visible for the rest of this send and is not written to the environment, collection or globals. Certificate verification is always on for an ad-hoc send: `verifySSL: false` is refused, and a send by `requestId` follows the setting stored there. " +
			ENGINE_DEFAULT_HEADERS_SENTENCE +
			" " +
			`The response body is capped at ${MAX_INLINE_BODY_BYTES} bytes in this result; read_body pages out the rest by \`runId\` and \`resultId\`. A \`bodyEncoding: "base64"\` body is not UTF-8 text: decode it, never read it as text. \`bodyCapped\` is not \`bodyTruncated\`: the engine itself stopped reading at \`maxDesignResponseBodyBytes\`, so a re-send returns the same; raise that entry to read more. What each field means is on the output schema.` +
			withheldPointer(config, "recorded"),
		annotations: {
			title: "Send a request",
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: true,
		},
		outputSchema: runRequestResultSchema,
		inputSchema: {
			method: z
				.string()
				.optional()
				.describe(
					"HTTP method (default GET; with `requestId` and no `url`, the stored method)."
				),
			url: z
				.string()
				.optional()
				.describe(
					"Request URL (may contain {{variables}}). Required unless `requestId` is given to send a saved request; with both, the call is ad hoc and nothing stored is applied."
				),
			headers: requestHeadersInput,
			body: z.string().optional().describe("Request body content."),
			file: inlineFileInput,
			bodyType: z
				.string()
				.optional()
				.describe(
					'Body type: json, text, graphql, jsonrpc, xml, form-data, x-www-form-urlencoded (default text). For the two form types, write `body` as `key=value&key=value`; it is split into form fields. A body that sends a file (`binary`, or a form-data file part) cannot be sent from here - save it with create_request and run the saved request by id (run_request with `requestId` and no `url`, start_load_run with `requestId`, or run_collection). For graphql, a bare query document is enveloped as `{"query": ...}` and sent as application/json; an envelope you write yourself is sent unchanged. That is the POST transport: with `method` GET the same document is sent as `query`/`operationName`/`variables` query parameters and no body, which is what GraphQL-over-HTTP defines GET to mean - so use POST for a mutation, and note that a GET is what a request gets by default. For jsonrpc, a bare call object gains `"jsonrpc":"2.0"` - plus `"id":1` when it names no id - and is sent as application/json; a frame already declaring a string `"jsonrpc"` is sent byte for byte, so write the frame yourself to choose your own id or to send a notification (no id). A top-level array is a batch call and is sent unchanged. An xml `body` is sent byte for byte as application/xml, and a text `body` as text/plain; a Content-Type you set yourself wins.'
				),
			auth: authInput,
			httpVersion: z
				.enum(HTTP_VERSIONS)
				.optional()
				.describe(
					'Protocol to negotiate: "auto" | "http1.1" | "http2" (default "auto"). Mirrors the request builder\'s protocol picker.'
				),
			verifySSL: verifySSLSendInput,
			requestId: z
				.string()
				.optional()
				.describe(
					"Saved request ID. Without `url`, the saved request is sent as the app's Send does (stored auth, inherited auth, the chain's and the request's scripts and elements, settings). With `url`, the send is ad hoc: `requestId` links the run in History and scopes its scripts' collection; nothing else stored is applied."
				),
			environmentId: environmentIdInput,
			collectionId: collectionIdInput,
			data: dataRowInput,
			disabledDefaultHeaders: defaultHeaderOptOutsInput,
			preRequestScript: z
				.string()
				.optional()
				.describe(
					"JavaScript run before the request is sent. It may edit pm.request.url / .method / .headers / .body, and those edits are what gets sent - a script-set header overrides the engine-applied auth. The sandbox is synchronous and has no network: to sign a request use pm.crypto.sha256 / pm.crypto.hmacSha256 and the btoa / atob globals. Sent to the engine as an ad-hoc `script.pre` element. Read get_script_api (or the `vayu://scripting/completions` resource) for the full surface. Refused while Reveal secrets to agents is off."
				),
			postRequestScript: validationScriptInput,
			tests: validationScriptAliasInput,
			elements: z
				.array(elementSchema)
				.optional()
				.describe(
					"Ad-hoc elements (extractors, assertions, timers…) for this send only - not stored anywhere, and alongside any preRequestScript/postRequestScript given on the same call rather than replacing them. A `script.*` entry is a script, and is refused while Reveal secrets to agents is off. List the kinds and each one's config with list_element_kinds (or the `vayu://elements/kinds` resource)."
				),
			stream: streamInput,
			streamTextPath: streamTextPathSendInput,
			maxStreamEvents: maxStreamEventsInput,
			streamBudgetMs: streamBudgetMsInput,
			events: eventsInput,
		},
		handler: async (args, ctx, signal) => {
			// Before anything is composed, let alone sent: a refusal that arrived
			// after the exchange would be a request already made insecurely. `true`
			// falls through - it restates the composed default (issue #795).
			if (args.verifySSL === false) return errorResult(INSECURE_TLS_REFUSAL, "policy");
			// The same posture for the same reason: a script is refused before the
			// compose that would carry it, not after an exchange that ran it (#1834).
			refuseAgentScripts(args, ctx, elementsArg(args));
			// An empty `url` names no target, the same as an absent one.
			const url = str(args, "url") || undefined;
			const linkId = str(args, "requestId");
			const target = composeTarget(args, ctx, url, linkId);
			if (target === undefined) return errorResult(NO_TARGET_ERROR, "input");
			const sendsSaved = url === undefined;

			// Compose engine-side (pure), gate on the composed URL, then execute
			// the composed payload. The gate here is the early refusal: a
			// pre-request script can still edit `pm.request` or set the variable
			// a deferred `{{host}}` resolves from, so the engine holds the URL it
			// is about to send to the same allowlist (`targetPolicy`, #2521) and
			// its refusal is answered below with this gate's remedy.
			let payload: Record<string, unknown>;
			try {
				const composeBody = {
					...target,
					collectionId: str(args, "collectionId"),
					environmentId: await resolveEnvironmentId(args, ctx, signal),
				};
				payload = await composeViaEngine(ctx.client, composeBody, signal);
				if (sendsSaved) {
					payload = await composeWithAdHocElements(
						ctx.client,
						composeBody,
						payload,
						args,
						signal
					);
				}
			} catch (err) {
				if (err instanceof ToolArgError) return errorResult(err.message, err.failureClass);
				return engineErrorResult(err, ctx);
			}
			const gate = checkComposedTarget(payload, ctx.config, ctx.host);
			if (!gate.ok) return guardErrorResult(gate);
			// By id the engine stamped it already; ad hoc it is only the History link.
			if (linkId !== undefined) payload.requestId = linkId;

			// Beside the composed payload, not through composition: `{{data.*}}`
			// survives `/compose` by design (`request_composer.hpp`), so the
			// tokens are still written when `/execute` binds them against this
			// row (issue #601). Absent means today's send, unchanged.
			const dataRow = args.data;
			if (dataRow !== undefined && dataRow !== null) payload.data = dataRow;

			// The same posture, and the same reason it is not composed: the names
			// say which of the engine's own defaults this send declines, which
			// composition neither reads nor rewrites (issue #1337).
			applyDefaultHeaderOptOuts(args, payload);

			// Stated on every call, never elided: the two answers have different
			// *shapes* - `202 {runId, eventsUrl}` against the exchange - so the
			// handler decides which one it is about to parse rather than an
			// engine default. The same rule both app clients follow for
			// `followRedirects`.
			const streaming = streamsThisSend(args, payload, sendsSaved);
			setStreamFlag(payload, streaming);
			// Beside `stream` so both transports carry it: with write access off,
			// what a script or extractor sets stays within this send (#1904).
			if (!ctx.config.allowWrites) payload.persistVariables = false;
			const result = streaming
				? await runStreamingRequest(args, payload, ctx, signal)
				: await callEngineForRunOutput(
						ctx,
						() => ctx.client.executeRequest(asMcpSend(payload, ctx), signal),
						{
							bound: boundExecuteResponse,
							structured: true,
							signal,
							auth: payload.auth,
							refusal: (answer) => targetPolicyRefusal(answer, ctx.host),
						}
					);
			return url !== undefined && linkId !== undefined
				? withCaveat(result, LINK_ONLY_CAVEAT)
				: result;
		},
	},
];
