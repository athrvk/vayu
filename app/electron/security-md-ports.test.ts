/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The renderer's connect-src names the engine on a fixed list of ports, and
 * SECURITY.md states that list in words (#2381). The document is the copy and
 * `ENGINE_PORT_CANDIDATES` the source. This lives under `electron/` because
 * `src/` may not import from it, so `src/security-md.test.ts` cannot hold it.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROOT_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import { ENGINE_PORT_CANDIDATES } from "./constants.js";

const MCP_PORT = 9877;
const [SECURITY_PATH] = ROOT_READING_GUARDS.securityPolicyPorts.paths;
const doc = readFileSync(fromRepoRoot(SECURITY_PATH), "utf8").replace(/\s+/g, " ");

describe("SECURITY.md's engine ports", () => {
	const stated = /\(9876, or (\d+)-(\d+) if 9876 is taken\)/.exec(doc);

	it("states the list as a first port and a fallback range", () => {
		expect(stated).not.toBeNull();
	});

	it("names exactly the ports the renderer may connect to", () => {
		// Mutation check: change either end of the range in SECURITY.md.
		const [, from, to] = stated ?? [];
		const ports = [9876];
		for (let port = Number(from); port <= Number(to); port++) ports.push(port);

		expect(ports).toHaveLength(11);
		expect(ports).toEqual([...ENGINE_PORT_CANDIDATES]);
		expect(ports).not.toContain(MCP_PORT);
	});
});
