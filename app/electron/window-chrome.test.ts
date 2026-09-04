/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The shell window's native shape is decided here, not inherited (#1335).
 *
 * Electron 43 made frameless windows rounded by default on Linux, and Vayu's
 * shell is frameless - the titlebar, its buttons and the window's edge are
 * drawn by the renderer. Rounded is the shape wanted there, matching macOS, so
 * this is not a change being resisted; what the guard holds is that the app
 * *states* it. Otherwise the platform default is the one thing that can change
 * what the window looks like without a line of this app changing.
 *
 * main.ts creates the window at import time, so the option can only be read -
 * the characterization approach `startup-order.test.ts` and
 * `context-menu.test.ts` take to the same file.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "main.ts"), "utf8");

describe("the shell window's chrome", () => {
	it("read the file it is guarding", () => {
		// A guard over an empty string passes forever.
		expect(main).toContain("new BrowserWindow({");
	});

	it("draws its own frame", () => {
		expect(main).toContain("frame: false,");
	});

	it("states the native corners rather than taking the platform default", () => {
		// One value on every platform: macOS has always rounded its windows,
		// Linux rounds a frameless one since Electron 43, and Windows ignores
		// the option.
		expect(main).toContain("roundedCorners: true,");
	});
});
