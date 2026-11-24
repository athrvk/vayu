/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Where the request knows better than a kind's blank config (#3806): an `assert.jsonschema` added
 * to an `mcp` request whose stored tool states an `outputSchema` starts as "the tool result's
 * `structuredContent` matches it". `ElementList` writes this into the element when added; the
 * element is stored data, so a later tool edit does not reach it. The path is the JSON-RPC
 * envelope's: the engine hands the assertion the whole body, and an MCP tool result sits under
 * `result`.
 */

import { isPlainObject } from "@/lib/elements";
import type { RequestState } from "../types";

export const MCP_STRUCTURED_CONTENT_PATH = "$.result.structuredContent";

type StartingElementConfigs = Record<string, Record<string, unknown>>;

/**
 * The starting configs for @p request's elements by kind, or `undefined`: any body but `mcp`, or a
 * tool with no `outputSchema`.
 */
export function startingElementConfigs(
	request: Pick<RequestState, "bodyMode" | "mcpTool">
): StartingElementConfigs | undefined {
	const outputSchema = request.mcpTool?.outputSchema;
	if (request.bodyMode !== "mcp" || !isPlainObject(outputSchema)) return undefined;
	return {
		"assert.jsonschema": {
			source: "jsonpath",
			path: MCP_STRUCTURED_CONTENT_PATH,
			schema: outputSchema,
		},
	};
}
