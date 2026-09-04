/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The shell window's native shape is decided here, not inherited (#1335).
 *
 * Electron 43 made frameless windows rounded by default on Linux. Vayu's shell
 * is frameless - the titlebar, its buttons and the window's edge are drawn by
 * the renderer, square to the boundary - so the platform default is the one
 * thing that can change what the window looks like without a line of this app
 * changing. Pinning `roundedCorners` costs one property and makes the next
 * Electron's default a non-event; leaving it out is how the corners moved.
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

	it("pins the native corners rather than taking the platform default", () => {
		// macOS has always rounded its windows and keeps doing so; Linux keeps
		// the square shape Vayu shipped with, because nothing in the renderer
		// paints around a rounded native edge. Windows ignores the option.
		expect(main).toContain('roundedCorners: process.platform !== "linux",');
	});
});
