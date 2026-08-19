/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What is at stake here is the preload, not tidiness: it re-runs on whatever the
 * main window navigates to, so a navigation off the app hands
 * `window.electronAPI` - the engine, the filesystem readers, the OAuth surface -
 * to a third-party origin. Before this guard the only thing in front of that was
 * one component rendering links as buttons.
 *
 * So the assertions worth holding are the two directions of the predicate. A
 * guard that refuses everything closes the hole and breaks the app; a guard that
 * refuses nothing passes any test that only ever checks the happy path. Both
 * builds are therefore asserted from both sides, and the dev server's own reload
 * path is stated as a case rather than assumed.
 *
 * These drive a fake `webContents` rather than Electron, which is the whole
 * reason the module lives outside main.ts.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
	installWindowNavigationGuard,
	isAppOwnUrl,
	type NavigableContents,
} from "./window-navigation.js";

// main.ts creates windows and starts the engine at import time, so the wiring
// itself can only be read. Everything above this line would still pass with the
// guard never installed, which is the whole of the bug being fixed.
const mainSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "main.ts"), "utf8");

const DEV_URL = "http://localhost:5173";
const PROD_URL = "file:///opt/Vayu/resources/app.asar/dist/index.html";

/** A WebContents that never existed: records the listener so a test can fire it. */
function fakeContents() {
	let navigate: ((event: { preventDefault(): void }, url: string) => void) | undefined;
	const openHandler = vi.fn();

	const contents: NavigableContents = {
		on(_event, listener) {
			navigate = listener;
			return this;
		},
		setWindowOpenHandler(handler) {
			openHandler.mockImplementation(handler);
			return this;
		},
	};

	return {
		contents,
		openHandler,
		/** Attempt a navigation. Returns whether the window refused it. */
		attempt(url: string): boolean {
			const preventDefault = vi.fn();
			navigate?.({ preventDefault }, url);
			return preventDefault.mock.calls.length > 0;
		},
	};
}

/** Whether the installed guard lets `url` through. */
function allows(appUrl: string, url: string): boolean {
	const w = fakeContents();
	installWindowNavigationGuard(w.contents, appUrl);
	return !w.attempt(url);
}

describe("a production window goes nowhere but its own document", () => {
	it("refuses an external https target", () => {
		expect(allows(PROD_URL, "https://evil.example.com/")).toBe(false);
	});

	it("allows the entry document it was loaded with, so an in-page reload works", () => {
		expect(allows(PROD_URL, PROD_URL)).toBe(true);
	});

	it("allows a hash route on that document", () => {
		// Hash navigation is same-document; refusing it would break routing.
		expect(allows(PROD_URL, `${PROD_URL}#/collections/1`)).toBe(true);
	});

	it("refuses another local file, which sharing a scheme is not permission for", () => {
		// The reason the production branch cannot compare origins: every file:
		// URL has the opaque origin "null", so an origin test passes this.
		expect(new URL(PROD_URL).origin).toBe(new URL("file:///etc/passwd").origin);
		expect(allows(PROD_URL, "file:///etc/passwd")).toBe(false);
	});
});

describe("a development window keeps the dev server's reload path", () => {
	it("allows the dev server root", () => {
		expect(allows(DEV_URL, DEV_URL)).toBe(true);
	});

	it("allows any path under the dev server, which is where a full reload lands", () => {
		// Vite reloads the page when an HMR update cannot be applied in place.
		// That is page-initiated, so it arrives as a real navigation.
		expect(allows(DEV_URL, `${DEV_URL}/index.html?t=1`)).toBe(true);
	});

	it("refuses a different port on the same host", () => {
		expect(allows(DEV_URL, "http://localhost:5174/")).toBe(false);
	});

	it("refuses an external https target", () => {
		expect(allows(DEV_URL, "https://evil.example.com/")).toBe(false);
	});
});

describe("anything that is not a URL at all is refused rather than guessed at", () => {
	it.each(["", "not a url", "javascript:alert(1)", "file:relative"])("refuses %j", (url) => {
		expect(allows(PROD_URL, url)).toBe(false);
	});
});

describe("the predicate itself", () => {
	it("refuses when the app's own URL is unparseable, rather than allowing everything", () => {
		expect(isAppOwnUrl("https://evil.example.com/", "")).toBe(false);
	});
});

describe("window.open", () => {
	it("is denied, whatever it asks for", () => {
		const w = fakeContents();
		installWindowNavigationGuard(w.contents, PROD_URL);
		expect(w.openHandler({ url: "https://evil.example.com/" })).toEqual({ action: "deny" });
		// Not even the app's own document: a child window carries the preload the
		// same way a navigation does, and nothing in this app opens one.
		expect(w.openHandler({ url: PROD_URL })).toEqual({ action: "deny" });
	});
});

describe("main.ts wiring", () => {
	it("read the real main.ts", () => {
		// A guard that scanned an empty string would pass every assertion below.
		expect(mainSource.length).toBeGreaterThan(1000);
		expect(mainSource).toContain("createWindow");
	});

	it("installs the guard on the main window", () => {
		expect(mainSource).toContain("installWindowNavigationGuard(\n\t\tmainWindow.webContents,");
	});

	it("installs it before the load, so no navigation lands ahead of it", () => {
		const install = mainSource.indexOf("installWindowNavigationGuard(\n");
		const load = mainSource.indexOf("mainWindow.loadURL(DEV_SERVER_URL)");
		expect(install).toBeGreaterThan(-1);
		expect(load).toBeGreaterThan(install);
	});

	it("passes the URL it actually loads, in both builds", () => {
		// The predicate is only as good as the URL it is compared against, and a
		// second spelling of the entry path here would drift from `loadFile`'s.
		expect(mainSource).toContain(
			"isDev ? DEV_SERVER_URL : pathToFileURL(rendererEntry).toString()"
		);
		expect(mainSource).toContain("mainWindow.loadFile(rendererEntry)");
	});
});
