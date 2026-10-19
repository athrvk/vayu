/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file request-body.ts
 * @brief The body a write tool stores, from the `body` / `bodyType` / `file`
 *        arguments.
 */

import { z } from "zod";
import { BINARY_FILE_ACCESS_TOKEN } from "../remedy.js";
import { isRecord, str, ToolArgError } from "./kit.js";

/** The body modes whose content is a field list rather than a string. */
const FORM_BODY_MODES = new Set(["form-data", "x-www-form-urlencoded"]);

/**
 * The body an agent described, in the shape the engine reads.
 *
 * Both form modes carry their content as `fields` - the same
 * `{key, value, enabled}` rows the request builder and every importer produce
 * - so a `body` string is split on `&` into entries rather than handed over
 * whole. These two tools have advertised both modes all along while emitting
 * `{ mode, content }`, which the engine reads no `fields` from: before issue
 * #381 that meant an empty body on the wire, and now it is a refusal. Either
 * way the mode was documented and unusable; splitting here makes the schema's
 * promise true.
 *
 * Every field produced here is a **text** part. A `form-data` file part
 * (issue #393) has no spelling in a `key=value` string, and the tools say so.
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
 * No trust member: the engine decides from its allowed folders and the files
 * the user picked, which this server can neither read nor add to (#2356).
 */
export const fileRefInput = z
	.object({
		src: z
			.string()
			.describe(
				"Absolute path of the file on the user's machine (may contain {{variables}})."
			),
		contentType: z
			.string()
			.optional()
			.describe(
				"Content-Type to send it under, when no Content-Type header is set. Omitted, the engine derives one from the file extension, else application/octet-stream."
			),
		fileName: z.string().optional().describe("Display name of the file."),
	})
	.optional()
	.describe(
		`The file a \`bodyType: "binary"\` body sends, instead of \`body\`. Stored as a path: the engine sends it only once ${BINARY_FILE_ACCESS_TOKEN}. Nothing an agent sends can choose a file for the user.`
	);

/**
 * `file` on the tools that send an ad-hoc request. Declared only so that it
 * reaches the handler and is refused there: the SDK strips an undeclared key,
 * and a stripped `file` would send the request with no body at all.
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
 * The body a write tool stores, from the `body` / `bodyType` / `file`
 * arguments, or undefined when the caller named none of them.
 *
 * A file reference carries `src`, `fileName` and `contentType` and nothing
 * else the agent wrote: an agent names a path, and only a person's pick in the
 * app (or an allowed folder) makes the engine read it.
 */
export function shapeBody(
	args: Record<string, unknown>
): { body: Record<string, unknown>; bodyType: string } | undefined {
	const content = str(args, "body");
	const file = args.file;
	const named = str(args, "bodyType");
	if (content === undefined && file === undefined && named === undefined) return undefined;
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
	}
	return { body, bodyType };
}
