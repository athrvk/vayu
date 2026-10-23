/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Opening THIRD_PARTY_NOTICES.txt (#2693): where the file is in each kind of
 * build, what a failure says, and the four places that have to agree for the
 * Help menu and Settings to reach it.
 *
 * The decision is pure and takes the paths as arguments, so both branches run
 * here whatever the host is. main.ts creates windows and starts the engine at
 * import time and cannot be driven, so its wiring is read as text at the
 * bottom, the way app-menu.test.ts reads it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	locateThirdPartyNotices,
	openThirdPartyNotices,
	openThirdPartyNoticesFromMenu,
	NOTICES_MISSING,
	NOTICES_NOT_GENERATED,
	type NoticesLocation,
} from "./third-party-notices";

const APP_PATH = path.join("/fake", "vayu", "app");
const RESOURCES = path.join("/fake", "install", "resources");
const STAGED = path.join(APP_PATH, "build", "THIRD_PARTY_NOTICES.txt");
const INSTALLED = path.join(RESOURCES, "THIRD_PARTY_NOTICES.txt");

function location(overrides: Partial<NoticesLocation> = {}): NoticesLocation {
	return {
		isDev: false,
		appPath: APP_PATH,
		resourcesPath: RESOURCES,
		exists: () => true,
		...overrides,
	};
}

describe("locateThirdPartyNotices", () => {
	it("is the loose copy under resources in a packaged build", () => {
		const exists = vi.fn(() => true);
		expect(locateThirdPartyNotices(location({ exists }))).toEqual({ path: INSTALLED });
		expect(exists).toHaveBeenCalledWith(INSTALLED);
	});

	it("says the installation lacks the file when a packaged build has none", () => {
		expect(locateThirdPartyNotices(location({ exists: () => false }))).toEqual({
			error: NOTICES_MISSING,
		});
	});

	it("never falls back to the repo's staged copy in a packaged build", () => {
		const exists = (p: string) => p === STAGED;
		expect(locateThirdPartyNotices(location({ exists }))).toEqual({ error: NOTICES_MISSING });
	});

	it("says the file is not generated in a development build with no staged copy", () => {
		expect(locateThirdPartyNotices(location({ isDev: true, exists: () => false }))).toEqual({
			error: NOTICES_NOT_GENERATED,
		});
	});

	it("opens a staged copy under app/build in a development build", () => {
		expect(
			locateThirdPartyNotices(location({ isDev: true, exists: (p) => p === STAGED }))
		).toEqual({ path: STAGED });
	});

	it("does not look under resourcesPath in a development build", () => {
		const exists = (p: string) => p === INSTALLED;
		expect(locateThirdPartyNotices(location({ isDev: true, exists }))).toEqual({
			error: NOTICES_NOT_GENERATED,
		});
	});

	it("tells the user what to run, in the repo's voice", () => {
		expect(NOTICES_NOT_GENERATED).toContain("build.py");
		expect(NOTICES_NOT_GENERATED).not.toMatch(/^(Failed to|Could not|Please)/);
	});
});

describe("openThirdPartyNotices", () => {
	it("hands the located path to the shell and returns its empty success", async () => {
		const openPath = vi.fn(async () => "");
		await expect(openThirdPartyNotices(location(), { openPath })).resolves.toBe("");
		expect(openPath).toHaveBeenCalledExactlyOnceWith(INSTALLED);
	});

	it("returns the shell's reason when it cannot open the file", async () => {
		const openPath = vi.fn(async () => "No application is associated with .txt");
		await expect(openThirdPartyNotices(location(), { openPath })).resolves.toBe(
			"No application is associated with .txt"
		);
	});

	it("returns the locating error and never calls the shell without a file", async () => {
		const openPath = vi.fn(async () => "");
		await expect(
			openThirdPartyNotices(location({ isDev: true, exists: () => false }), { openPath })
		).resolves.toBe(NOTICES_NOT_GENERATED);
		expect(openPath).not.toHaveBeenCalled();
	});
});

describe("openThirdPartyNoticesFromMenu", () => {
	it("logs the reason when the file would not open", async () => {
		const log = vi.fn();
		await openThirdPartyNoticesFromMenu(async () => NOTICES_MISSING, log);
		expect(log).toHaveBeenCalledExactlyOnceWith("Couldn't open the third-party notices", {
			failure: NOTICES_MISSING,
		});
	});

	it("logs nothing when it opened", async () => {
		const log = vi.fn();
		await openThirdPartyNoticesFromMenu(async () => "", log);
		expect(log).not.toHaveBeenCalled();
	});
});

describe("the wiring that makes the file reachable", () => {
	const read = (relative: string) =>
		readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");
	const main = read("./main.ts");
	const preload = read("./preload.ts");
	const declarations = read("../src/types/electron.d.ts");
	const builder = JSON.parse(read("../electron-builder.json")) as {
		extraResources: { from: string; to: string }[];
	};

	it("reads the sources it scans", () => {
		for (const text of [main, preload, declarations]) expect(text.length).toBeGreaterThan(1000);
		expect(builder.extraResources.length).toBeGreaterThan(0);
	});

	it("ships the generated file loose, under the name the app resolves", () => {
		expect(builder.extraResources).toContainEqual({
			from: "build/THIRD_PARTY_NOTICES.txt",
			to: "THIRD_PARTY_NOTICES.txt",
		});
	});

	it("carries the channel from the preload to a no-argument main handler", () => {
		expect(preload).toContain(
			'openThirdPartyNotices: (): Promise<string> => ipcRenderer.invoke("app:openThirdPartyNotices")'
		);
		expect(main).toContain('ipcMain.handle("app:openThirdPartyNotices", () => openNotices());');
		expect(declarations).toContain("openThirdPartyNotices: () => Promise<string>;");
	});

	it("puts the Help item outside the platform gate, so macOS has it too", () => {
		const help = main.slice(main.indexOf('label: "Help"'));
		const submenu = help.slice(0, help.indexOf("Menu.buildFromTemplate"));
		const item = submenu.indexOf('label: "Third-party notices"');
		expect(item).toBeGreaterThan(0);
		expect(item).toBeLessThan(submenu.indexOf("...(isMac"));
		expect(submenu.slice(item)).toContain("openThirdPartyNoticesFromMenu(openNotices");
	});

	it("points the About panel at the menu item", () => {
		const options = main.slice(main.indexOf("app.setAboutPanelOptions({"));
		const body = options.slice(0, options.indexOf("});"));
		expect(body).toContain("credits:");
		expect(body).toContain("Help › Third-party notices");
	});
});
