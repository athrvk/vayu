/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file webhook-inbox.tools.ts
 * @brief Webhook inboxes: start, list, stop, delete, captures and the canned
 *        response.
 */

import { z } from "zod";
import { runOutputShape, WITHHELD_RUN_OUTPUT_SENTENCE } from "../withhold.js";
import type { McpTool } from "./contract.js";
import {
	callEngine,
	confirmDestructive,
	confirmedInput,
	engineErrorResult,
	errorResult,
	isRecord,
	optionalOffset,
	optionalPageLimit,
	requireStr,
	ToolArgError,
	writesDisabled,
} from "./kit.js";
import { MAX_INLINE_BODY_BYTES } from "./inline-body-bounds.js";
import { describeInbox, pagedRead } from "./run-housekeeping.js";
import {
	boundInboxCaptures,
	DEFAULT_INBOX_CAPTURE_LIMIT,
	inboxResponsePayload,
	inboxStartPayload,
	MAX_INBOX_CAPTURE_LIMIT,
} from "./webhook-inbox.js";
import { GUARDED_WRITE_SENTENCE } from "../remedy.js";

export const WEBHOOK_INBOX_TOOLS: McpTool[] = [
	{
		name: "start_webhook_inbox",
		category: "execute",
		invalidates: ["service"],
		description:
			"Start a local webhook inbox and return its id and URL. It records every request sent to it - method, path, query, headers, body, caller address - so an agent can point a webhook at the URL, trigger it, and then assert on what actually arrived with get_inbox_captures. It needs no allowlist entry: the inbox listens on this machine's loopback interface only, which MCP does not let you change, so it is unreachable from off the machine. Which browser pages may read its answers is separate: by default any page can, without credentials, and allowedOrigins narrows that to the listed origins, with credentials. Give it a canned `response` to make the sender see a specific status, body, headers or delay - the reply every captured request gets, changeable later with update_inbox_response. Stop it with stop_webhook_inbox when you are done (the captures survive a stop), or delete_webhook_inbox to remove it and them.",
		annotations: {
			title: "Start webhook inbox",
			readOnlyHint: false,
			// It binds a loopback listener and records what arrives: it destroys
			// no saved data and reaches nothing off the machine.
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			port: z
				.number()
				.int()
				.min(0)
				.max(65535)
				.optional()
				.describe(
					"Port to listen on, on this machine's loopback interface. Default 0 - the engine picks a free one. The interface itself is not configurable over MCP."
				),
			allowedOrigins: z
				.array(z.string())
				.optional()
				.describe(
					'Browser origins allowed to read the inbox\'s answers, e.g. ["https://app.example.com"]: only those pages get CORS headers, with credentials. Omit or leave empty (the default) for any origin, without credentials. Each is http:// or https:// plus a host and optional port - no path, trailing slash, wildcard or "null" - at most 32 of them. A bad entry is refused by name. Fixed for the inbox\'s life.'
				),
			response: z
				.object({
					status: z
						.number()
						.int()
						.min(100)
						.max(599)
						.optional()
						.describe("Status code the inbox answers with (default 200)."),
					body: z.string().optional().describe("Response body the inbox answers with."),
					headers: z
						.record(z.string(), z.string())
						.optional()
						.describe(
							'Response headers, e.g. {"Content-Type": "application/json"}. Replaces the current set rather than merging into it.'
						),
					delayMs: z
						.number()
						.int()
						.nonnegative()
						.optional()
						.describe(
							"Milliseconds to wait before answering, for testing a sender's timeout handling. The engine caps this at 30000."
						),
				})
				.optional()
				.describe(
					"The canned reply every request to this inbox receives. Omit for the engine's default (200, empty body)."
				),
		},
		handler: (args, ctx, signal) =>
			callEngine(ctx, () => ctx.client.startInbox(inboxStartPayload(args), signal)),
	},
	{
		name: "list_webhook_inboxes",
		category: "read",
		invalidates: [],
		description:
			"List the webhook inboxes this engine has started, running and stopped alike, each with its id, URL, port, whether it is still listening, how many requests it has captured, its allowedOrigins, and its canned response. A stopped inbox stays listed with its captures readable until it is deleted, so this is also how to find an inbox started earlier in the session.",
		annotations: {
			title: "List webhook inboxes",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		handler: (_args, ctx, signal) => callEngine(ctx, () => ctx.client.listInboxes(signal)),
	},
	{
		name: "stop_webhook_inbox",
		category: "execute",
		invalidates: ["service"],
		description:
			"Stop a webhook inbox's listener and free its port. This is NOT a delete: the inbox stays listed and everything it captured stays readable with get_inbox_captures - use delete_webhook_inbox to remove the record and its captures. Requests sent to the URL after this are refused by the machine, not recorded. An unknown id is an error, not a silent success.",
		annotations: {
			title: "Stop webhook inbox",
			readOnlyHint: false,
			// Nothing recorded is lost - the captures outlive the listener.
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			inboxId: z.string().describe("Inbox ID to stop (from start_webhook_inbox)."),
		},
		handler: (args, ctx, signal) =>
			callEngine(ctx, () => ctx.client.stopInbox(requireStr(args, "inboxId"), signal)),
	},
	{
		name: "delete_webhook_inbox",
		category: "write",
		invalidates: ["service"],
		description:
			"Delete a webhook inbox: stop its listener if it is still running, drop the record, and destroy every request it captured. " +
			GUARDED_WRITE_SENTENCE +
			", and confirmation - if the client supports elicitation the user is prompted with how many captures go with it, otherwise call once for a preview and again with `confirmed: true`. There is no undo, and the captures are the part that cannot be recreated. To keep them, use stop_webhook_inbox instead.",
		annotations: {
			title: "Delete webhook inbox",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			inboxId: z.string().describe("Inbox ID to delete."),
			confirmed: confirmedInput("actually delete the inbox and its captures"),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const inboxId = requireStr(args, "inboxId");
			// Read the list first so the prompt states the real capture count and
			// the URL, not an id - the same read-before-prompt `delete_collection`
			// and `delete_run` do. `GET /inbox` is the only read that answers for
			// a single inbox: the engine has no `GET /inbox/:id`.
			let inbox: Record<string, unknown>;
			try {
				const listed = await ctx.client.listInboxes(signal);
				const rows = isRecord(listed) && Array.isArray(listed.data) ? listed.data : [];
				const found = rows.find((row) => isRecord(row) && row.inboxId === inboxId);
				if (!isRecord(found)) return errorResult(`No webhook inbox with id "${inboxId}".`);
				inbox = found;
			} catch (err) {
				return engineErrorResult(err, ctx);
			}
			const subject = describeInbox(inboxId, inbox);
			const unconfirmed = await confirmDestructive(args, ctx, {
				message: `Delete ${subject}?\n\nEverything it captured is destroyed with it. This cannot be undone.`,
				acceptTitle: "Delete the inbox",
				acceptDescription: "Confirm to delete this inbox and every request it captured.",
				declined: "Inbox not deleted - the user declined.",
				preview:
					"AWAITING CONFIRMATION - nothing was deleted.\n\n" +
					`This would delete ${subject}, along with every request it captured. This cannot be undone; stop_webhook_inbox frees the port and keeps them.\n\n` +
					"This is a preview. To delete it, call delete_webhook_inbox again with confirmed: true and the same arguments.",
			});
			if (unconfirmed) return unconfirmed;
			return callEngine(ctx, () => ctx.client.deleteInbox(inboxId, signal));
		},
	},
	{
		name: "get_inbox_captures",
		category: "read",
		invalidates: [],
		description:
			"Read what a webhook inbox recorded, newest first. Each row is the whole captured request - method, path, query string, headers, body and the caller's address - so this is the assertion half of a webhook test: start an inbox, trigger the sender, read the captures. An inbox that has received nothing returns an empty page, not an error. " +
			`A body the engine cut at its capture cap carries \`bodyTruncated\` beside \`bodyBytes\`, the true original size. BOUNDED: ${DEFAULT_INBOX_CAPTURE_LIMIT} captures per call by default, ${MAX_INBOX_CAPTURE_LIMIT} at most - a larger \`limit\` is refused, not clamped - and each body is cut to ${MAX_INLINE_BODY_BYTES / 1024} KB for this result. \`pagination\` says how many exist; read the rest with \`offset\`. There is no live stream over MCP: poll this after triggering the sender. ` +
			WITHHELD_RUN_OUTPUT_SENTENCE,
		annotations: {
			title: "Get inbox captures",
			readOnlyHint: true,
			// The newest-first page moves as captures arrive, exactly as
			// `get_live_metrics` does - the same reason that one is not idempotent.
			idempotentHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			inboxId: z.string().describe("Inbox ID whose captures to read."),
			limit: z
				.number()
				.int()
				.positive()
				.max(MAX_INBOX_CAPTURE_LIMIT)
				.optional()
				.describe(
					`How many captures to return (default ${DEFAULT_INBOX_CAPTURE_LIMIT}, max ${MAX_INBOX_CAPTURE_LIMIT}).`
				),
			offset: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe("How many captures to skip, for paging (default 0)."),
		},
		handler: async (args, ctx, signal) => {
			const inboxId = requireStr(args, "inboxId");
			const limit = optionalPageLimit(
				args,
				"limit",
				DEFAULT_INBOX_CAPTURE_LIMIT,
				MAX_INBOX_CAPTURE_LIMIT
			);
			const offset = optionalOffset(args, "offset");
			const withhold = await runOutputShape(ctx, signal);
			return pagedRead(
				ctx,
				() => ctx.client.getInboxCaptures(inboxId, limit, offset, signal),
				"captures",
				(page) => boundInboxCaptures(withhold(page))
			);
		},
	},
	{
		name: "clear_inbox_captures",
		category: "write",
		invalidates: ["service"],
		description:
			"Delete every request a webhook inbox has captured, keeping the listener running on the same URL. Use it to start a fresh assertion window between triggers. " +
			GUARDED_WRITE_SENTENCE +
			"; unlike delete_webhook_inbox it needs no confirmation, because the inbox survives and the next trigger records again. The captures themselves do not come back.",
		annotations: {
			title: "Clear inbox captures",
			readOnlyHint: false,
			// It destroys recorded data, which is what this hint is for - the
			// listener surviving does not make the captures recoverable.
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			inboxId: z.string().describe("Inbox ID whose captures to clear."),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const inboxId = requireStr(args, "inboxId");
			return callEngine(ctx, () => ctx.client.clearInboxCaptures(inboxId, signal));
		},
	},
	{
		name: "update_inbox_response",
		category: "execute",
		invalidates: ["service"],
		description:
			"Change what a running webhook inbox answers, live: status, body, headers or delay. The next request to arrive gets the new reply - nothing restarts and no captures are lost - so one inbox can answer 200 for the first trigger and 500 for the next, which is how a sender's retry or error handling gets exercised. This is a merge-patch: fields you omit keep their current value, and `headers` replaces the whole header set rather than merging into it.",
		annotations: {
			title: "Update inbox response",
			readOnlyHint: false,
			// It rewrites the canned reply of a listener and destroys nothing;
			// calling it again with the same block is a no-op.
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			inboxId: z.string().describe("Inbox ID whose canned response to change."),
			status: z
				.number()
				.int()
				.min(100)
				.max(599)
				.optional()
				.describe("New status code. Omit to leave it unchanged."),
			body: z.string().optional().describe("New response body. Omit to leave it unchanged."),
			headers: z
				.record(z.string(), z.string())
				.optional()
				.describe(
					"New response header set, replacing the current one entirely. Omit to leave it unchanged."
				),
			delayMs: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe(
					"New delay before answering, in milliseconds (engine cap 30000). Omit to leave it unchanged."
				),
		},
		handler: (args, ctx, signal) => {
			const inboxId = requireStr(args, "inboxId");
			const response = inboxResponsePayload(args);
			if (Object.keys(response).length === 0) {
				// An empty merge-patch is accepted by the engine and changes
				// nothing, which would report success for a call that did not do
				// what it was asked. Say which fields exist instead.
				throw new ToolArgError(
					'Name at least one of "status", "body", "headers" or "delayMs" to change.'
				);
			}
			return callEngine(ctx, () => ctx.client.updateInboxResponse(inboxId, response, signal));
		},
	},
];
