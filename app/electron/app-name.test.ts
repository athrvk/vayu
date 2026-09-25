/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What macOS titles the app menu, and "About"/"Quit" under it, from.
 *
 * `app.getName()` defaults to `package.json`'s `name`, the npm package
 * `"vayu-client"` - electron-builder's `productName` renames the packaged
 * bundle, never the asar's `package.json`, so that default survives into a
 * production build. `main.ts`'s app menu builds its macOS submenu label (and
 * the roles under it) from `app.name`, so without an explicit `app.setName()`
 * the menu bar reads "Quit vayu-client" instead of "Quit Vayu" on every
 * platform electron-builder ships for. See APP_NAME's own comment.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { APP_NAME } from "./constants.js";

const here = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(join(here, "main.ts"), "utf8");
const builder = JSON.parse(readFileSync(join(here, "..", "electron-builder.json"), "utf8")) as {
	productName?: string;
};

describe("the app's display name", () => {
	it("is the productName the installers ship under", () => {
		expect(builder.productName).toBeTruthy();
		expect(APP_NAME).toBe(builder.productName);
	});

	it("is set at module scope, before the app is ready", () => {
		const setAt = main.indexOf("app.setName(APP_NAME);");
		const readyAt = main.indexOf("app.whenReady().then(");

		expect(setAt).toBeGreaterThan(-1);
		expect(readyAt).toBeGreaterThan(-1);
		// Not merely "somewhere in the file": inside the `whenReady` handler it
		// would run after the app menu (built from `app.name`) may already exist.
		expect(setAt).toBeLessThan(readyAt);
	});
});
