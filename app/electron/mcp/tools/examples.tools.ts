/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file examples.tools.ts
 * @brief A saved request's examples: list, create, update and delete.
 */

import { z } from "zod";
import { secretsShape, withholdRowListSecrets, withheldPointer } from "../withhold.js";
import type { McpTool } from "./contract.js";
import {
	callEngine,
	callEngineStructured,
	confirmDestructive,
	confirmedInput,
	echoShape,
	engineErrorResult,
	errorResult,
	isRecord,
	requireStr,
	writesDisabled,
} from "./kit.js";
import { MAX_INLINE_BODY_BYTES } from "./inline-body-bounds.js";
import { requestExamplesSchema } from "./output-schemas.js";
import {
	boundExampleBodies,
	describeExample,
	exampleWritePayload,
	MAX_EXAMPLES_BODY_BYTES,
} from "./examples.js";
import { GUARDED_WRITE_SENTENCE } from "../remedy.js";

export const EXAMPLE_TOOLS: McpTool[] = [
	{
		name: "list_request_examples",
		category: "read",
		retry: "safe",
		invalidates: [],
		description: (config) =>
			"List a request's saved example responses - the responses stored beside it, in the order a mock server would serve them (the first match answers). Every row carries its name, status, headers, content type, `order` and `origin` (`import` for what an importer or an OpenAPI sync wrote, `user` for what was saved from a live response). " +
			`Bodies are bounded: one over ${MAX_INLINE_BODY_BYTES} bytes comes back cut with \`bodyClipped: true\` and its stored size in \`bodyBytes\`, and once the list has spent ${MAX_EXAMPLES_BODY_BYTES} bytes the remaining bodies are dropped with \`bodyOmitted: true\` (the row's scalars are always kept). \`bodiesOmitted\` counts them. The engine's own \`bodyTruncated\` is a different fact - it says the response was already cut when it was captured.` +
			withheldPointer(config),
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
			return callEngineStructured(
				ctx,
				() => ctx.client.listRequestExamples(requestId, signal),
				(rows) => boundExampleBodies(secretsShape(ctx, withholdRowListSecrets)(rows))
			);
		},
	},
	{
		name: "create_request_example",
		category: "write",
		retry: { check: "list_request_examples", noun: "request example" },
		invalidates: ["request"],
		description: (config) =>
			"Save an example response on a request - what a mock server for its collection answers with, and what the Examples tab shows. " +
			GUARDED_WRITE_SENTENCE +
			". Vayu assigns the id and appends the example after the request's current ones; a request already holding the maximum (100) is refused by the engine. The example is marked as written by hand: an agent cannot claim an example came from an import, because an OpenAPI sync replaces imported examples and leaves the others alone." +
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
				.min(100)
				.max(599)
				.optional()
				.describe("HTTP status the example answers with (default 200)."),
			headers: z
				.record(z.string(), z.string())
				.optional()
				.describe("Response headers as a string map."),
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
			const payload = exampleWritePayload(args);
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
		description: (config) =>
			"Correct a saved example: its name, status, headers, body or content type. " +
			GUARDED_WRITE_SENTENCE +
			". Only the fields you pass change; passing `headers` replaces the whole header list. Where the example came from is not editable - an imported example stays imported, which is what lets an OpenAPI sync tell the two apart." +
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
			status: z.number().int().min(100).max(599).optional().describe("New HTTP status."),
			headers: z
				.record(z.string(), z.string())
				.optional()
				.describe(
					"Replacement response headers as a string map (replaces the stored list)."
				),
			body: z.string().optional().describe("New response body."),
			contentType: z.string().optional().describe("New content type for `body`."),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const requestId = requireStr(args, "requestId");
			const exampleId = requireStr(args, "exampleId");
			const payload = exampleWritePayload(args);
			if (Object.keys(payload).length === 0) {
				return errorResult(
					'Pass at least one field to change ("name", "status", "headers", "body" or "contentType").',
					"input"
				);
			}
			return callEngine(
				ctx,
				() => ctx.client.updateRequestExample(requestId, exampleId, payload, signal),
				echoShape(ctx)
			);
		},
	},
	{
		name: "delete_request_example",
		category: "write",
		invalidates: ["request"],
		description:
			"Delete one saved example from a request. " +
			GUARDED_WRITE_SENTENCE +
			", and confirmation: if the client supports elicitation the user is prompted with the example's name and what a mock server loses; otherwise call once for a preview, then again with `confirmed: true`. There is no undo, and a mock server for this collection stops answering with it once it is restarted.",
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
				return errorResult(
					`No example with id "${exampleId}" on request "${requestId}".`,
					"not_found"
				);
			}
			const subject = describeExample(exampleId, stored);
			const consequence =
				"A mock server for this collection stops answering with it once it is restarted. This cannot be undone.";
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
