/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @brief A saved request's examples: list, create, update and delete.
 */

import { z } from "zod";
import { EngineRequestError } from "../engine-client.js";
import { secretsShape, withholdRowListSecrets, withheldPointer } from "../withhold.js";
import type { McpTool, ToolContext, ToolResult } from "./contract.js";
import {
	callEngine,
	callEngineForRunOutput,
	confirmDestructive,
	confirmedInput,
	echoShape,
	engineErrorResult,
	errorResult,
	isRecord,
	mergeAndWrite,
	requireStr,
	withCaveat,
	writesDisabled,
} from "./kit.js";
import { ID_KINDS, unknownIdText } from "./failure.js";
import { MAX_INLINE_BODY_BYTES } from "./inline-body-bounds.js";
import { requestExamplesSchema } from "./output-schemas.js";
import {
	boundExampleBodies,
	describeExample,
	describeExampleDeleteOutcome,
	exampleFields,
	exampleWritePayload,
	MAX_EXAMPLES_BODY_BYTES,
} from "./examples.js";
import {
	droppedHeadersCaveat,
	droppedWithheldHeaders,
	keepsStoredValue,
	readHeaderRows,
	restoreWithheldHeaderRows,
	type HeaderRowArg,
} from "./header-rows.js";
import { storedHeadersInput } from "./input-schemas.js";
import { refuseRedactedHeaders } from "./redacted-input.js";
import { GUARDED_WRITE_SENTENCE } from "../remedy.js";

