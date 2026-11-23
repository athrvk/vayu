/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The `assert.jsonschema` default an `mcp` request offers (#3806): a tool's
 * `outputSchema` against its result's `structuredContent`.
 */

import { describe, it, expect } from "vitest";
import type { BodyMode, McpTool } from "@/types";
import { MCP_STRUCTURED_CONTENT_PATH, startingElementConfigs } from "./starting-element-configs";

const OUTPUT_SCHEMA = { type: "object", properties: { rows: { type: "array" } } };

function request(bodyMode: BodyMode, mcpTool?: McpTool) {
	return { bodyMode, mcpTool };
}

describe("startingElementConfigs", () => {
	it("starts an assert.jsonschema on the tool's outputSchema, read from the result's structuredContent", () => {
		expect(
			startingElementConfigs(request("mcp", { name: "t", outputSchema: OUTPUT_SCHEMA }))
		).toEqual({
			"assert.jsonschema": {
				source: "jsonpath",
				path: "$.result.structuredContent",
				schema: OUTPUT_SCHEMA,
			},
		});
		expect(MCP_STRUCTURED_CONTENT_PATH).toBe("$.result.structuredContent");
	});

	it.each([
		["a tool that states no outputSchema", request("mcp", { name: "t" })],
		[
			"a tool stating one that is no object",
			request("mcp", { name: "t", outputSchema: [] as never }),
		],
		["no tool", request("mcp")],
		[
			"a body that is not mcp, even holding a tool kept across a mode switch",
			request("json", { name: "t", outputSchema: OUTPUT_SCHEMA }),
		],
	])("offers nothing for %s", (_name, state) => {
		expect(startingElementConfigs(state)).toBeUndefined();
	});
});
