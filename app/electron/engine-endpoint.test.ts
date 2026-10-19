/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The session's engine port (#2118): one value, fixed once, and only ever one
 * the CSP and the Origin bridge were built to let the renderer reach.
 *
 * The module holds the port as state, so each case imports a fresh copy.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ENGINE_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import { ENGINE_PORT, ENGINE_PORT_CANDIDATES, MCP_PORT } from "./constants.js";

async function freshEndpoint() {
	vi.resetModules();
	return import("./engine-endpoint.js");
}

describe("the candidate ports", () => {
	it("start at the default and stay clear of the MCP port", () => {
		expect(ENGINE_PORT_CANDIDATES[0]).toBe(ENGINE_PORT);
		expect(ENGINE_PORT_CANDIDATES.length).toBeGreaterThan(1);
		expect(ENGINE_PORT_CANDIDATES).not.toContain(MCP_PORT);
		expect(new Set(ENGINE_PORT_CANDIDATES).size).toBe(ENGINE_PORT_CANDIDATES.length);
	});
});

describe("the MCP port", () => {
	it("is the number the engine refuses to send a request to (#2355)", () => {
		// The engine's loopback guard keeps its own copy of `MCP_PORT`; nothing but
		// this test connects it to the server's, so a move of either side alone
		// would leave the engine dialling the MCP server.
		const [constantsHpp] = ENGINE_READING_GUARDS.mcpPort.paths.map(fromRepoRoot);
		const header = readFileSync(constantsHpp, "utf8");
		// A source scan reading "" passes, so prove it read something.
		expect(header.length).toBeGreaterThan(0);

		const match = header.match(/constexpr\s+int\s+MCP_PORT\s*=\s*(\d+);/);
		expect(match, "MCP_PORT not found in constants.hpp").not.toBeNull();
		expect(Number(match![1])).toBe(MCP_PORT);
	});
});

describe("engineOrigin", () => {
	it("is the default port's origin until the sidecar fixes one", async () => {
		const endpoint = await freshEndpoint();
		expect(endpoint.enginePort()).toBe(ENGINE_PORT);
		expect(endpoint.engineOrigin()).toBe(`http://127.0.0.1:${ENGINE_PORT}`);
	});

	it("follows the fixed port, and the fixed signal settles", async () => {
		const endpoint = await freshEndpoint();
		const fallback = ENGINE_PORT_CANDIDATES[1];

		endpoint.fixEnginePort(fallback);

		await expect(endpoint.enginePortFixed()).resolves.toBeUndefined();
		expect(endpoint.enginePort()).toBe(fallback);
		expect(endpoint.engineOrigin()).toBe(`http://127.0.0.1:${fallback}`);
	});

	it("refuses a port outside the candidates, which the renderer could not reach", async () => {
		const endpoint = await freshEndpoint();
		expect(() => endpoint.fixEnginePort(MCP_PORT)).toThrow(/not one of the candidates/);
		expect(endpoint.enginePort()).toBe(ENGINE_PORT);
	});

	it("refuses to move once fixed, and accepts the same port again", async () => {
		const endpoint = await freshEndpoint();
		const fallback = ENGINE_PORT_CANDIDATES[1];
		endpoint.fixEnginePort(fallback);

		expect(() => endpoint.fixEnginePort(fallback)).not.toThrow();
		expect(() => endpoint.fixEnginePort(ENGINE_PORT)).toThrow(/already fixed/);
		expect(endpoint.enginePort()).toBe(fallback);
	});
});
