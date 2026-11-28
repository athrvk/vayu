/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @brief The body a write tool stores, from the `body` / `bodyType` / `file` /
 *        `mcpTool` arguments.
 */

import { z } from "zod";
import { BINARY_FILE_ACCESS_TOKEN } from "../remedy.js";
import { asOn } from "./as-on.js";
import { isRecord, str, ToolArgError } from "./kit.js";

/** The body modes whose content is a field list rather than a string. */
const FORM_BODY_MODES = new Set(["form-data", "x-www-form-urlencoded"]);

/**
 * The body an agent described, in the shape the engine reads.
 *
 * Both form modes carry their content as `fields` (the `{key, value, enabled}` rows the request
 * builder and every importer produce), so a `body` string is split on `&` into entries rather than
 * handed over whole: `{ mode, content }` is a shape the engine reads no `fields` from, which was an
 * empty body on the wire before issue #381 and is a refusal now.
 *
 * Every field produced here is a **text** part. A `form-data` file part (issue #393) has no
 * spelling in a `key=value` string, and the tools say so.
 */
export function bodyPayload(bodyType: string, content: string): Record<string, unknown> {
	if (!FORM_BODY_MODES.has(bodyType)) return { mode: bodyType, content };
	const fields = [...new URLSearchParams(content)].map(([key, value]) => ({
		key,
		value,
		enabled: true,
	}));
	return { mode: bodyType, fields };
}

/**
 * The `file` argument of a `binary` body, as the two write tools declare it.
 * No trust member is written: the engine decides from its allowed folders and
 * the files the user picked, which this server can neither read nor add to
 * (#2356). `unresolved` is declared because a read derives it onto every file
 * reference (`derive_file_trust`), so a reference written back as read is not
 * refused (#3556); `shapeBody` never forwards it. With @p statedOn
 * (update_request names create_request), the long descriptions point there.
 */
export function fileRefInput(statedOn?: string) {
	const described = (full: string) => (statedOn ? asOn(statedOn) : full);
	return z
		.strictObject({
			src: z
				.string()
				.describe(
					"Absolute path of the file on the user's machine (may contain {{variables}})."
				),
			contentType: z
				.string()
				.optional()
				.describe(
					described(
						"Content-Type to send it under, when no Content-Type header is set. Omitted, the engine derives one from the file extension, else application/octet-stream."
					)
				),
			fileName: z.string().optional().describe("Display name of the file."),
			unresolved: z.boolean().optional().describe("As a read returns it; ignored."),
		})
		.optional()
		.describe(
			described(
				`The file a \`bodyType: "binary"\` body sends, instead of \`body\`. Stored as a path: the engine sends it only once ${BINARY_FILE_ACCESS_TOKEN}. Nothing an agent sends can choose a file for the user.`
			)
		);
}

/**
 * The `mcpTool` argument of an `mcp` body, as the two write tools declare it.
 * Loose, because the engine is the one judge of a tool (`read_mcp_tool`
 * answers a malformed one with a 400) and a tool written back as read may
 * carry members this server does not name (`outputSchema`); `inputSchema` is
 * optional because an import stores a tool without one as `{name}`. With
 * @p statedOn the description points there.
 */
export function mcpToolInput(statedOn?: string) {
	return z
		.looseObject({
			name: z.string(),
			inputSchema: z.record(z.string(), z.unknown()).optional(),
		})
		.optional()
		.describe(
			statedOn
				? asOn(statedOn, "left out of an mcp `body`, the stored tool is kept.")
				: 'The tool an mcp `body` calls, `{name, inputSchema}` as its server lists it, stored inside the body: each `inputSchema` property carrying `x-mcp-header` is sent as an Mcp-Param-* header while `params.name` names this tool. Needs bodyType "mcp" and `body`.'
		);
}

/**
 * `file` on the tools that send an ad-hoc request. Declared only so that it
 * reaches the handler and is refused there with {@link INLINE_FILE_REFUSAL},
 * which names the route that does send a file.
 */
export const inlineFileInput = z
	.unknown()
	.optional()
	.describe(
		"Not accepted here: a body that sends a file is refused on an ad-hoc request. Save it with create_request and run the saved request by id."
	);

/**
 * Why a file body cannot be sent inline, and what to do instead. Shared by
 * every tool that sends an ad-hoc request, so the advice cannot drift.
 */
export const INLINE_FILE_REFUSAL = `A request body that sends a file cannot be given inline. Save the request (create_request with bodyType "binary" and \`file\`) and run the saved request by id - run_request with \`requestId\` and no \`url\`, start_load_run with \`requestId\`, or run_collection / run_collection_smoke over its collection. The engine sends a file only once ${BINARY_FILE_ACCESS_TOKEN}.`;

/**
 * The body a write tool stores, from the `body` / `bodyType` / `file` /
 * `mcpTool` arguments, or undefined when the caller named none of them.
 *
 * A file reference carries `src`, `fileName` and `contentType` and nothing
 * else the agent wrote: an agent names a path, and only a person's pick in the
 * app (or an allowed folder) makes the engine read it. An `mcpTool` is
 * forwarded as written, inside the body object where the engine keeps it.
 */
export function shapeBody(
	args: Record<string, unknown>
): { body: Record<string, unknown>; bodyType: string } | undefined {
	const content = str(args, "body");
	const file = args.file;
	const named = str(args, "bodyType");
	const tool = args.mcpTool;
	if ([content, file, named, tool].every((arg) => arg === undefined)) return undefined;
	if (tool !== undefined) refuseMisplacedMcpTool(named, content);
	const bodyType = named ?? (file !== undefined ? "binary" : "text");
	let body: Record<string, unknown>;
	if (bodyType === "binary") {
		if (content !== undefined) {
			throw new ToolArgError(
				'A "binary" body is the file named by "file" - pass "file" instead of "body".'
			);
		}
		if (!isRecord(file) || typeof file.src !== "string" || file.src.trim() === "") {
			throw new ToolArgError(
				'bodyType "binary" needs "file": { "src": "<absolute path>" } - the file it sends.'
			);
		}
		const ref: Record<string, unknown> = { src: file.src };
		if (typeof file.fileName === "string" && file.fileName) ref.fileName = file.fileName;
		if (typeof file.contentType === "string" && file.contentType) {
			ref.contentType = file.contentType;
		}
		body = { mode: "binary", file: ref };
	} else {
		if (file !== undefined) {
			throw new ToolArgError(
				`"file" is the file a "binary" body sends - it does not apply to bodyType "${bodyType}".`
			);
		}
		if (content === undefined) {
			throw new ToolArgError(
				'"bodyType" describes "body" - pass the body it applies to, or leave both out.'
			);
		}
		body = bodyPayload(bodyType, content);
		if (tool !== undefined) body.mcpTool = tool;
	}
	return { body, bodyType };
}

/** Refuse an `mcpTool` that is not stated beside the `mcp` body it is stored in. */
function refuseMisplacedMcpTool(named: string | undefined, content: string | undefined): void {
	if (named !== "mcp") {
		const instead = named === undefined ? "" : `, not "${named}"`;
		throw new ToolArgError(
			`"mcpTool" is the tool an "mcp" body calls - pass it with bodyType "mcp"${instead}.`
		);
	}
	if (content === undefined) {
		throw new ToolArgError(
			'"mcpTool" is stored inside the "mcp" body - pass the "body" it belongs to in the same call.'
		);
	}
}
