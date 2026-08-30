/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The barrel `main.ts` loads on demand still answers with what it takes from it.
 *
 * `main.ts` no longer imports `mcp/index.js` statically (#1145): `startMcp()`
 * destructures `VayuMcpService` from it, and the `mcp:getTools` and
 * `mcp:updateSafety` handlers call its `toolCatalog()`, all through one cached
 * `await import("./mcp/index.js")`. Nothing type-checks that seam - a dynamic
 * import resolves at runtime, and `main.ts` cannot be imported to exercise it -
 * so a symbol dropped from the barrel's export surface, or a barrel that fails
 * to load at all, would type-check, ship, and fail in a user's Settings panel.
 *
 * These drive the same specifier the same way and assert the answer. The
 * catalog is asserted non-empty rather than merely defined, so a registry that
 * evaluated to nothing fails here instead of rendering an empty tool list.
 *
 * `electron` is faked for the reason store.test.ts fakes it: the barrel
 * re-exports the store, which builds an `electron-store` over `app.getPath`.
 */

import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fake = vi.hoisted(() => ({ userData: "" }));

vi.mock("electron", () => {
	const api = {
		app: {
			getPath: () => fake.userData,
			getVersion: () => "0.0.0-test",
		},
		ipcMain: { on: () => {} },
		shell: { openPath: async () => "" },
	};
	// electron-store reaches for the default export.
	return { ...api, default: api };
});

fake.userData = mkdtempSync(join(tmpdir(), "vayu-mcp-lazy-"));

afterAll(() => {
	rmSync(fake.userData, { recursive: true, force: true });
});

describe("the on-demand MCP barrel", () => {
	it("resolves through the specifier main.ts uses", async () => {
		const mcp = await import("./index.js");
		expect(mcp).toBeDefined();
	});

	it("serves the service startMcp constructs", async () => {
		const { VayuMcpService } = await import("./index.js");
		expect(typeof VayuMcpService).toBe("function");
	});

	it("serves a populated catalog to the tool-list handlers", async () => {
		const { toolCatalog } = await import("./index.js");
		const tools = toolCatalog();

		expect(tools.length).toBeGreaterThan(0);
		for (const tool of tools) {
			expect(tool.name).toBeTruthy();
			expect(tool.description).toBeTruthy();
			expect(tool.category).toBeTruthy();
		}
	});

	/*
	 * `mcp:updateSafety` filters a persisted disabled list against this, so a
	 * catalog of unnamed tools would silently empty the user's selection rather
	 * than fail. Names are what that branch matches on.
	 */
	it("names every tool uniquely, which is what updateSafety filters on", async () => {
		const { toolCatalog } = await import("./index.js");
		const names = toolCatalog().map((tool) => tool.name);

		expect(new Set(names).size).toBe(names.length);
	});
});
