/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The identity Windows files a toast under (issue #1358).
 *
 * Windows matches a notification's AppUserModelID against the Start Menu
 * shortcut electron-builder's NSIS target stamps with `appId`. A mismatch is
 * not a wrong name on the toast - it is no toast at all, silently, on the one
 * platform where nothing in the app can tell you so. Electron's own default is
 * a generic "electron" identity, which is that same failure by omission.
 *
 * Two things therefore have to hold, and neither is visible from the other's
 * file: the id equals the packaged `appId`, and it is set before anything can
 * post. `main.ts` creates windows and starts the engine at import time, so the
 * second is read as text, the way `startup-order.test.ts` reads its own claim.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { APP_USER_MODEL_ID } from "./constants.js";

const here = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(join(here, "main.ts"), "utf8");
const builder = JSON.parse(readFileSync(join(here, "..", "electron-builder.json"), "utf8")) as {
	appId?: string;
};

describe("the app's Windows identity", () => {
	it("is the appId the installer stamps on the shortcut", () => {
		expect(builder.appId).toBeTruthy();
		expect(APP_USER_MODEL_ID).toBe(builder.appId);
	});

	it("is set at module scope, before the app is ready", () => {
		const setAt = main.indexOf(`app.setAppUserModelId(APP_USER_MODEL_ID);`);
		const readyAt = main.indexOf("app.whenReady()");

		expect(setAt).toBeGreaterThan(-1);
		expect(readyAt).toBeGreaterThan(-1);
		// Not merely "somewhere in the file": inside the `whenReady` handler it
		// would run after Electron has already decided what this process is.
		expect(setAt).toBeLessThan(readyAt);
	});
});
