/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The electron-updater behaviour `updater.ts` gates the quit-time install on
 * (#2372), read from the installed package so an upgrade that changes it fails
 * here rather than installing an unverified update on quit.
 *
 * `holdDownloadForVerification` raises `autoInstallOnAppQuit` while
 * `update-downloaded` is emitted and drops it a microtask later, which is only
 * sound while all of this holds:
 *
 *   - `executeDownload`'s `done` emits the event and calls `addQuitHandler()`
 *     in one synchronous step, so the microtask runs after the registration;
 *   - the emit is a plain `EventEmitter` emit, which calls the listener
 *     synchronously;
 *   - `addQuitHandler()` registers nothing while the flag is false, which is
 *     why it has to be up for the registration;
 *   - the quit callback reads the flag again before it installs, which is
 *     why dropping it afterwards is enough to stop the install;
 *   - `update-available` is emitted before the download that swaps the file
 *     starts, which is why `invalidateVerifiedDownload` runs there.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const outDir = path.dirname(createRequire(import.meta.url).resolve("electron-updater"));
const baseUpdater = readFileSync(path.join(outDir, "BaseUpdater.js"), "utf8");
const appUpdater = readFileSync(path.join(outDir, "AppUpdater.js"), "utf8");

/** The source of one method, from its signature to the next method's. */
function methodBody(source: string, signature: string, nextSignature: string): string {
	const start = source.indexOf(signature);
	const end = source.indexOf(nextSignature, start);
	return start === -1 || end === -1 ? "" : source.slice(start, end);
}

describe("electron-updater's quit-time install, as updater.ts relies on it", () => {
	it("reads the installed package", () => {
		expect(baseUpdater.length).toBeGreaterThan(0);
		expect(appUpdater.length).toBeGreaterThan(0);
	});

	it("emits update-downloaded and registers the quit handler in one synchronous step", () => {
		const done = methodBody(
			baseUpdater,
			"executeDownload(taskOptions) {",
			"get installerPath()"
		);
		expect(done).not.toBe("");
		expect(done).toMatch(
			/done: event => \{\s*this\.dispatchUpdateDownloaded\(event\);\s*this\.addQuitHandler\(\);/
		);

		const dispatch = methodBody(appUpdater, "dispatchUpdateDownloaded(event) {", "}");
		expect(dispatch).toMatch(/^dispatchUpdateDownloaded\(event\) \{\s*this\.emit\(/);
		expect(appUpdater).toMatch(/const events_1 = require\("events"\);/);
		expect(appUpdater).toMatch(/class AppUpdater extends events_1\.EventEmitter \{/);
	});

	it("registers no quit handler while autoInstallOnAppQuit is false", () => {
		const handler = methodBody(baseUpdater, "addQuitHandler() {", "this.app.onQuit(");
		expect(handler).not.toBe("");
		expect(handler).toMatch(
			/if \(this\.quitHandlerAdded \|\| !this\.autoInstallOnAppQuit\) \{\s*return;\s*\}/
		);
	});

	it("reads autoInstallOnAppQuit again inside the quit callback, before installing", () => {
		const callback = methodBody(baseUpdater, "this.app.onQuit(", "sanitizeEnvPath(");
		expect(callback).not.toBe("");
		const recheck = callback.search(/if \(!this\.autoInstallOnAppQuit\) \{[^}]*return;/);
		const install = callback.indexOf("this.install(");
		expect(recheck).toBeGreaterThan(-1);
		expect(install).toBeGreaterThan(-1);
		expect(recheck).toBeLessThan(install);
	});

	it("emits update-available before it starts the download, the only way one starts", () => {
		const check = methodBody(
			appUpdater,
			"async doCheckForUpdates() {",
			"onUpdateAvailable(updateInfo) {"
		);
		expect(check).not.toBe("");
		const announce = check.indexOf("this.onUpdateAvailable(updateInfo);");
		const download = check.indexOf("this.downloadUpdate(");
		expect(announce).toBeGreaterThan(-1);
		expect(download).toBeGreaterThan(announce);
		// No `await` between the two, so the listener has run before the download is called.
		expect(check.slice(announce, download)).not.toMatch(/\bawait\b/);

		const onAvailable = methodBody(
			appUpdater,
			"onUpdateAvailable(updateInfo) {",
			"downloadUpdate("
		);
		expect(onAvailable).toMatch(/this\.emit\("update-available", updateInfo\);/);
		// The autoDownload call above is the one caller of the one download path.
		expect(appUpdater.match(/this\.downloadUpdate\(/g)).toHaveLength(1);
		expect(appUpdater.match(/this\.doDownloadUpdate\(/g)).toHaveLength(1);
	});
});
