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
import {
	authCredentialValues,
	originChanged,
	restoreWithheldRequestUrl,
	secretsShape,
	withholdRequestUrl,
	withheldPointer,
	type KeptUrlSlot,
} from "../withhold.js";
import type { McpTool, ToolContext, ToolResult } from "./contract.js";
import {
	callEngine,
	confirmDestructive,
	confirmedInput,
	echoShape,
	elementsArg,
	engineErrorResult,
	errorResult,
	isRecord,
	mergeAndWrite,
	requireStr,
	str,
	ToolArgError,
	withCaveat,
	writesDisabled,
} from "./kit.js";
import { ID_KINDS } from "./failure.js";
import { fileRefInput, shapeBody } from "./request-body.js";
import { readAuthArg, readScriptEdits, scriptElement, upsertScriptElement } from "./compose.js";
import {
	applyRequestSettings,
	asOn,
	elementsInput,
	requestSettingsInput,
	storedAuthInput,
	storedHeadersInput,
	storedScriptInput,
} from "./input-schemas.js";
import {
	credentialRowsKept,
	droppedHeadersCaveat,
	droppedWithheldHeaders,
	keepsStoredValue,
	newHeaderRows,
	readHeaderRows,
	restoreWithheldHeaderRows,
	type HeaderRowArg,
} from "./header-rows.js";
import { refuseRedactedHeaders, refuseRedactedUrl } from "./redacted-input.js";
import { BINARY_FILE_ACCESS_TOKEN, GUARDED_WRITE_SENTENCE } from "../remedy.js";

