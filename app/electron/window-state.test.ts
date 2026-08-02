/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Window geometry must never be able to stop the app from starting.
 *
 * The Store is built at module scope and conf parses the file inside its
 * constructor, so a corrupt window-state.json used to throw during main-process
 * module evaluation - before `app.whenReady`, before any of this module's own
 * error handling - and Electron met the user with "A JavaScript error occurred
 * in the main process" on every launch.
 *
 * These drive the real electron-store against a temp userData directory rather
 * than a mock of it, because the defect was in what the library does with a file
 * we hand it: a mocked store would have "passed" against the bug. `electron`
 * itself is faked, since that is the part vitest cannot provide.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindow, Rectangle } from "electron";

/** Mutable because the mock is hoisted above every test that retargets it. */
const fake = vi.hoisted(() => ({
	userData: "",
	displays: [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }],
}));

vi.mock("electron", () => {
	const api = {
		app: {
			getPath: () => fake.userData,
			getVersion: () => "0.0.0-test",
		},
		ipcMain: { on: () => {} },
		shell: { openPath: async () => "" },
		screen: { getAllDisplays: () => fake.displays },
	};
	// electron-store reaches for the default export; window-state.ts for the named ones.
	return { ...api, default: api };
});

const DEFAULTS = { defaultWidth: 1400, defaultHeight: 900 };

/** Seed the userData directory the next import will read, with raw file bytes. */
function seedStore(contents?: string): void {
	fake.userData = mkdtempSync(join(tmpdir(), "vayu-window-state-"));
	mkdirSync(fake.userData, { recursive: true });
	if (contents !== undefined) {
		writeFileSync(join(fake.userData, "window-state.json"), contents);
	}
}

function storeFile(): string {
	return readFileSync(join(fake.userData, "window-state.json"), "utf8");
}

/**
 * A fresh module instance, so the module-scope `new Store(...)` runs against the
 * directory just seeded. That constructor is where the crash lived, so the
 * import itself is under test.
 */
async function importWindowState() {
	vi.resetModules();
	return import("./window-state");
}

/** Just enough BrowserWindow for the save path: bounds, maximized, listeners. */
function fakeWindow(options: { bounds: Rectangle; isMaximized?: boolean }) {
	const handlers = new Map<string, () => void>();
	const window = {
		isMaximized: () => options.isMaximized ?? false,
		getBounds: () => options.bounds,
		on: (event: string, handler: () => void) => {
			handlers.set(event, handler);
		},
	} as unknown as BrowserWindow;

	return { window, emit: (event: string) => handlers.get(event)?.() };
}

beforeEach(() => {
	fake.displays = [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }];
});

afterEach(() => {
	if (fake.userData) rmSync(fake.userData, { recursive: true, force: true });
	fake.userData = "";
});

describe("a corrupt window-state.json", () => {
	it("does not throw at import time", async () => {
		seedStore('{"windowState": {"width": 12');

		await expect(importWindowState()).resolves.toBeDefined();
	});

	it("loads default geometry instead of crashing the launch", async () => {
		seedStore("this is not json at all");

		const { loadWindowState } = await importWindowState();

		expect(loadWindowState(DEFAULTS)).toEqual({
			width: 1400,
			height: 900,
			isMaximized: false,
		});
	});

	it("is replaced by a valid file on the next save", async () => {
		seedStore('{"windowState": {"width": 12');

		const { trackWindowState } = await importWindowState();
		const { window, emit } = fakeWindow({ bounds: { x: 10, y: 20, width: 800, height: 600 } });
		trackWindowState(window);
		emit("close");

		expect(JSON.parse(storeFile())).toEqual({
			windowState: { x: 10, y: 20, width: 800, height: 600, isMaximized: false },
		});
	});
});