export const EXAMPLE_TOOLS: McpTool[] = [
	{
		name: "list_request_examples",
		category: "read",
		retry: "safe",
		invalidates: [],
		notFound: { ...ID_KINDS.request, idArg: "requestId" },
		description: (config) =>
			"List a request's saved example responses - the responses stored beside it, in the order a mock server would serve them (the first match answers). Every row carries its name, status, headers, content type, `order` and `origin` (`import` for what an importer or an OpenAPI sync wrote, `user` for what was saved from a live response). " +
			`Bodies are bounded: one over ${MAX_INLINE_BODY_BYTES} bytes comes back cut with \`bodyClipped: true\` and its stored size in \`bodyBytes\`, and once the list has spent ${MAX_EXAMPLES_BODY_BYTES} bytes the remaining bodies are dropped with \`bodyOmitted: true\` (the row's scalars are always kept). \`bodiesOmitted\` counts them, and read_body (\`requestId\`, \`exampleId\`) pages out either in full. The engine's own \`bodyTruncated\` is a different fact - it says the response was already cut when it was captured.` +
			withheldPointer(config) +
			(config.revealSecretsToAgents ? "" : " A body's secrets read `<redacted>`."),
		annotations: {
			title: "List saved examples",
			readOnlyHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			requestId: z.string().describe("Saved request whose examples to list."),
		},
		outputSchema: requestExamplesSchema,
		handler: async (args, ctx, signal) => {
			const requestId = requireStr(args, "requestId");
			// Headers are withheld first, then every string (a body included) is
			// masked as a run's output is, and only then bounded: a cut through an
			// unmasked secret leaves a prefix no secret form matches, which is the
			// order read_body keeps for the same example (#3724).
			return callEngineForRunOutput(
				ctx,
				async () =>
					secretsShape(
						ctx,
						withholdRowListSecrets
					)(await ctx.client.listRequestExamples(requestId, signal)),
				{ bound: boundExampleBodies, structured: true, signal }
			);
		},
	},
	{
		name: "create_request_example",
		category: "write",
		retry: { check: "list_request_examples", noun: "request example" },
		invalidates: ["request"],
		notFound: { ...ID_KINDS.request, idArg: "requestId" },
		description: (config) =>
			"Save an example response on a request - what a mock server for its collection answers with, and what the Examples tab shows. " +
			GUARDED_WRITE_SENTENCE +
			". `headers` takes ordered `{key, value, enabled?}` rows (one per line of a repeated header such as Set-Cookie) or a string map. Vayu assigns the id and appends the example after the request's current ones; a request already holding the maximum (100) is refused by the engine. The example is marked as written by hand: an agent cannot claim an example came from an import, because an OpenAPI sync replaces imported examples and leaves the others alone." +
			withheldPointer(config),
		annotations: {
			title: "Create saved example",
			readOnlyHint: false,
			destructiveHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			requestId: z.string().describe("Saved request to attach the example to."),
			name: z.string().describe("Display name for the example (e.g. '200 OK')."),
			status: z
				.number()
				.int()
				.min(200)
				.max(599)
				.optional()
				.describe("Final status, 200-599 (default 200)."),
			headers: storedHeadersInput(
				"Response headers. Ordered {key, value, enabled?} rows, or a {name: value} map."
			),
			body: z.string().optional().describe("Response body, stored verbatim."),
			contentType: z
				.string()
				.optional()
				.describe(
					"Content type of `body` (e.g. application/json). Stored beside the headers; a mock server sends it."
				),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const requestId = requireStr(args, "requestId");
			const payload = exampleWritePayload(args, ctx);
			payload.name = requireStr(args, "name");
			// Stated rather than left to the engine's default, which is `import`:
			// this row was written by an agent, and the sync that replaces
			// imported rows must not be handed one it did not write (#588, #722).
			payload.origin = "user";
			return callEngine(
				ctx,
				() => ctx.client.createRequestExample(requestId, payload, signal),
				echoShape(ctx)
			);
		},
	},
	{
		name: "update_request_example",
		category: "write",
		invalidates: ["request"],
		notFound: [
			{ ...ID_KINDS.request, idArg: "requestId" },
			{ ...ID_KINDS.example, idArg: "exampleId" },
		],
		description: (config) =>
			"Correct a saved example: its name, status, headers, body or content type. " +
			GUARDED_WRITE_SENTENCE +
			". Only the fields you pass change; passing `headers` replaces the whole header list, as ordered `{key, value, enabled?}` rows (one per line of a repeated header such as Set-Cookie) or a string map. Where the example came from is not editable - an imported example stays imported, which is what lets an OpenAPI sync tell the two apart." +
			withheldPointer(config),
		annotations: {
			title: "Update saved example",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			requestId: z.string().describe("Request that owns the example."),
			exampleId: z.string().describe("Example ID to update."),
			name: z.string().optional().describe("New display name."),
			status: z.number().int().min(200).max(599).optional().describe("New status, 200-599."),
			headers: storedHeadersInput(
				"Replacement response headers (replaces the stored list). Ordered {key, value?, enabled?} rows (a row as read with valueWithheld: true keeps its stored value; its description, source and type are stored with it, so write them back as read), or a {name: value} map."
			),
			body: z.string().optional().describe("New response body."),
			contentType: z.string().optional().describe("New content type for `body`."),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const requestId = requireStr(args, "requestId");
			const exampleId = requireStr(args, "exampleId");
			const fields = exampleFields(args);
			const headers = args.headers === undefined ? undefined : readHeaderRows(args.headers);
			if (headers !== undefined) refuseRedactedHeaders(ctx, headers, undefined);
			if (Object.keys(fields).length === 0 && headers === undefined) {
				return errorResult(
					'Pass at least one field to change ("name", "status", "headers", "body" or "contentType").',
					"input"
				);
			}
			return writeExampleEdits(ctx, { requestId, exampleId, fields, headers }, signal);
		},
	},
	{
		name: "delete_request_example",
		category: "write",
		invalidates: ["request"],
		notFound: [
			{ ...ID_KINDS.request, idArg: "requestId" },
			{ ...ID_KINDS.example, idArg: "exampleId" },
		],
		description:
			"Delete one saved example from a request. " +
			GUARDED_WRITE_SENTENCE +
			", and confirmation: if the client supports elicitation the user is prompted with the example's name and what a mock server loses; otherwise call once for a preview, then again with `confirmed: true`. A saved example (`origin: 'user'`) goes to Vayu's Trash - list_trash shows it, restore_trash_entry puts it back. An imported one (`origin: 'import'`) is not trashed: it becomes a spec-sync tombstone with no restore, and only re-importing the document brings it back. Either way a mock server for this collection stops answering with it once it is restarted.",
		annotations: {
			title: "Delete saved example",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			requestId: z.string().describe("Request that owns the example."),
			exampleId: z.string().describe("Example ID to delete."),
			confirmed: confirmedInput("actually delete the example"),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const requestId = requireStr(args, "requestId");
			const exampleId = requireStr(args, "exampleId");
			// Read the list first so the prompt names the example rather than an
			// id - the same rule delete_request follows. There is no by-id read
			// for one example, and the owner check the engine makes on every
			// nested path is exactly this scan: an id stored under another
			// request is "no such example" here too.
			let stored: Record<string, unknown> | undefined;
			try {
				const rows = await ctx.client.listRequestExamples(requestId, signal);
				stored = (Array.isArray(rows) ? rows : []).find(
					(row) => isRecord(row) && row.id === exampleId
				) as Record<string, unknown> | undefined;
			} catch (err) {
				return engineErrorResult(err, ctx);
			}
			if (!stored) {
				return errorResult(unknownIdText(ID_KINDS.example, exampleId), "not_found");
			}
			const subject = describeExample(exampleId, stored);
			const consequence = describeExampleDeleteOutcome(stored);
			const unconfirmed = await confirmDestructive(args, ctx, {
				message: `Delete the saved example ${subject}?\n\n${consequence}`,
				acceptTitle: "Delete the example",
				acceptDescription: "Confirm to delete this saved example.",
				declined: "Example not deleted - the user declined.",
				preview:
					"AWAITING CONFIRMATION - nothing was deleted.\n\n" +
					`This would delete the saved example ${subject}. ${consequence}\n\n` +
					"This is a preview. To delete it, call delete_request_example again with confirmed: true and the same arguments.",
			});
			if (unconfirmed) return unconfirmed;
			return callEngine(ctx, () =>
				ctx.client.deleteRequestExample(requestId, exampleId, signal)
			);
		},
	},
];

