/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The one-time cache clear (issue #1507) must run exactly once per version:
 * an upgraded install has Chromium's disk cache emptied on first launch of the
 * fixed version, and never again on every subsequent launch of the same one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as ResponseCacheClear from "./response-cache-clear.js";

/** Mutable because the mock is hoisted above every test that retargets it. */
const fake = vi.hoisted(() => ({ userData: "" }));

vi.mock("electron", () => {
	const api = {
		app: { getPath: () => fake.userData, getVersion: () => "0.0.0-test" },
		ipcMain: { on: () => {} },
	};
	// electron-store reaches for the default export.
	return { ...api, default: api };
});

/**
 * A fresh module instance per test, imported only after `fake.userData` is
 * seeded to a real directory - the module-scope `new Store(...)` reads it
 * (and writes a default config into it) at import time, the same reason
 * `window-state.test.ts` imports this way rather than once, statically.
 */
async function importModule(): Promise<typeof ResponseCacheClear> {
	vi.resetModules();
	return import("./response-cache-clear.js");
}

beforeEach(() => {
	fake.userData = mkdtempSync(join(tmpdir(), "vayu-cache-clear-"));
});

afterEach(() => {
	rmSync(fake.userData, { recursive: true, force: true });
});

describe("needsCacheClear", () => {
	it("is needed when nothing has been recorded yet", async () => {
		const { needsCacheClear } = await importModule();
		expect(needsCacheClear(undefined, "1.0.0")).toBe(true);
	});

	it("is needed after an upgrade", async () => {
		const { needsCacheClear } = await importModule();
		expect(needsCacheClear("1.0.0", "1.1.0")).toBe(true);
	});

	it("is not needed once the current version is recorded", async () => {
		const { needsCacheClear } = await importModule();
		expect(needsCacheClear("1.1.0", "1.1.0")).toBe(false);
	});
});

describe("clearResponseCacheOnUpgrade", () => {
	it("clears and records on the first launch of a version", async () => {
		const { clearResponseCacheOnUpgrade } = await importModule();
		const clearCache = vi.fn().mockResolvedValue(undefined);

		await expect(clearResponseCacheOnUpgrade({ clearCache }, "1.0.0")).resolves.toBe(true);
		expect(clearCache).toHaveBeenCalledTimes(1);
	});

	it("does not clear again on a second launch of the same version", async () => {
		const { clearResponseCacheOnUpgrade } = await importModule();
		const clearCache = vi.fn().mockResolvedValue(undefined);

		await clearResponseCacheOnUpgrade({ clearCache }, "1.0.0");
		await expect(clearResponseCacheOnUpgrade({ clearCache }, "1.0.0")).resolves.toBe(false);
		expect(clearCache).toHaveBeenCalledTimes(1);
	});

	it("clears again after an upgrade", async () => {
		const { clearResponseCacheOnUpgrade } = await importModule();
		const clearCache = vi.fn().mockResolvedValue(undefined);

		await clearResponseCacheOnUpgrade({ clearCache }, "1.0.0");
		await expect(clearResponseCacheOnUpgrade({ clearCache }, "1.1.0")).resolves.toBe(true);
		expect(clearCache).toHaveBeenCalledTimes(2);
	});

	// Mutation check: a version left unrecorded on failure means the next
	// launch retries rather than believing a version was cleared when it
	// was not. Recording unconditionally would turn this case false.
	it("leaves the version unrecorded when the clear itself fails", async () => {
		const { clearResponseCacheOnUpgrade } = await importModule();
		const failing = vi.fn().mockRejectedValue(new Error("disk full"));
		await expect(clearResponseCacheOnUpgrade({ clearCache: failing }, "1.0.0")).resolves.toBe(
			false
		);

		const retried = vi.fn().mockResolvedValue(undefined);
		await expect(clearResponseCacheOnUpgrade({ clearCache: retried }, "1.0.0")).resolves.toBe(
			true
		);
	});
});
