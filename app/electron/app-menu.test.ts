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
import {
	planAppMenuPopup,
	menuPoint,
	showApplicationMenu,
	type AppMenuRequest,
	type PopupWindow,
} from "./app-menu.js";

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

describe("showApplicationMenu", () => {
	/** A menu that records what it was asked to pop, and nothing else. */
	function fakeMenu() {
		const popped: ({ window?: unknown; x?: number; y?: number } | undefined)[] = [];
		return {
			popup(options?: { window?: PopupWindow; x?: number; y?: number }) {
				popped.push(options);
			},
			popped,
		};
	}
	const liveWindow = (): PopupWindow => ({ isDestroyed: () => false });

	it("pops the menu it was handed, over the window, at the point", () => {
		const menu = fakeMenu();
		const window = liveWindow();

		const plan = showApplicationMenu({
			platform: "win32",
			menu,
			window,
			position: { x: 15.6, y: 37.4 },
		});

		expect(plan).toEqual({ pop: true, point: { x: 16, y: 37 } });
		expect(menu.popped).toEqual([{ window, x: 16, y: 37 }]);
	});

	it("pops at the pointer when the point is unusable", () => {
		const menu = fakeMenu();

		showApplicationMenu({ platform: "linux", menu, window: liveWindow(), position: "16,38" });

		expect(menu.popped).toHaveLength(1);
		expect(menu.popped[0]).not.toHaveProperty("x");
		expect(menu.popped[0]).not.toHaveProperty("y");
	});

	it("pops nothing on macOS, over a destroyed window, or with no menu", () => {
		const menu = fakeMenu();
		const gone: PopupWindow = { isDestroyed: () => true };

		expect(showApplicationMenu({ platform: "darwin", menu, window: liveWindow() })).toEqual({
			pop: false,
			reason: "has-menu-bar",
		});
		expect(showApplicationMenu({ platform: "win32", menu, window: gone })).toEqual({
			pop: false,
			reason: "no-window",
		});
		expect(showApplicationMenu({ platform: "win32", menu, window: null })).toEqual({
			pop: false,
			reason: "no-window",
		});
		expect(
			showApplicationMenu({ platform: "linux", menu: null, window: liveWindow() })
		).toEqual({ pop: false, reason: "no-menu" });
		expect(menu.popped).toEqual([]);
	});
});

describe("the wiring in main.ts", () => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const main = readFileSync(path.join(here, "main.ts"), "utf8");

	/** The handler's body, so a claim about it is not a claim about the file. */
	const handlerBody = (() => {
		const handler = main.slice(main.indexOf('ipcMain.on("window:appMenu"'));
		return handler.slice(0, handler.indexOf("\n\t});"));
	})();

	it("reads a handler to scan at all", () => {
		// A slice that came back empty would pass every `not.toContain` below.
		expect(main).toContain('ipcMain.on("window:appMenu"');
		expect(handlerBody.length).toBeGreaterThan(0);
	});

	it("pops the menu that is already installed, and builds no second one", () => {
		// The point of the issue: one template, two surfaces. A
		// `buildFromTemplate` here would be a second definition of the menu, free
		// to drift from the menu bar macOS draws from the same object.
		expect(handlerBody).toContain("showApplicationMenu({");
		expect(handlerBody).toContain("Menu.getApplicationMenu()");
		expect(handlerBody).not.toContain("buildFromTemplate");
	});

	it("gives the About panel a link on every platform", () => {
		// The fields are platform-scoped: `website` and `authors` are read on
		// Linux, `credits` on macOS and Windows. Setting one half leaves the
		// other platform's panel with a version and nothing to follow.
		const options = main.slice(main.indexOf("app.setAboutPanelOptions({"));
		const body = options.slice(0, options.indexOf("});"));
		expect(body.length).toBeGreaterThan(0);
		for (const field of ["applicationVersion:", "website:", "authors:", "credits:"]) {
			expect(body, field).toContain(field);
		}
	});
});