export const REQUEST_TOOLS: McpTool[] = [
	{
		name: "create_request",
		category: "write",
		retry: { check: "list_requests", noun: "request" },
		invalidates: ["request"],
		description: (config) =>
			"Create a saved request inside a collection (stores it; does not send it), with its auth, redirect policy, protocol, stream flag, certificate-verification setting and its elements (extractors, assertions, timers, scripts) - everything the app's builder stores except form-data file parts. " +
			GUARDED_WRITE_SENTENCE +
			'. The URL may contain {{variables}} since it is only saved, not executed, and a stored element runs only when the request is later sent. Auth is stored as written and resolved at send time, so {{variables}} inside it are fine; leaving `auth` out stores the default "inherit", which resolves against the collection chain.' +
			withheldPointer(config),
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
			headers: storedHeadersInput(
				"Ordered {key, value, enabled?} rows (repeats and disabled rows kept), or a {name: value} map."
			),
			body: z.string().optional().describe("Request body content."),
			file: fileRefInput(),
			bodyType: z
				.string()
				.optional()
				.describe(
					'Body type: json, text, graphql, jsonrpc, xml, form-data, x-www-form-urlencoded, binary (default text). For the two form types, write `body` as `key=value&key=value`; it is split into form fields. A jsonrpc `body` may be the bare call object - the engine adds `"jsonrpc":"2.0"` and `"id":1` when it names no id, and sends a frame that already declares a string `"jsonrpc"` unchanged. `binary` sends one file as the whole body: pass `file` instead of `body` (`file` alone implies `binary`). The engine sends the path only once ' +
						BINARY_FILE_ACCESS_TOKEN +
						', because an agent cannot choose a file on their behalf. Form-data file parts are not supported here; author them in the app. A graphql `body` may be the bare query document, and the method decides how it travels: the `{"query": ...}` JSON envelope on POST, `query`/`operationName`/`variables` query parameters with no body on GET - so give a mutation `method` POST rather than leaving the GET a new request defaults to. An xml `body` is stored and sent verbatim as application/xml.'
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
			const auth = readAuthArg(args, ctx);
			if (auth) payload.auth = auth;
			refuseRedactedUrl(ctx, payload.url, auth);
			applyRequestSettings(args, payload);
			if (args.headers !== undefined) {
				const headers = newHeaderRows(args.headers);
				refuseRedactedHeaders(ctx, headers, auth);
				payload.headers = headers;
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
					'Pass "elements" or "preRequestScript"/"postRequestScript", not both - add a "script.pre"/"script.post" entry to "elements" directly instead.',
					"input"
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
			return callEngine(ctx, () => ctx.client.createRequest(payload, signal), echoShape(ctx));
		},
	},
	{
		name: "update_request",
		category: "write",
		invalidates: ["request"],
		notFound: { ...ID_KINDS.request, idArg: "requestId" },
		description: (config) =>
			"Correct a saved request: its name, URL, method, headers, body, auth, redirect policy, protocol, stream flag, certificate-verification setting, description or elements (extractors, assertions, timers, scripts). " +
			GUARDED_WRITE_SENTENCE +
			". Only the fields you pass change - anything you leave out keeps its stored value. Passing `headers` replaces the whole header list, so send every header the request should end up with; passing `auth` replaces the whole auth block, so send the mode and its credentials together ({ mode: 'none' } clears it, { mode: 'inherit' } hands it back to the collection chain); passing `elements` replaces the whole elements list; passing a script replaces just that script's element, and an empty string clears it. `mockResponseMode`/`mockExampleId` set which saved example a mock server answers this request with (`mockExampleId: null` clears it) - get_mock_routes shows the effect once a mock is running." +
			withheldPointer(config),
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
			headers: storedHeadersInput(
				"Replaces the stored list: ordered {key, value?, enabled?} rows (a row as read with valueWithheld: true keeps its stored value; its description, source and type are stored with it, so write them back as read), or a {name: value} map."
			),
			body: z.string().optional().describe("New request body content."),
			file: fileRefInput("create_request"),
			bodyType: z
				.string()
				.optional()
				.describe(
					"Body type for `body`: json, text, graphql, jsonrpc, xml, form-data, x-www-form-urlencoded, binary. Only meaningful alongside `body`, or alongside `file` for binary, which replaces the body with that file exactly as `create_request` describes - sent only once " +
						BINARY_FILE_ACCESS_TOKEN +
						". A jsonrpc `body` is enveloped engine-side exactly as `create_request` describes, and a graphql `body` travels by the same method-dependent rule that tool describes - the JSON envelope on POST, query parameters on GET; an xml `body` is stored and sent verbatim as application/xml. Form-data file parts are not supported here; a stored one is left alone unless `body` replaces the whole body."
				),
			description: z.string().optional().describe("New description."),
			auth: storedAuthInput(
				"this request",
				"Replaces the stored block whole - send the mode and its credentials together. Leave it out to keep what is stored."
			),
			...requestSettingsInput("create_request"),
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
			elements: elementsInput("this request").describe(asOn("create_request")),
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
			const headers = args.headers === undefined ? undefined : readHeaderRows(args.headers);
			// Auth and the six Settings fields ride the same rule as the strings
			// above: stated is written, absent is left alone. The block replaces
			// the stored one wholesale because the engine stores it as one JSON
			// column - there is no per-credential patch to offer.
			const auth = readAuthArg(args, ctx);
			if (auth) payload.auth = auth;
			// Before any read of the stored row, so a refused call touches nothing.
			refuseRedactedCredentials(ctx, payload.url, headers, auth);
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
					'"mockResponseMode": "fixed" needs "mockExampleId" - pass the example it should serve.',
					"input"
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
					'Pass "elements" or "preRequestScript"/"postRequestScript", not both - add a "script.pre"/"script.post" entry to "elements" directly instead.',
					"input"
				);
			}
			if (
				Object.keys(payload).length === 0 &&
				scriptEdits.length === 0 &&
				headers === undefined &&
				elementsGiven === undefined
			) {
				return errorResult(
					"Pass at least one field to change (name, url, method, headers, body, file, auth, followRedirects, maxRedirects, timeout, httpVersion, stream, description, mockResponseMode, mockExampleId, elements, preRequestScript or postRequestScript).",
					"input"
				);
			}
			if (elementsGiven !== undefined) {
				payload.elements = elementsGiven;
			}
			return writeRequestEdits(
				ctx,
				requestId,
				payload,
				{ scripts: scriptEdits, headers },
				signal
			);
		},
	},
	{
		name: "delete_request",
		category: "write",
		invalidates: ["request"],
		notFound: { ...ID_KINDS.request, idArg: "requestId" },
		description:
			"Delete a saved request. " +
			GUARDED_WRITE_SENTENCE +
			", and confirmation: if the client supports elicitation the user is prompted with the request's name and URL; otherwise call once for a preview, then again with `confirmed: true`. It goes to Vayu's Trash rather than disappearing outright - list_trash shows it there, and restore_trash_entry puts it back, until the retention window (`trashRetentionDays`, 30 days by default) runs out.",
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
				return engineErrorResult(err, ctx);
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
			return callEngine(ctx, () => ctx.client.deleteRequest(requestId, signal));
		},
	},
];

