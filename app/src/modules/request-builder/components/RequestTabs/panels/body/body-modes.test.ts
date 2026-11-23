/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { BODY_MODES } from "./body-modes";
import { requiredContentType } from "./content-type";

describe("BODY_MODES", () => {
	it("offers MCP after JSON-RPC, as the JSON the engine sends", () => {
		const values = BODY_MODES.map((mode) => mode.value);

		expect(BODY_MODES.find((mode) => mode.value === "mcp")).toEqual({
			value: "mcp",
			label: "MCP",
			contentType: "application/json",
		});
		expect(values.indexOf("mcp")).toBe(values.indexOf("jsonrpc") + 1);
	});

	it("lists no mode twice", () => {
		const values = BODY_MODES.map((mode) => mode.value);
		expect(new Set(values).size).toBe(values.length);
	});

	// The engine derives an mcp body's Content-Type with every other MCP header
	// (#3762), so the panel writes no row for it, unlike the other JSON modes.
	it("writes no Content-Type row for mcp, while it still does for jsonrpc", () => {
		expect(requiredContentType("mcp")).toBeNull();
		expect(requiredContentType("jsonrpc")).toBe("application/json");
	});
});
