/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file run-request.tools.ts
 * @brief `run_request`: one HTTP request sent through the engine in design mode.
 */

import { z } from "zod";
import { checkAllowlist } from "../safety.js";
import { VARIABLE_PRECEDENCE_SENTENCE, VARIABLE_RESOLUTION_URI } from "../variable-origins.js";
import { HTTP_VERSIONS } from "../http-versions.js";
import { WITHHELD_RUN_OUTPUT_SENTENCE } from "../withhold.js";
import type { McpTool } from "./contract.js";
import {
	callEngineForRunOutput,
	elementsArg,
	engineErrorResult,
	errorResult,
	str,
	ToolArgError,
	withCaveat,
} from "./kit.js";
import { boundExecuteResponse, MAX_INLINE_BODY_BYTES } from "./inline-body-bounds.js";
import { inlineFileInput } from "./request-body.js";
import {
	agentScriptGateSentence,
	applyDefaultHeaderOptOuts,
	composeViaEngine,
	readAuthArg,
	readRequestOverrides,
	readValidationScript,
	refuseAgentScripts,
	runStreamingRequest,
	scriptElement,
	withMcpOrigin,
} from "./compose.js";
import {
	authInput,
	collectionIdInput,
	dataRowInput,
	defaultHeaderOptOutsInput,
	elementSchema,
	ENGINE_DEFAULT_HEADERS_SENTENCE,
	environmentIdInput,
	INSECURE_TLS_REFUSAL,
	maxStreamEventsInput,
	streamBudgetMsInput,
	streamInput,
	validationScriptAliasInput,
	validationScriptInput,
	verifySSLSendInput,
} from "./input-schemas.js";

const NO_TARGET_ERROR = 'Pass "url" for an ad-hoc send, or "requestId" to send a saved request.';

const LINK_ONLY_CAVEAT =
	'Both "url" and "requestId" were given, so this was sent ad hoc: the saved request\'s stored auth, scripts, elements and settings were NOT applied, and "requestId" only linked the run in History. Omit "url" to send the saved request as stored.';

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
function requestFields(args: Record<string, unknown>): Record<string, unknown> {
	const fields = readRequestOverrides(args);
	const authArg = readAuthArg(args);
	if (authArg) fields.auth = authArg;
	return fields;
}

/**
 * What `/compose` is asked to compose, or undefined when the call names no
 * target. A `url` is an ad-hoc request: `requestId` does not reach `/compose`,
 * which would compose the *stored* row instead of the arguments the agent gave.
 * Without one, `requestId` is the target and the call's inline fields lay over
 * the stored request. The ad-hoc `elements` are kept out of that overlay
 * because the engine replaces the whole stored list with an inline one; they
 * are appended afterwards ({@link appendAdHocElements}).
 */
function composeTarget(
	args: Record<string, unknown>,
	url: string | undefined,
	savedId: string | undefined
): Record<string, unknown> | undefined {
	const fields = requestFields(args);
	if (url !== undefined) {
		const elements = adHocElements(args);
		return {
			request: {
				...fields,
				url,
				method: fields.method ?? "GET",
				...(elements.length > 0 ? { elements } : {}),
			},
		};
	}
	if (savedId === undefined) return undefined;
	// An empty `url` is "absent" for the branch choice, so it must not ride along.
	delete fields.url;
	return { requestId: savedId, ...(Object.keys(fields).length > 0 ? { request: fields } : {}) };
}

/**
 * The by-id branch's ad-hoc scripts and `elements`, added after the stored and
 * inherited ones rather than replacing them: the engine's inline overlay is
 * per key, so sending them in the compose request would drop the chain's own.
 */
function appendAdHocElements(payload: Record<string, unknown>, args: Record<string, unknown>) {
	const extra = adHocElements(args);
	if (extra.length === 0) return;
	const stored = Array.isArray(payload.elements) ? payload.elements : [];
	payload.elements = [...stored, ...extra];
}