/** The edits one `update_request_example` call makes to one example. */
interface ExampleEdits {
	requestId: string;
	exampleId: string;
	fields: Record<string, unknown>;
	headers: HeaderRowArg[] | undefined;
}

/**
 * `update_request_example`'s write. `PUT` merge-patches, so stated fields are
 * sent as they are, with no read. `headers` replaces the stored list, so it
 * becomes one read-merge-write under the example's version (`mergeAndWrite`)
 * when a row written back withheld keeps its stored value, and, while secrets
 * are withheld, whenever it is given, so a stored row the session could not
 * read is named when the write drops it (#3550).
 */
async function writeExampleEdits(
	ctx: ToolContext,
	{ requestId, exampleId, fields, headers }: ExampleEdits,
	signal: AbortSignal | undefined
): Promise<ToolResult> {
	const reveal = ctx.config.revealSecretsToAgents;
	if (headers === undefined || (reveal && !headers.some(keepsStoredValue))) {
		// No row left here keeps a stored value, so an empty list stands in for it.
		const body =
			headers === undefined
				? fields
				: { ...fields, headers: restoreWithheldHeaderRows(undefined, headers) };
		return callEngine(
			ctx,
			() => ctx.client.updateRequestExample(requestId, exampleId, body, signal),
			echoShape(ctx)
		);
	}
	let caveat = "";
	const result = await mergeAndWrite(ctx, {
		subject: `example "${exampleId}"`,
		read: () => readStoredExample(ctx, requestId, exampleId, signal),
		merge: (stored) => {
			const rows = restoreWithheldHeaderRows(stored.headers, headers);
			// An example has no auth block, so no API-key header joins the credential names.
			if (!reveal) {
				caveat = droppedHeadersCaveat(
					droppedWithheldHeaders(stored.headers, undefined, rows)
				);
			}
			return { ...fields, headers: rows };
		},
		write: (body, ifMatch) =>
			ctx.client.updateRequestExample(requestId, exampleId, body, signal, ifMatch),
		shape: echoShape(ctx),
	});
	return result.isError ? result : withCaveat(result, caveat);
}

/**
 * The example as stored. There is no by-id read, so it is found in the
 * request's list. An id the list does not hold fails as the `PUT` would, with
 * the engine's own 404, so the call answers `not_found` and not a header row
 * with nothing stored to keep.
 */
async function readStoredExample(
	ctx: ToolContext,
	requestId: string,
	exampleId: string,
	signal: AbortSignal | undefined
): Promise<unknown> {
	const rows = await ctx.client.listRequestExamples(requestId, signal);
	const stored = (Array.isArray(rows) ? rows : []).find(
		(row) => isRecord(row) && row.id === exampleId
	);
	if (stored !== undefined) return stored;
	throw new EngineRequestError(
		`Engine responded 404 for PUT /requests/${requestId}/examples/${exampleId}`,
		404,
		JSON.stringify({ error: { code: "not_found", message: "Example not found" } })
	);
}
