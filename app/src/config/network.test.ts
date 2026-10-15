/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The renderer addresses the engine on the port the main process chose (#2118).
 *
 * `ENGINE_PORT` is read once at module load, so the module-level cases reset
 * the module graph and stub the preload bridge first, as the real preload does
 * before any renderer script runs. Both branches are driven: a bridge that
 * reports a port, and the absence of one.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ENGINE_PORT, resolveEnginePort } from "./network";

describe("resolveEnginePort", () => {
	it("takes the port the preload reports", () => {
		expect(resolveEnginePort({ enginePort: 9883 })).toBe(9883);
	});

	it("is the default when there is no preload", () => {
		expect(resolveEnginePort(undefined)).toBe(DEFAULT_ENGINE_PORT);
		expect(DEFAULT_ENGINE_PORT).toBe(9876);
	});

	it("is the default when the preload could not read a port", () => {
		expect(resolveEnginePort({ enginePort: null })).toBe(DEFAULT_ENGINE_PORT);
		expect(resolveEnginePort({})).toBe(DEFAULT_ENGINE_PORT);
	});

	it.each([0, -1, 65536, 9880.5, Number.NaN, Number.POSITIVE_INFINITY])(
		"ignores %s, which is not a port",
		(enginePort) => {
			expect(resolveEnginePort({ enginePort })).toBe(DEFAULT_ENGINE_PORT);
		}
	);

	it("accepts the ends of the port range", () => {
		expect(resolveEnginePort({ enginePort: 1 })).toBe(1);
		expect(resolveEnginePort({ enginePort: 65535 })).toBe(65535);
	});
});

describe("ENGINE_BASE_URL at module load", () => {
	afterEach(() => {
		delete (window as unknown as { electronAPI?: unknown }).electronAPI;
		vi.resetModules();
	});

	async function loadWith(electronAPI: unknown) {
		vi.resetModules();
		if (electronAPI !== undefined) {
			(window as unknown as { electronAPI?: unknown }).electronAPI = electronAPI;
		}
		return import("./network");
	}

	it("follows the preload's port, in the port and the URL both", async () => {
		const network = await loadWith({ enginePort: 9884 });
		expect(network.ENGINE_PORT).toBe(9884);
		expect(network.ENGINE_BASE_URL).toBe("http://127.0.0.1:9884");
	});

	it("is the default engine address with no preload", async () => {
		const network = await loadWith(undefined);
		expect(network.ENGINE_PORT).toBe(9876);
		expect(network.ENGINE_BASE_URL).toBe("http://127.0.0.1:9876");
	});

	it("is the default engine address when the preload reports no port", async () => {
		const network = await loadWith({ enginePort: null });
		expect(network.ENGINE_BASE_URL).toBe("http://127.0.0.1:9876");
	});
});
