/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The application menu's labels follow the surface they are drawn on (#3500):
 * Title Case in the macOS menu bar, sentence case in the menu popped from the
 * title-bar icon on Windows and Linux. The platform is always an argument, never
 * the host's.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { menuLabels } from "./menu-labels.js";

describe("menuLabels", () => {
	it("is Title Case in the macOS menu bar", () => {
		expect(menuLabels("darwin")).toEqual({
			checkForUpdates: "Check for Updates…",
			settings: "Settings…",
			actualSize: "Actual Size",
			zoomIn: "Zoom In",
			zoomOut: "Zoom Out",
			scriptingGuide: "Scripting Guide",
			reportIssue: "Report an Issue",
		});
	});

	it.each(["win32", "linux"])("is sentence case on %s", (platform) => {
		expect(menuLabels(platform)).toEqual({
			checkForUpdates: "Check for updates…",
			settings: "Settings…",
			actualSize: "Actual size",
			zoomIn: "Zoom in",
			zoomOut: "Zoom out",
			scriptingGuide: "Scripting guide",
			reportIssue: "Report an issue",
		});
	});

	it.each(["darwin", "win32", "linux"])("names the settings item Settings… on %s", (platform) => {
		expect(menuLabels(platform).settings).toBe("Settings…");
	});

	it("differs between the platforms by case alone", () => {
		const mac = menuLabels("darwin");
		const other = menuLabels("linux");
		for (const key of Object.keys(mac) as (keyof typeof mac)[]) {
			expect(other[key].toLowerCase(), key).toBe(mac[key].toLowerCase());
		}
	});
});

describe("createMenu in main.ts", () => {
	const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "main.ts"), "utf8");
	const start = main.indexOf("function createMenu()");
	const body = main.slice(start, main.indexOf("Menu.setApplicationMenu(menu)", start));

	it("scans a menu body that has labels at all", () => {
		// An empty slice would pass the literal check below.
		expect(start).toBeGreaterThan(0);
		expect(body.match(/label:/g)?.length ?? 0).toBeGreaterThanOrEqual(10);
	});

	it("takes each label that differs by platform from the table, never a literal", () => {
		for (const name of Object.keys(menuLabels("linux"))) {
			expect(body, name).toContain(`labels.${name}`);
		}
		for (const literal of Object.values(menuLabels("darwin"))) {
			expect(body, literal).not.toContain(`label: "${literal}"`);
		}
		for (const literal of Object.values(menuLabels("linux"))) {
			expect(body, literal).not.toContain(`label: "${literal}"`);
		}
	});
});