/** Refuse the call's URL and header rows that hold the redaction marker as a credential (#3553). */
function refuseRedactedCredentials(
	ctx: ToolContext,
	url: unknown,
	headers: HeaderRowArg[] | undefined,
	auth: unknown
): void {
	refuseRedactedUrl(ctx, url, auth);
	if (headers !== undefined) refuseRedactedHeaders(ctx, headers, auth);
}

/**
 * Refuse a write that moves @p stored to another origin while a credential
 * stored on it would go with it (#3654): a credential header row the call leaves
 * holding its stored value, or an `auth` block the call does not replace. A stored
 * credential belongs to the address it was stored for, and the call has to say
 * what the new one gets. A URL's userinfo and query credentials are not judged
 * here: the merge leaves them empty and names them in the answer instead.
 */
function refuseStoredCredentialsToNewOrigin(
	stored: Record<string, unknown>,
	payload: Record<string, unknown>,
	edits: StoredEdits
): void {
	if (typeof payload.url !== "string" || !originChanged(stored.url, payload.url)) return;
	const followers: string[] = [];
	const rows = credentialRowsKept(stored.headers, stored.auth, edits.headers);
	if (rows.length > 0) {
		followers.push(
			`the ${rows.map((name) => `"${name}"`).join(", ")} header row${rows.length > 1 ? "s" : ""}`
		);
	}
	if (payload.auth === undefined && authCredentialValues(stored.auth).length > 0) {
		followers.push(`the "${storedAuthMode(stored.auth)}" auth`);
	}
	if (followers.length === 0) return;
	throw new ToolArgError(
		`Nothing was written: "url" moves this request to another origin (scheme, host or port), and ${followers.join(" and ")} stored on it would be sent there. In the same call, supply them for the new origin (pass "headers" with a real value for each row, and "auth" with the real credentials) or clear them (pass "auth" as {"mode": "none"}, and leave the rows out of "headers").`,
		"input"
	);
}

function storedAuthMode(auth: unknown): string {
	const mode = isRecord(auth) ? auth.mode : undefined;
	return typeof mode === "string" ? mode : "unknown";
}

/** The `update_request` edits that may need the stored row to be written. */
interface StoredEdits {
	scripts: ReturnType<typeof readScriptEdits>;
	headers: HeaderRowArg[] | undefined;
}

/**
 * `update_request`'s write. `PUT /requests/:id` merge-patches, so a payload of
 * stated fields is sent as it is, with no read. Edits that need the stored row
 * become one read-merge-write under its version (`mergeAndWrite`); see
 * `readsStoredRequest` for which.
 */
