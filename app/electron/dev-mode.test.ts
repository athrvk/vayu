/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

let isPackaged = false;
vi.mock("electron", () => ({
	app: {
		get isPackaged() {
			return isPackaged;
		},
	},
}));

afterEach(() => vi.unstubAllEnvs());

describe("isDevelopmentBuild", () => {
	it("is true for an unpackaged run with NODE_ENV=development", async () => {
		const { isDevelopmentBuild } = await import("./dev-mode.js");
		vi.stubEnv("NODE_ENV", "development");
		isPackaged = false;
		expect(isDevelopmentBuild()).toBe(true);
	});

	it("is false for a packaged build even with NODE_ENV=development", async () => {
		const { isDevelopmentBuild } = await import("./dev-mode.js");
		vi.stubEnv("NODE_ENV", "development");
		isPackaged = true;
		expect(isDevelopmentBuild()).toBe(false);
	});

	it("is false for an unpackaged run without it", async () => {
		const { isDevelopmentBuild } = await import("./dev-mode.js");
		vi.stubEnv("NODE_ENV", "production");
		isPackaged = false;
		expect(isDevelopmentBuild()).toBe(false);
	});
});