export const RUN_REQUEST_TOOLS: McpTool[] = [
	{
		name: "run_request",
		category: "execute",
		invalidates: ["run", "cookie", "variables"],
		description:
			"Send a single HTTP request through Vayu (Design mode) and return the response, timing, and any test results. Omit `url` and pass `requestId` to send the saved request as the app's Send does (stored auth, inherited auth, the chain's and the request's scripts and elements, settings); `headers`, `body`, `method`, `auth` and the other fields you add then replace the stored ones for this send, and a `preRequestScript`, `postRequestScript` or `elements` you add run after the stored ones. Pass `url` to send ad hoc; `requestId` then only links the run in History and nothing stored is applied. The target host must be on Vayu's MCP allowlist, checked on the resolved URL. {{variables}} in the URL, headers, and body are resolved when an environmentId (and/or collectionId) is given, using the same precedence as the app. " +
			VARIABLE_PRECEDENCE_SENTENCE +
			` See ${VARIABLE_RESOLUTION_URI}.` +
			" Pass an `auth` block to have the engine apply bearer/basic/apikey/oauth2 auth. Pass a `preRequestScript` to sign or otherwise rewrite the request before it goes out - its pm.request edits are applied to what is actually sent. " +
			agentScriptGateSentence(
				"`preRequestScript`, `postRequestScript`, `tests`, or an `elements` entry of a `script.*` kind"
			) +
			" Extractors, assertions and timers in `elements` are not scripts and pass. With write access off, nothing a script or extractor sets is stored: the value is visible for the rest of this send and is not written to the environment, collection or globals. Certificate verification is always on for an ad-hoc send - `verifySSL: false` is refused here, because a skipped check on a one-off call is recorded nowhere; it belongs on the saved request, where the app shows it, and a send by `requestId` follows the setting stored there. " +
			ENGINE_DEFAULT_HEADERS_SENTENCE +
			" " +
			`The response body is capped at ${MAX_INLINE_BODY_BYTES} bytes in this result: over that, \`bodyRaw\` holds the first ${MAX_INLINE_BODY_BYTES} bytes, \`bodyTruncated\` is true, \`bodySize\` is the real size, and the parsed \`body\` is null rather than a full copy of what was cut. A large \`rawRequest\` is capped the same way (headers kept whole) and flagged with \`rawRequestTruncated\`. \`bodyCapped\` is a different fact and is always present: it says the engine itself stopped reading the response at \`maxDesignResponseBodyBytes\`, so \`bodySize\` is the prefix it read and re-sending returns the same amount - raise that config entry to read more, where \`bodyTruncated\` is only this result showing less than the engine returned. ` +
			WITHHELD_RUN_OUTPUT_SENTENCE,
		annotations: {
			title: "Send a request",
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: true,
		},
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
			headers: z
				.record(z.string(), z.string())
				.optional()
				.describe("Request headers as a string map."),
			body: z.string().optional().describe("Request body content."),
			file: inlineFileInput,
			bodyType: z
				.string()
				.optional()
				.describe(
					'Body type: json, text, graphql, jsonrpc, xml, form-data, x-www-form-urlencoded (default text). For the two form types, write `body` as `key=value&key=value`; it is split into form fields. A body that sends a file (`binary`, or a form-data file part) cannot be sent from here - save it with create_request and run the saved request by id (run_request with `requestId` and no `url`, start_load_run with `requestId`, or run_collection). For graphql, a bare query document is enveloped as `{"query": ...}` and sent as application/json; an envelope you write yourself is sent unchanged. That is the POST transport: with `method` GET the same document is sent as `query`/`operationName`/`variables` query parameters and no body, which is what GraphQL-over-HTTP defines GET to mean - so use POST for a mutation, and note that a GET is what a request gets by default. For jsonrpc, a bare call object gains `"jsonrpc":"2.0"` - plus `"id":1` when it names no id - and is sent as application/json; a frame already declaring a string `"jsonrpc"` is sent byte for byte, so write the frame yourself to choose your own id or to send a notification (no id). A top-level array is a batch call and is sent unchanged. An xml `body` is sent byte for byte as application/xml; a Content-Type you set yourself wins.'
				),
			auth: authInput,
			httpVersion: z
				.enum(HTTP_VERSIONS)
				.optional()
				.describe(
					'Protocol to negotiate: "auto" | "http1.1" | "http2" (default "auto"). Mirrors the request builder\'s Settings tab picker.'
				),
			verifySSL: verifySSLSendInput,
			requestId: z
				.string()
				.optional()
				.describe(
					"Saved request ID. Without `url`, the saved request is sent as the app's Send does (stored auth, inherited auth, the chain's and the request's scripts and elements, settings). With `url`, the send is ad hoc: `requestId` only links the run in History and nothing stored is applied."
				),
			environmentId: environmentIdInput,
			collectionId: collectionIdInput,
			data: dataRowInput,
			disabledDefaultHeaders: defaultHeaderOptOutsInput,
			preRequestScript: z
				.string()
				.optional()
				.describe(
					"JavaScript run before the request is sent. It may edit pm.request.url / .method / .headers / .body, and those edits are what gets sent - a script-set header overrides the engine-applied auth. The sandbox is synchronous and has no network: to sign a request use pm.crypto.sha256 / pm.crypto.hmacSha256 and the btoa / atob globals. Sent to the engine as an ad-hoc `script.pre` element (issue #1514 refuses the raw field). Read the `vayu://scripting/completions` resource for the full surface. Refused while Reveal secrets to agents is off."
				),
			postRequestScript: validationScriptInput,
			tests: validationScriptAliasInput,
			elements: z
				.array(elementSchema)
				.optional()
				.describe(
					"Ad-hoc elements (extractors, assertions, timers…) for this send only - not stored anywhere, and alongside any preRequestScript/postRequestScript given on the same call rather than replacing them. A `script.*` entry is a script, and is refused while Reveal secrets to agents is off. Read the `vayu://elements/kinds` resource for the catalogue."
				),
			stream: streamInput,
			maxStreamEvents: maxStreamEventsInput,
			streamBudgetMs: streamBudgetMsInput,
		},
		handler: async (args, ctx, signal) => {
			// Before anything is composed, let alone sent: a refusal that arrived
			// after the exchange would be a request already made insecurely. `true`
			// falls through - it restates the composed default (issue #795).
			if (args.verifySSL === false) return errorResult(INSECURE_TLS_REFUSAL);
			// The same posture for the same reason: a script is refused before the
			// compose that would carry it, not after an exchange that ran it (#1834).
			refuseAgentScripts(args, ctx, elementsArg(args));
			// An empty `url` names no target, the same as an absent one.
			const url = str(args, "url") || undefined;
			const linkId = str(args, "requestId");
			const target = composeTarget(args, url, linkId);
			if (target === undefined) return errorResult(NO_TARGET_ERROR);
			const sendsSaved = url === undefined;

			// Compose engine-side (pure), gate on the *resolved* URL, then execute
			// the composed payload. The gate is a host rule: a pre-request script
			// this call forwards can still edit `pm.request`, and since #1008 a
			// name compose could not answer is resolved before the send - neither
			// of which can reach a host the allowlist did not see, because an
			// unresolved authority is refused rather than checked (safety.ts).
			let payload: Record<string, unknown>;
			try {
				payload = await composeViaEngine(
					ctx.client,
					{
						...target,
						collectionId: str(args, "collectionId"),
						environmentId: str(args, "environmentId"),
					},
					signal
				);
			} catch (err) {
				if (err instanceof ToolArgError) return errorResult(err.message);
				return engineErrorResult(err, ctx);
			}
			if (sendsSaved) appendAdHocElements(payload, args);
			const gate = checkAllowlist(String(payload.url ?? ""), ctx.config, ctx.host);
			if (!gate.ok) return errorResult(gate.error!);
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
			// *shapes* - `202 {runId, eventsUrl}` against the exchange - so a
			// caller that let composition or an engine default decide would not
			// know which one it was about to parse. The same rule both app
			// clients follow for `followRedirects`.
			const streaming = args.stream === true;
			payload.stream = streaming;
			// Beside `stream` so both transports carry it: with write access off,
			// what a script or extractor sets stays within this send (#1904).
			if (!ctx.config.allowWrites) payload.persistVariables = false;
			const result = streaming
				? await runStreamingRequest(args, payload, ctx, signal)
				: await callEngineForRunOutput(
						ctx,
						() => ctx.client.executeRequest(withMcpOrigin(payload, ctx), signal),
						{ bound: boundExecuteResponse, signal, auth: payload.auth }
					);
			return url !== undefined && linkId !== undefined
				? withCaveat(result, LINK_ONLY_CAVEAT)
				: result;
		},
	},
];