async function writeRequestEdits(
	ctx: ToolContext,
	requestId: string,
	payload: Record<string, unknown>,
	edits: StoredEdits,
	signal: AbortSignal | undefined
): Promise<ToolResult> {
	const reveal = ctx.config.revealSecretsToAgents;
	if (!readsStoredRequest(payload, edits, reveal)) {
		// No edit left on this path consults the stored row, so an empty one stands in.
		const { body } = mergeRequestEdits({}, payload, edits, reveal);
		return callEngine(
			ctx,
			() => ctx.client.updateRequest(requestId, body, signal),
			echoShape(ctx)
		);
	}
	let caveat = "";
	const result = await mergeAndWrite(ctx, {
		subject: `request "${requestId}"`,
		read: () => ctx.client.getRequest(requestId, signal),
		merge: (stored) => {
			// The stored auth can name a credential header or query key the call's own does not.
			refuseRedactedCredentials(ctx, payload.url, edits.headers, payload.auth ?? stored.auth);
			if (!reveal) refuseStoredCredentialsToNewOrigin(stored, payload, edits);
			const merged = mergeRequestEdits(stored, payload, edits, reveal);
			caveat = merged.caveat;
			return merged.body;
		},
		write: (body, ifMatch) => ctx.client.updateRequest(requestId, body, signal, ifMatch),
		shape: echoShape(ctx),
	});
	return result.isError ? result : withCaveat(result, caveat);
}

/**
 * Whether the write needs the stored row: a script edit, because the engine
 * replaces the `elements` list whole (#1514); a header row written back
 * withheld, which keeps the stored value (#3550); and, while secrets are
 * withheld, a `url`, whose credentials the read emptied (#3549), or any
 * `headers`, so a stored row the session could not read is named when the
 * write drops it (#3550).
 */
function readsStoredRequest(
	payload: Record<string, unknown>,
	edits: StoredEdits,
	reveal: boolean
): boolean {
	if (edits.scripts.length > 0 || edits.headers?.some(keepsStoredValue)) return true;
	return !reveal && (typeof payload.url === "string" || edits.headers !== undefined);
}

/** The body to write over @p stored, and the caveat lines naming what it kept or dropped unread. */
function mergeRequestEdits(
	stored: Record<string, unknown>,
	payload: Record<string, unknown>,
	edits: StoredEdits,
	reveal: boolean
): { body: Record<string, unknown>; caveat: string } {
	const body: Record<string, unknown> = { ...payload };
	const notes: string[] = [];
	if (typeof payload.url === "string" && !reveal) {
		const restored = restoreWithheldRequestUrl(stored.url, payload.url, stored.auth);
		body.url = restored.url;
		notes.push(keptUrlSlotsCaveat(restored.kept), uncarriedUrlSlotsCaveat(restored.notCarried));
	}
	if (edits.headers !== undefined) {
		body.headers = restoreWithheldHeaderRows(stored.headers, edits.headers);
		if (!reveal) {
			notes.push(
				droppedHeadersCaveat(
					droppedWithheldHeaders(stored.headers, stored.auth, edits.headers)
				)
			);
		}
	}
	if (edits.scripts.length > 0) {
		let elements = stored.elements;
		for (const [which, script] of edits.scripts) {
			elements = upsertScriptElement(elements, which, script);
		}
		body.elements = elements;
	}
	return { body, caveat: notes.filter((note) => note !== "").join("\n") };
}

/** One line per slot of the written URL that kept its stored credential. */
function keptUrlSlotsCaveat(kept: KeptUrlSlot[]): string {
	return kept
		.map((slot) =>
			slot.part === "userinfo"
				? "The URL's userinfo password kept its stored value; remove the userinfo to drop it."
				: `${slot.name}${slot.part === "fragment" ? " (in the fragment)" : ""} kept its stored value; remove the parameter to drop it.`
		)
		.join("\n");
}

/** One line per credential slot of the stored URL left empty because the written URL changed the host (#3564). */
function uncarriedUrlSlotsCaveat(notCarried: KeptUrlSlot[]): string {
	return notCarried
		.map((slot) => {
			const name =
				slot.part === "userinfo"
					? "The URL's userinfo password"
					: `${slot.name}${slot.part === "fragment" ? " (in the fragment)" : ""}`;
			return `${name} was not carried because the host changed; give it a value or remove it.`;
		})
		.join("\n");
}
