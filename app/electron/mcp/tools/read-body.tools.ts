/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file read-body.tools.ts
 * @brief `read_body` (#3704): a stored body past the inline cap, a page at a
 *        time.
 */

import { z } from "zod";
import { withheldPointer } from "../withhold.js";
import type { McpTool } from "./contract.js";
import { callEngineForRunOutput, engineErrorResult, ToolArgError } from "./kit.js";
import { ID_KINDS } from "./failure.js";
import { MAX_INLINE_BODY_BYTES } from "./inline-body-bounds.js";
import { bodyPageSchema } from "./output-schemas.js";
import {
	BODY_PARTS,
	bodyNodeOf,
	fetchBodyRecord,
	FIND_CONTEXT_BYTES,
	MAX_FIND_CHARS,
	MAX_FIND_MATCHES,
	readBodyPage,
	readBodySource,
	readBodyView,
} from "./read-body.js";

const ID_NUMBER = z.number().int().nonnegative();

export const READ_BODY_TOOLS: McpTool[] = [
	{
		name: "read_body",
		category: "read",
		invalidates: [],
		notFound: [
			{ ...ID_KINDS.run, idArg: "runId" },
			{ ...ID_KINDS.result, idArg: "resultId" },
			{ ...ID_KINDS.inbox, idArg: "inboxId" },
			{ ...ID_KINDS.request, idArg: "requestId" },
		],
		description: (config) =>
			`Page through a stored body past the ${MAX_INLINE_BODY_BYTES} bytes run_request, get_run_report, get_inbox_captures and list_request_examples carry inline. Name one: a run result (\`runId\`, \`resultId\`: run_request's answer or a report row's \`id\`; \`part\` "response" (default) or "request"; \`scriptRequest\` N for the trace's Nth pm.sendRequest record), an inbox capture (\`inboxId\`, \`captureId\`) or a saved example (\`requestId\`, \`exampleId\`). ` +
			`Answers \`text\` from \`offset\` to \`nextOffset\` of \`totalBytes\`: read on from \`nextOffset\` until \`done\`, up to \`length\` bytes a page. Offsets count bytes; a text page never splits a character, so \`offset\` may step back. With \`encoding: "base64"\` offsets count decoded bytes and \`text\` is the page as base64, whole 3-byte groups but the last, so pages concatenate. ` +
			`\`find\` lists the first ${MAX_FIND_MATCHES} matches at or after \`offset\` (each \`offset\`, and \`context\` ${FIND_CONTEXT_BYTES} bytes either side from \`contextOffset\`) and \`matchCount\` over the body. \`pointer\` (RFC 6901) reads one subtree of a JSON body instead, re-serialized from the parse: compact, keys sorted, a repeated key's last value, numbers as written. \`storedTruncated\`: Vayu stored only a prefix.` +
			(config.revealSecretsToAgents ? "" : " Offsets and sizes count the body as masked.") +
			withheldPointer(config, "recorded"),
		annotations: {
			title: "Read a stored body",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			runId: z.string().optional().describe("Run of the result, with `resultId`."),
			resultId: ID_NUMBER.optional().describe("The result's id."),
			part: z.enum(BODY_PARTS).optional().describe('"response" (default) or "request".'),
			scriptRequest: ID_NUMBER.optional().describe(
				"Index into the trace's `scripts.scriptRequests`."
			),
			inboxId: z.string().optional().describe("Inbox of the capture, with `captureId`."),
			captureId: ID_NUMBER.optional().describe("A capture's `id` from get_inbox_captures."),
			requestId: z.string().optional().describe("Request of the example, with `exampleId`."),
			exampleId: z
				.string()
				.optional()
				.describe("An example's `id` from list_request_examples."),
			offset: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe("Byte to start at (default 0)."),
			length: z
				.number()
				.int()
				.positive()
				.max(MAX_INLINE_BODY_BYTES)
				.optional()
				.describe(`Bytes to read (default and max ${MAX_INLINE_BODY_BYTES}).`),
			find: z
				.string()
				.min(1)
				.max(MAX_FIND_CHARS)
				.optional()
				.describe("Text to list the matches of, instead of a page."),
			pointer: z
				.string()
				.optional()
				.describe('RFC 6901 pointer, e.g. "/data/0"; "" is the whole body.'),
		},
		outputSchema: bodyPageSchema,
		handler: async (args, ctx, signal) => {
			const source = readBodySource(args);
			const view = readBodyView(args);
			let record: unknown;
			try {
				record = await fetchBodyRecord(source, ctx.client, signal);
			} catch (err) {
				if (err instanceof ToolArgError) throw err;
				return engineErrorResult(err, ctx);
			}
			// The whole record is masked before a page is cut from it, so a secret
			// that straddles a page boundary is masked in both pages rather than
			// leaving each a prefix no secret form matches (#1809).
			return callEngineForRunOutput(ctx, () => Promise.resolve(record), {
				bound: (masked) => readBodyPage(bodyNodeOf(source, masked), view),
				structured: true,
				signal,
			});
		},
	},
];
