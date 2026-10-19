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
	requireStr,
	str,
	ToolArgError,
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

export const RUN_REQUEST_TOOLS: McpTool[] = [
	{
		name: "run_request",
		category: "execute",
		invalidates: ["run", "cookie", "variables"],
		description:
			"Send a single HTTP request through Vayu (Design mode) and return the response, timing, and any test results. The target host must be on Vayu's MCP allowlist. {{variables}} in the URL, headers, and body are resolved when an environmentId (and/or collectionId) is given, using the same precedence as the app. " +
			VARIABLE_PRECEDENCE_SENTENCE +
			` See ${VARIABLE_RESOLUTION_URI}.` +
			" Pass an `auth` block to have the engine apply bearer/basic/apikey/oauth2 auth. Pass a `preRequestScript` to sign or otherwise rewrite the request before it goes out - its pm.request edits are applied to what is actually sent. " +
			agentScriptGateSentence(
				"`preRequestScript`, `postRequestScript`, `tests`, or an `elements` entry of a `script.*` kind"
			) +
			" Extractors, assertions and timers in `elements` are not scripts and pass. With write access off, nothing a script or extractor sets is stored: the value is visible for the rest of this send and is not written to the environment, collection or globals. (To replay a saved request with its stored auth and scripts across a whole collection, use run_collection_smoke.) Certificate verification is always on for a send made this way - `verifySSL: false` is refused here, because a skipped check on a one-off call is recorded nowhere; it belongs on the saved request, where the app shows it. " +
			ENGINE_DEFAULT_HEADERS_SENTENCE +
			" " +
			`The response body is capped at ${MAX_INLINE_BODY_BYTES} bytes in this result: over that, \`bodyRaw\` holds the first ${MAX_INLINE_BODY_BYTES} bytes, \`bodyTruncated\` is true, \`bodySize\` is the real size, and the parsed \`body\` is null rather than a full copy of what was cut. A large \`rawRequest\` is capped the same way (headers kept whole) and flagged with \`rawRequestTruncated\`. \`bodyCapped\` is a different fact and is always present: it says the engine itself stopped reading the response at \`maxDesignResponseBodyBytes\`, so \`bodySize\` is the prefix it read and re-sending returns the same amount - raise that config entry to read more, where \`bodyTruncated\` is only this result showing less than the engine returned. \`bodyEncoding\` says how \`bodyRaw\` is spelled: "utf8" is the body as text; "base64" is a body that is not UTF-8 text (an image, a PDF, a Latin-1 page) as standard base64, which you must decode and never read as text, with \`body\` null - there the cap and \`bodySize\` count decoded bytes and a cut keeps whole 4-character groups, so the prefix still decodes. ` +
			WITHHELD_RUN_OUTPUT_SENTENCE,
		annotations: {
			title: "Send a request",
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: true,
		},
		inputSchema: {
			method: z.string().optional().describe("HTTP method (default GET)."),
			url: z.string().describe("Request URL (may contain {{variables}})."),
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
					'Body type: json, text, graphql, jsonrpc, xml, form-data, x-www-form-urlencoded (default text). For the two form types, write `body` as `key=value&key=value`; it is split into form fields. A body that sends a file (`binary`, or a form-data file part) cannot be sent from here - save it with create_request and run the saved request by id (start_load_run with `requestId`, or run_collection). For graphql, a bare query document is enveloped as `{"query": ...}` and sent as application/json; an envelope you write yourself is sent unchanged. That is the POST transport: with `method` GET the same document is sent as `query`/`operationName`/`variables` query parameters and no body, which is what GraphQL-over-HTTP defines GET to mean - so use POST for a mutation, and note that a GET is what a request gets by default. For jsonrpc, a bare call object gains `"jsonrpc":"2.0"` - plus `"id":1` when it names no id - and is sent as application/json; a frame already declaring a string `"jsonrpc"` is sent byte for byte, so write the frame yourself to choose your own id or to send a notification (no id). A top-level array is a batch call and is sent unchanged. An xml `body` is sent byte for byte as application/xml; a Content-Type you set yourself wins.'
				),
			auth: authInput,
			httpVersion: z
				.enum(HTTP_VERSIONS)
				.optional()
				.describe(
					'Protocol to negotiate: "auto" | "http1.1" | "http2" (default "auto"). Mirrors the request builder\'s Settings tab picker.'
				),
			verifySSL: verifySSLSendInput,
			requestId: z.string().optional().describe("Optional saved request ID to link."),
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
			refuseAgentScripts(args, ctx.config.revealSecretsToAgents, elementsArg(args));
			const request: Record<string, unknown> = {
				...readRequestOverrides(args),
				url: requireStr(args, "url"),
			};
			if (request.method === undefined) request.method = "GET";
			/*
			 * The two ad-hoc scripts, as the `elements` entries `/execute` now
			 * takes: it refuses `preRequestScript` / `postRequestScript` / `tests`
			 * outright (issue #1514), and `/compose` copies an inline request's
			 * keys onto the payload verbatim, so sending the old names here would
			 * surface as a 400 from the send rather than from composition.
			 *
			 * The request's own scripts only, which is the scope this tool always
			 * had: composition is inline (no `requestId` reaches `/compose`, see
			 * below), so there is no stored row or collection chain to inherit
			 * elements from and nothing is being dropped by not walking one.
			 * Scripts ride through composition untouched - the engine never
			 * interpolates them. An ad-hoc `elements` argument (issue #1517) joins
			 * the same list, for a caller who wants more than a script.
			 */
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
			if (elements.length > 0) request.elements = elements;
			const authArg = readAuthArg(args);
			if (authArg) request.auth = authArg;

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
						request,
						collectionId: str(args, "collectionId"),
						environmentId: str(args, "environmentId"),
					},
					signal
				);
			} catch (err) {
				if (err instanceof ToolArgError) return errorResult(err.message);
				return engineErrorResult(err);
			}
			const gate = checkAllowlist(String(payload.url ?? ""), ctx.config);
			if (!gate.ok) return errorResult(gate.error!);
			// `requestId` here only links the run to a saved request for History;
			// it must not reach /compose, which would compose the *stored* row
			// instead of the arguments the agent actually gave.
			const linkId = str(args, "requestId");
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
			if (!streaming) {
				return callEngineForRunOutput(
					ctx,
					() => ctx.client.executeRequest(withMcpOrigin(payload, ctx), signal),
					{ bound: boundExecuteResponse, signal, auth: payload.auth }
				);
			}
			return runStreamingRequest(args, payload, ctx, signal);
		},
	},
];
