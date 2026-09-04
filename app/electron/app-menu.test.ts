/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The application menu's second surface (#1361).
 *
 * `planAppMenuPopup` is the whole decision and takes no Electron type, so the
 * three refusals and the two ways a point can arrive are unit tests here rather
 * than three platforms of manual clicking. What cannot be driven is main.ts
 * itself - it creates windows and starts the engine at import time - so the
 * wiring is read as text at the bottom, the way context-menu.test.ts reads it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { planAppMenuPopup, menuPoint, type AppMenuRequest } from "./app-menu.js";

const request = (overrides: Partial<AppMenuRequest> = {}): AppMenuRequest => ({
	platform: "win32",
	hasWindow: true,
	hasMenu: true,
	...overrides,
});

describe("planAppMenuPopup", () => {
	it("pops the installed menu on Windows and Linux", () => {
		for (const platform of ["win32", "linux"]) {
			expect(planAppMenuPopup(request({ platform, position: { x: 16, y: 38 } }))).toEqual({
				pop: true,
				point: { x: 16, y: 38 },
			});
		}
	});

	it("leaves macOS to its menu bar", () => {
		expect(planAppMenuPopup(request({ platform: "darwin", position: { x: 1, y: 2 } }))).toEqual(
			{
				pop: false,
				reason: "has-menu-bar",
			}
		);
	});

	it("does not pop over a window that is gone", () => {
		expect(planAppMenuPopup(request({ hasWindow: false }))).toEqual({
			pop: false,
			reason: "no-window",
		});
	});

	it("does not pop a menu that was never installed", () => {
		expect(planAppMenuPopup(request({ hasMenu: false }))).toEqual({
			pop: false,
			reason: "no-menu",
		});
	});

	it("falls back to the pointer when the renderer sent no point", () => {
		expect(planAppMenuPopup(request())).toEqual({ pop: true, point: null });
	});

	it("refuses the platform before it looks at the window", () => {
		// Order matters only in that macOS must never be told "no-window": the
		// answer there is the menu bar, whatever the window is doing.
		expect(
			planAppMenuPopup(request({ platform: "darwin", hasWindow: false, hasMenu: false }))
		).toEqual({ pop: false, reason: "has-menu-bar" });
	});
});

describe("menuPoint", () => {
	it("rounds, because Electron rejects fractional coordinates", () => {
		expect(menuPoint({ x: 15.6, y: 37.4 })).toEqual({ x: 16, y: 37 });
	});

	it("keeps a point that is already whole", () => {
		expect(menuPoint({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
	});

	it("reads nothing usable as no point at all", () => {
		// Everything the channel can deliver that is not a pair of finite
		// numbers. The menu still opens for each of these - at the pointer.
		for (const position of [
			undefined,
			null,
			"16,38",
			42,
			{},
			{ x: 16 },
			{ x: "16", y: "38" },
			{ x: Number.NaN, y: 38 },
			{ x: 16, y: Number.POSITIVE_INFINITY },
		]) {
			expect(menuPoint(position), JSON.stringify(position ?? null)).toBeNull();
		}
	});
});

describe("the wiring in main.ts", () => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const main = readFileSync(path.join(here, "main.ts"), "utf8");

	it("pops the menu that is already installed, and builds no second one", () => {
		expect(main).toContain('ipcMain.on("window:appMenu"');
		expect(main).toContain("planAppMenuPopup({");
		// The point of the issue: one template, two surfaces. A
		// `buildFromTemplate` in this handler would be a second definition of
		// the menu that could drift from the menu bar macOS draws.
		const handler = main.slice(main.indexOf('ipcMain.on("window:appMenu"'));
		const body = handler.slice(0, handler.indexOf("\n\t});"));
		expect(body).toContain("Menu.getApplicationMenu()");
		expect(body).not.toContain("buildFromTemplate");
	});

	it("names the authors the Linux About panel prints", () => {
		const options = main.slice(main.indexOf("app.setAboutPanelOptions({"));
		expect(options.slice(0, options.indexOf("});"))).toContain("authors:");
	});
});
