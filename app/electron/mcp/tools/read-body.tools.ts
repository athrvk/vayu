/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @brief `read_body` (#3704): a stored body past the inline cap, a page at a
 *        time; `diff_bodies` (#3705): the bounded difference between two.
 */

import { z } from "zod";
import { withheldPointer } from "../withhold.js";
import type { McpTool, ToolContext, ToolResult } from "./contract.js";
import { MAX_DIFF_VALUE_BYTES, diffBodies } from "./diff-bodies.js";
import {
	callEngineForRunOutput,
	engineErrorResult,
	engineFailure,
	failureResult,
	isRecord,
	ToolArgError,
} from "./kit.js";
import { describeFailure } from "./failure.js";
import { MAX_INLINE_BODY_BYTES } from "./inline-body-bounds.js";
import { bodyDiffSchema, bodyPageSchema } from "./output-schemas.js";
import {
	BODY_PARTS,
	BODY_SOURCE_NOT_FOUND,
	bodyNodeOf,
	fetchBodyRecord,
	FIND_CONTEXT_BYTES,
	MAX_FIND_CHARS,
	MAX_FIND_MATCHES,
	readBodyPage,
	readBodySource,
	readBodyView,
	type BodySource,
} from "./read-body.js";

const ID_NUMBER = z.number().int().nonnegative();

/**
 * The arguments that name one stored body. `diff_bodies` takes them bare on
 * each side, since its description points at `read_body`'s, which carry the
 * per-argument words once.
 */
const BODY_SOURCE_SHAPE = {
	runId: z.string().optional(),
	resultId: ID_NUMBER.optional(),
	part: z.enum(BODY_PARTS).optional(),
	scriptRequest: ID_NUMBER.optional(),
	inboxId: z.string().optional(),
	captureId: ID_NUMBER.optional(),
	requestId: z.string().optional(),
	exampleId: z.string().optional(),
};

const BODY_SOURCE_INPUT = {
	runId: BODY_SOURCE_SHAPE.runId.describe("Run of the result, with `resultId`."),
	resultId: BODY_SOURCE_SHAPE.resultId.describe("The result's id."),
	part: BODY_SOURCE_SHAPE.part.describe('"response" (default) or "request".'),
	scriptRequest: BODY_SOURCE_SHAPE.scriptRequest.describe(
		"Index into the trace's `scripts.scriptRequests`."
	),
	inboxId: BODY_SOURCE_SHAPE.inboxId.describe("Inbox of the capture, with `captureId`."),
	captureId: BODY_SOURCE_SHAPE.captureId.describe("A capture's `id` from get_inbox_captures."),
	requestId: BODY_SOURCE_SHAPE.requestId.describe("Request of the example, with `exampleId`."),
	exampleId: BODY_SOURCE_SHAPE.exampleId.describe(
		"An example's `id` from list_request_examples."
	),
};

const SIDES = ["a", "b"] as const;
type Side = (typeof SIDES)[number];

/** @p err, led by the side it is about. */
function sideRefusal(side: Side, err: ToolArgError): ToolArgError {
	return new ToolArgError(`Body "${side}": ${err.message}`, err.failureClass);
}

/** @p read, with an argument refusal of its own naming the side it is about. */
function onSide<T>(side: Side, read: () => T): T {
	try {
		return read();
	} catch (err) {
		throw err instanceof ToolArgError ? sideRefusal(side, err) : err;
	}
}

function sideArgs(args: Record<string, unknown>, side: Side): Record<string, unknown> {
	const named = args[side];
	if (isRecord(named)) return named;
	throw new ToolArgError(
		`"${side}" must be an object naming one body, as read_body's arguments do.`
	);
}

/**
 * The engine's refusal of one side's fetch, worded as `read_body` words it and
 * led by the side. An interrupted call is about the engine, not a side, so it
 * is answered as it came.
 */
function sideEngineFailure(
	side: Side,
	err: unknown,
	args: Record<string, unknown>,
	ctx: ToolContext
): ToolResult {
	const failure = engineFailure(err, ctx);
	if (failure.interrupted) return failureResult(failure);
	const { text } = describeFailure(failure, { notFound: BODY_SOURCE_NOT_FOUND, args });
	return failureResult({
		failureClass: failure.failureClass,
		message: `Body "${side}": ${text}`,
		...(failure.engineText ? { engineText: true } : {}),
	});
}

export const READ_BODY_TOOLS: McpTool[] = [
	{
		name: "read_body",
		category: "read",
		invalidates: [],
		notFound: BODY_SOURCE_NOT_FOUND,
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
			...BODY_SOURCE_INPUT,
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
	{
		name: "diff_bodies",
		category: "read",
		invalidates: [],
		description: (config) =>
			`Compare two stored bodies without reading either whole, e.g. one request's prod and staging responses: \`a\` and \`b\` each name a body with read_body's arguments (\`runId\` + \`resultId\`, \`part\`, \`scriptRequest\`; \`inboxId\` + \`captureId\`; or \`requestId\` + \`exampleId\`). ` +
			`Two JSON bodies are compared on the parse, not the wire bytes: keys sorted, a repeated key's last value, arrays by index, numbers by their text (1.0 and 1 differ). Each difference is \`op\` "changed", "added" or "removed" at an RFC 6901 \`pointer\`, with \`old\` (a's) and \`new\` (b's) as compact JSON cut to ${MAX_DIFF_VALUE_BYTES} bytes (\`truncated\`). ` +
			`Other text gets a line diff: a's "removed" and b's "added" lines, each with its 1-based \`line\` (\`coarse\`: the changed region was too large to align, so it is listed whole). A base64 body is binary and is not diffed: \`equal\` and each side's \`totalBytes\` only. ` +
			`One answer is at most ${MAX_INLINE_BODY_BYTES} bytes: \`differenceCount\` counts every difference and \`omitted\` the ones not listed, 0 for a complete diff. \`storedTruncated\` on a side: Vayu stored only a prefix, so prefixes were compared.` +
			(config.revealSecretsToAgents
				? ""
				: " Both bodies are masked before the diff, so a secret that differs reads <redacted> on both sides and is no difference.") +
			withheldPointer(config, "recorded"),
		annotations: {
			title: "Compare two stored bodies",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			a: z
				.strictObject(BODY_SOURCE_SHAPE)
				.describe("The first body, named as read_body names one."),
			b: z.strictObject(BODY_SOURCE_SHAPE).describe("The second body, named the same way."),
		},
		outputSchema: bodyDiffSchema,
		handler: async (args, ctx, signal) => {
			const named = { a: sideArgs(args, "a"), b: sideArgs(args, "b") };
			const sources: Record<Side, BodySource> = {
				a: onSide("a", () => readBodySource(named.a)),
				b: onSide("b", () => readBodySource(named.b)),
			};
			const fetched = await Promise.allSettled(
				SIDES.map((side) => fetchBodyRecord(sources[side], ctx.client, signal))
			);
			for (const [at, side] of SIDES.entries()) {
				const outcome = fetched[at];
				if (outcome.status === "fulfilled") continue;
				const err: unknown = outcome.reason;
				if (err instanceof ToolArgError) throw sideRefusal(side, err);
				return sideEngineFailure(side, err, named[side], ctx);
			}
			const records = fetched.map((outcome) =>
				outcome.status === "fulfilled" ? outcome.value : undefined
			);
			// Both records are masked in one pass before either is diffed, so a
			// secret that differs between them is `<redacted>` on both sides
			// rather than the difference the answer reports.
			return callEngineForRunOutput(
				ctx,
				() => Promise.resolve({ a: records[0], b: records[1] }),
				{
					bound: (masked) => {
						const both = isRecord(masked) ? masked : {};
						return diffBodies(
							onSide("a", () => bodyNodeOf(sources.a, both.a)),
							onSide("b", () => bodyNodeOf(sources.b, both.b))
						);
					},
					structured: true,
					signal,
				}
			);
		},
	},
];