describe("malformed but syntactically valid state", () => {
	it.each([
		["a non-numeric width", { width: "abc", height: 900 }],
		["a negative width", { width: -800, height: 900 }],
		["a zero height", { width: 1200, height: 0 }],
		["an infinite height", { width: 1200, height: Number.POSITIVE_INFINITY }],
		["a null width", { width: null, height: 900 }],
		["a missing pair", {}],
	])("falls back to the defaults for %s", async (_label, saved) => {
		seedStore(JSON.stringify({ windowState: saved }));

		const { loadWindowState } = await importWindowState();
		const state = loadWindowState(DEFAULTS);

		// Whatever survived must be a usable number - this is what reaches the
		// BrowserWindow constructor.
		expect(Number.isFinite(state.width) && state.width > 0).toBe(true);
		expect(Number.isFinite(state.height) && state.height > 0).toBe(true);
		expect(state.width === 1400 || state.height === 900).toBe(true);
	});

	it("keeps the good half of the pair", async () => {
		seedStore(JSON.stringify({ windowState: { width: "abc", height: 1000 } }));

		const { loadWindowState } = await importWindowState();

		expect(loadWindowState(DEFAULTS)).toEqual({
			width: 1400,
			height: 1000,
			isMaximized: false,
		});
	});

	/*
	 * `null` rather than a string on purpose. The on-a-display check compares with
	 * `>=` / `<`, and `null` coerces to 0 - so it lands inside every display and
	 * sails through, while `"nope"` fails both comparisons and would be dropped
	 * even with no validation at all. Only the null case can tell the two apart.
	 */
	it.each([
		["a null axis", { x: 100, y: null }],
		["a string axis", { x: 100, y: "nope" }],
		["an undefined axis", { x: 100 }],
	])("drops both axes when %s makes one unusable", async (_label, position) => {
		seedStore(JSON.stringify({ windowState: { ...position, width: 800, height: 600 } }));

		const { loadWindowState } = await importWindowState();
		const state = loadWindowState(DEFAULTS);

		expect(state.x).toBeUndefined();
		expect(state.y).toBeUndefined();
	});

	it("coerces a non-boolean isMaximized to false", async () => {
		seedStore(JSON.stringify({ windowState: { width: 800, height: 600, isMaximized: 1 } }));

		const { loadWindowState } = await importWindowState();

		expect(loadWindowState(DEFAULTS).isMaximized).toBe(false);
	});

	it.each([
		["a string", '{"windowState": "abc"}'],
		["an array", '{"windowState": [1, 2, 3]}'],
		["a number", '{"windowState": 42}'],
	])("falls back to the defaults when the state is %s", async (_label, contents) => {
		seedStore(contents);

		const { loadWindowState } = await importWindowState();

		expect(loadWindowState(DEFAULTS)).toEqual({
			width: 1400,
			height: 900,
			isMaximized: false,
		});
	});

	it("does not re-persist garbage when a maximized window saves", async () => {
		seedStore(JSON.stringify({ windowState: { width: "abc", height: -5, x: 10, y: 20 } }));

		const { trackWindowState } = await importWindowState();
		const { window, emit } = fakeWindow({
			bounds: { x: 0, y: 0, width: 1920, height: 1080 },
			isMaximized: true,
		});
		trackWindowState(window);
		emit("close");

		expect(JSON.parse(storeFile())).toEqual({
			windowState: { x: 10, y: 20, width: 1920, height: 1080, isMaximized: true },
		});
	});
});

describe("valid state", () => {
	it("round-trips through a save and a load", async () => {
		seedStore();

		const saver = await importWindowState();
		const { window, emit } = fakeWindow({
			bounds: { x: 120, y: 80, width: 1024, height: 768 },
		});
		saver.trackWindowState(window);
		emit("close");

		const { loadWindowState } = await importWindowState();

		expect(loadWindowState(DEFAULTS)).toEqual({
			x: 120,
			y: 80,
			width: 1024,
			height: 768,
			isMaximized: false,
		});
	});

	it("still drops a position that no longer lands on a display", async () => {
		seedStore(JSON.stringify({ windowState: { x: 9000, y: 9000, width: 800, height: 600 } }));

		const { loadWindowState } = await importWindowState();
		const state = loadWindowState(DEFAULTS);

		expect(state.x).toBeUndefined();
		expect(state.y).toBeUndefined();
		expect(state.width).toBe(800);
	});

	it("keeps a position that is on a secondary display", async () => {
		fake.displays = [
			{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
			{ bounds: { x: 1920, y: 0, width: 1920, height: 1080 } },
		];
		seedStore(JSON.stringify({ windowState: { x: 2000, y: 40, width: 800, height: 600 } }));

		const { loadWindowState } = await importWindowState();

		expect(loadWindowState(DEFAULTS).x).toBe(2000);
	});
});

describe("the module surface", () => {
	/*
	 * `saveWindowState` was exported with no importer anywhere - not even a test.
	 * "Written but never read" is this codebase's most repeated defect, so the
	 * surface is asserted rather than left to drift back open.
	 */
	it("exports only what main.ts calls", async () => {
		seedStore();

		const module = await importWindowState();

		expect(Object.keys(module).sort()).toEqual(["loadWindowState", "trackWindowState"]);
	});
});
