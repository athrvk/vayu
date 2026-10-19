/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file requests.tools.ts
 * @brief Saved-request writes: create, update and delete.
 */

import { z } from "zod";
import { EngineRequestError } from "../engine-client.js";
import {
	secretsShape,
	WITHHELD_AUTH_SENTENCE,
	WITHHELD_HEADER_SENTENCE,
	WITHHELD_URL_SENTENCE,
	withholdRequestUrl,
} from "../withhold.js";
import type { McpTool } from "./contract.js";
import {
	callEngine,
	confirmDestructive,
	confirmedInput,
	echoShape,
	elementsArg,
	engineErrorResult,
	errorResult,
	requireStr,
	str,
	writesDisabled,
} from "./kit.js";
import { fileRefInput, shapeBody } from "./request-body.js";
import { readAuthArg, readScriptEdits, scriptElement, upsertScriptElement } from "./compose.js";
import {
	applyRequestSettings,
	elementsInput,
	requestSettingsInput,
	storedAuthInput,
	storedScriptInput,
} from "./input-schemas.js";
import { toKeyValueEntries } from "./scenario-runs.js";

export const REQUEST_TOOLS: McpTool[] = [
	{
		name: "create_request",
		category: "write",
		invalidates: ["request"],
		description:
			'Create a saved request inside a collection (stores it; does not send it), with its auth, redirect policy, protocol, stream flag, certificate-verification setting and its elements (extractors, assertions, timers, scripts) - everything the app\'s builder stores except form-data file parts. GUARDED: requires write access to be enabled in Vayu Settings. The URL may contain {{variables}} since it is only saved, not executed, and a stored element runs only when the request is later sent. Auth is stored as written and resolved at send time, so {{variables}} inside it are fine; leaving `auth` out stores the default "inherit", which resolves against the collection chain.' +
			" " +
			WITHHELD_AUTH_SENTENCE +
			" " +
			WITHHELD_HEADER_SENTENCE +
			" " +
			WITHHELD_URL_SENTENCE,
		annotations: {
			title: "Create saved request",
			readOnlyHint: false,
			destructiveHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z.string().describe("Collection to add the request to."),
			name: z.string().describe("Display name for the saved request."),
			url: z.string().describe("Request URL (may contain {{variables}})."),
			method: z.string().optional().describe("HTTP method (default GET)."),
			headers: z
				.record(z.string(), z.string())
				.optional()
				.describe("Headers as a string map."),
			body: z.string().optional().describe("Request body content."),
			file: fileRefInput,
			bodyType: z
				.string()
				.optional()
				.describe(
					'Body type: json, text, graphql, jsonrpc, xml, form-data, x-www-form-urlencoded, binary (default text). For the two form types, write `body` as `key=value&key=value`; it is split into form fields. A jsonrpc `body` may be the bare call object - the engine adds `"jsonrpc":"2.0"` and `"id":1` when it names no id, and sends a frame that already declares a string `"jsonrpc"` unchanged. `binary` sends one file as the whole body: pass `file` instead of `body` (`file` alone implies `binary`). The engine sends the path only once the user has picked that file in the request editor or it lies under a folder allowed in Settings > Files, because an agent cannot choose a file on their behalf. Form-data file parts are not supported here; author them in the app. A graphql `body` may be the bare query document, and the method decides how it travels: the `{"query": ...}` JSON envelope on POST, `query`/`operationName`/`variables` query parameters with no body on GET - so give a mutation `method` POST rather than leaving the GET a new request defaults to. An xml `body` is stored and sent verbatim as application/xml.'
				),
			description: z.string().optional(),
			auth: storedAuthInput(
				"this request",
				'Omit it for the stored default, "inherit", which resolves against the collection chain when the request is sent.'
			),
			...requestSettingsInput(),
			elements: elementsInput("this request"),
			preRequestScript: storedScriptInput("pre", false),
			postRequestScript: storedScriptInput("post", false),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const payload: Record<string, unknown> = {
				collectionId: requireStr(args, "collectionId"),
				name: requireStr(args, "name"),
				url: requireStr(args, "url"),
				method: str(args, "method") ?? "GET",
			};
			const auth = readAuthArg(args);
			if (auth) payload.auth = auth;
			applyRequestSettings(args, payload);
			if (args.headers && typeof args.headers === "object") {
				payload.headers = toKeyValueEntries(args.headers);
			}
			// The engine stores the body blob verbatim; the canonical shape keys
			// off `mode` (not `type`), so a `type`-keyed body would not round-trip
			// in the app. `bodyType` mirrors it into the denormalized column.
			// A malformed body throws `ToolArgError`, which `dispatchTool` answers
			// as a tool error before anything is written.
			const shaped = shapeBody(args);
			if (shaped) {
				payload.body = shaped.body;
				payload.bodyType = shaped.bodyType;
			}
			// Pass-through strings: absent leaves the engine's own default (empty),
			// so only what the caller actually named is sent.
			const description = str(args, "description");
			if (description !== undefined) payload.description = description;
			// `elements` and the script sugar cannot both be given (elementsInput's
			// description says so): a caller who stated the whole list has already
			// said what belongs in it.
			const elementsGiven = elementsArg(args);
			const scriptEdits = readScriptEdits(args);
			if (elementsGiven !== undefined && scriptEdits.length > 0) {
				return errorResult(
					'Pass "elements" or "preRequestScript"/"postRequestScript", not both - add a "script.pre"/"script.post" entry to "elements" directly instead.'
				);
			}
			if (elementsGiven !== undefined) {
				payload.elements = elementsGiven;
			} else {
				// Scripts are `elements` on the wire (issue #1514). Nothing is
				// stored yet on a create, so the list is built outright rather
				// than merged.
				const elements: Record<string, unknown>[] = [];
				for (const [which, script] of scriptEdits) {
					if (script !== "") elements.push(scriptElement(which, script));
				}
				if (elements.length > 0) payload.elements = elements;
			}
			return callEngine(() => ctx.client.createRequest(payload, signal), echoShape(ctx));
		},
	},
	{
		name: "update_request",
		category: "write",
		invalidates: ["request"],
		description:
			"Correct a saved request: its name, URL, method, headers, body, auth, redirect policy, protocol, stream flag, certificate-verification setting, description or elements (extractors, assertions, timers, scripts). GUARDED: requires write access to be enabled in Vayu Settings. Only the fields you pass change - anything you leave out keeps its stored value. Passing `headers` replaces the whole header list, so send every header the request should end up with; passing `auth` replaces the whole auth block, so send the mode and its credentials together ({ mode: 'none' } clears it, { mode: 'inherit' } hands it back to the collection chain); passing `elements` replaces the whole elements list; passing a script replaces just that script's element, and an empty string clears it. `mockResponseMode`/`mockExampleId` set which saved example a mock server answers this request with (`mockExampleId: null` clears it) - get_mock_routes shows the effect once a mock is running." +
			" " +
			WITHHELD_AUTH_SENTENCE +
			" " +
			WITHHELD_HEADER_SENTENCE +
			" " +
			WITHHELD_URL_SENTENCE,
		annotations: {
			title: "Update saved request",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			requestId: z.string().describe("Saved request ID to update."),
			name: z.string().optional().describe("New display name."),
			url: z.string().optional().describe("New URL (may contain {{variables}})."),
			method: z.string().optional().describe("New HTTP method."),
			headers: z
				.record(z.string(), z.string())
				.optional()
				.describe("Replacement headers as a string map (replaces the stored list)."),
			body: z.string().optional().describe("New request body content."),
			file: fileRefInput,
			bodyType: z
				.string()
				.optional()
				.describe(
					"Body type for `body`: json, text, graphql, jsonrpc, xml, form-data, x-www-form-urlencoded, binary. Only meaningful alongside `body`, or alongside `file` for binary, which replaces the body with that file exactly as `create_request` describes - sent only once the user has picked that file in the request editor or it lies under a folder allowed in Settings > Files. A jsonrpc `body` is enveloped engine-side exactly as `create_request` describes, and a graphql `body` travels by the same method-dependent rule that tool describes - the JSON envelope on POST, query parameters on GET; an xml `body` is stored and sent verbatim as application/xml. Form-data file parts are not supported here; a stored one is left alone unless `body` replaces the whole body."
				),
			description: z.string().optional().describe("New description."),
			auth: storedAuthInput(
				"this request",
				"Replaces the stored block whole - send the mode and its credentials together. Leave it out to keep what is stored."
			),
			...requestSettingsInput(),
			mockResponseMode: z
				.enum(["first", "fixed", "random"])
				.optional()
				.describe(
					"Which saved example a mock server answers with. 'fixed' requires mockExampleId. Takes effect the next time start_mock_server runs, like every other change to a saved example."
				),
			mockExampleId: z
				.string()
				.nullable()
				.optional()
				.describe(
					"The example 'fixed' mode names (an id from list_request_examples). Pass null to clear it."
				),
			elements: elementsInput("this request"),
			preRequestScript: storedScriptInput("pre", true),
			postRequestScript: storedScriptInput("post", true),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const requestId = requireStr(args, "requestId");
			/*
			 * The payload carries exactly what the caller named: `PUT /requests/:id`
			 * is a merge-patch (absent keeps, null resets), so a field omitted here
			 * is a field left alone. That is also why nothing is defaulted - a
			 * `method: "GET"` filler would silently rewrite the stored verb.
			 */
			const payload: Record<string, unknown> = {};
			for (const field of ["name", "url", "method", "description"] as const) {
				const value = str(args, field);
				if (value !== undefined) payload[field] = value;
			}
			const scriptEdits = readScriptEdits(args);
			if (args.headers && typeof args.headers === "object" && !Array.isArray(args.headers)) {
				payload.headers = toKeyValueEntries(args.headers);
			}
			// Auth and the five Settings fields ride the same rule as the strings
			// above: stated is written, absent is left alone. The block replaces
			// the stored one wholesale because the engine stores it as one JSON
			// column - there is no per-credential patch to offer.
			const auth = readAuthArg(args);
			if (auth) payload.auth = auth;
			applyRequestSettings(args, payload);
			const mockResponseMode = args.mockResponseMode as
				"first" | "fixed" | "random" | undefined;
			// `str()` treats `null` the same as absent (it only recognizes a
			// string), which is right for every other field here but wrong for
			// this one: `mockExampleId: null` is how a caller clears the target,
			// same as the engine's own null-vs-absent merge-patch rule, so it
			// needs its own presence check rather than `str()` alone.
			if ("mockExampleId" in args) {
				payload.mockExampleId =
					args.mockExampleId === null ? null : str(args, "mockExampleId");
			}
			if (mockResponseMode === "fixed" && !payload.mockExampleId) {
				return errorResult(
					'"mockResponseMode": "fixed" needs "mockExampleId" - pass the example it should serve.'
				);
			}
			if (mockResponseMode !== undefined) payload.mockResponseMode = mockResponseMode;
			// Both keys move together, the way create_request writes them: the
			// blob is what round-trips in the app, `bodyType` the denormalized
			// column beside it. Writing one without the other leaves the two
			// disagreeing about what the request sends.
			// A malformed body throws `ToolArgError`, which `dispatchTool` answers
			// as a tool error before anything is written.
			const shaped = shapeBody(args);
			if (shaped) {
				payload.body = shaped.body;
				payload.bodyType = shaped.bodyType;
			}
			const elementsGiven = elementsArg(args);
			if (elementsGiven !== undefined && scriptEdits.length > 0) {
				return errorResult(
					'Pass "elements" or "preRequestScript"/"postRequestScript", not both - add a "script.pre"/"script.post" entry to "elements" directly instead.'
				);
			}
			if (
				Object.keys(payload).length === 0 &&
				scriptEdits.length === 0 &&
				elementsGiven === undefined
			) {
				return errorResult(
					"Pass at least one field to change (name, url, method, headers, body, file, auth, followRedirects, maxRedirects, httpVersion, stream, description, mockResponseMode, mockExampleId, elements, preRequestScript or postRequestScript)."
				);
			}
			// Scripts are `elements` now (issue #1514), and `PUT /requests/:id`
			// replaces that list whole rather than patching inside it - so a
			// script edit is a read-merge-write, or it would drop every other
			// element the request holds. Read only when one was actually named:
			// an update that touches no script must not pay for a GET. An
			// explicit `elements` argument has already stated the whole list
			// the caller wants, so no fetch is needed there.
			if (scriptEdits.length > 0) {
				let stored: Record<string, unknown>;
				try {
					stored = ((await ctx.client.getRequest(requestId, signal)) ?? {}) as Record<
						string,
						unknown
					>;
				} catch (err) {
					return engineErrorResult(err);
				}
				let elements = stored.elements;
				for (const [which, script] of scriptEdits) {
					elements = upsertScriptElement(elements, which, script);
				}
				payload.elements = elements;
			}
			if (elementsGiven !== undefined) {
				payload.elements = elementsGiven;
			}
			return callEngine(
				() => ctx.client.updateRequest(requestId, payload, signal),
				echoShape(ctx)
			);
		},
	},
	{
		name: "delete_request",
		category: "write",
		invalidates: ["request"],
		description:
			"Delete a saved request. GUARDED: requires write access to be enabled in Vayu Settings, and confirmation: if the client supports elicitation the user is prompted with the request's name and URL; otherwise call once for a preview, then again with `confirmed: true`. It goes to Vayu's Trash rather than disappearing outright - list_trash shows it there, and restore_trash_entry puts it back, until the retention window (`trashRetentionDays`, 30 days by default) runs out.",
		annotations: {
			title: "Delete saved request",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			requestId: z.string().describe("Saved request ID to delete."),
			confirmed: confirmedInput("actually delete the request"),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const requestId = requireStr(args, "requestId");
			// Read it first so the person answering the prompt sees what is about to
			// go, rather than an id. A 404 here is the answer, not a failure to ask.
			let stored: Record<string, unknown>;
			try {
				const value = await ctx.client.getRequest(requestId, signal);
				stored =
					value && typeof value === "object" ? (value as Record<string, unknown>) : {};
			} catch (err) {
				if (err instanceof EngineRequestError && err.status === 404) {
					return errorResult(`No saved request with id "${requestId}".`);
				}
				return engineErrorResult(err);
			}
			const name =
				typeof stored.name === "string" && stored.name !== "" ? stored.name : requestId;
			// The URL is shown to whoever reads the prompt or the preview, and it can
			// carry a password or a credential query value (#1837).
			const shownUrl = secretsShape(ctx, (url) => withholdRequestUrl(url, stored.auth))(
				stored.url
			);
			const target = [stored.method, shownUrl].filter((v) => typeof v === "string").join(" ");
			const subject = target ? `"${name}" (${target})` : `"${name}"`;
			const unconfirmed = await confirmDestructive(args, ctx, {
				message: `Delete the saved request ${subject}?\n\nIt goes to Vayu's Trash, where it can be restored.`,
				acceptTitle: "Delete the request",
				acceptDescription: "Confirm to delete this saved request.",
				declined: "Request not deleted - the user declined.",
				preview:
					"AWAITING CONFIRMATION - nothing was deleted.\n\n" +
					`This would delete the saved request ${subject}. It would go to Vayu's Trash, where it can be restored.\n\n` +
					"This is a preview. To delete it, call delete_request again with confirmed: true and the same arguments.",
			});
			if (unconfirmed) return unconfirmed;
			return callEngine(() => ctx.client.deleteRequest(requestId, signal));
		},
	},
];
