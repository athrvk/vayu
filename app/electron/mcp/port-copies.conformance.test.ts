/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Port field in Settings › MCP states the main process's port rules as help
 * text, native bounds and a Reset, and keeps its own copies of them because
 * `app/src` cannot import from `electron/` (#3580). A drift is silent: the
 * field would offer a default or a range the main process then refuses, or
 * name engine ports the sidecar never takes. Lives under `electron/` because
 * only a test here can import both sides.
 *
 * Mutation check: change any constant in `mcp-port-copies.ts`, or either end
 * of the range or the first port in its sentence, and a case here reds.
 */

import { describe, expect, it } from "vitest";
import {
	DEFAULT_MCP_PORT,
	ENGINE_PORTS_HELP,
	MCP_PORT_MAX as RENDERER_MCP_PORT_MAX,
	MCP_PORT_MIN as RENDERER_MCP_PORT_MIN,
} from "@/modules/settings/main/panels/mcp-port-copies";
import { ENGINE_PORT_CANDIDATES, MCP_PORT, MCP_PORT_MAX, MCP_PORT_MIN } from "../constants.js";

describe("the renderer's copies of the MCP port rules", () => {
	it("bound the field by the range the main process accepts", () => {
		expect(RENDERER_MCP_PORT_MIN).toBe(MCP_PORT_MIN);
		expect(RENDERER_MCP_PORT_MAX).toBe(MCP_PORT_MAX);
	});

	it("reset the field to the main process's default", () => {
		expect(DEFAULT_MCP_PORT).toBe(MCP_PORT);
	});

	it("name exactly the ports the engine may take, in the order it tries them", () => {
		const stated = /uses (\d+), or one of (\d+)-(\d+) if that is taken/.exec(ENGINE_PORTS_HELP);
		expect(stated).not.toBeNull();
		const [, first, from, to] = stated ?? [];
		const ports = [Number(first)];
		for (let port = Number(from); port <= Number(to); port++) ports.push(port);

		expect(ports).toEqual([...ENGINE_PORT_CANDIDATES]);
	});
});
