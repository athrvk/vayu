/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The directory the Windows uninstaller deletes (issue #1393).
 *
 * `installer.nsh` named `productName` - "Vayu" - where Electron uses
 * `app.getName()`, which is `app/package.json`'s `name`. The consequence was
 * not a cosmetic wrong path: the uninstaller offers "Delete everything" and
 * then ran `RMDir /r` over a directory the app has never written, so every
 * saved request survived an uninstall the user was told erased it. A wrong
 * `RMDir /r` reports nothing either way, which is why the defect stood.
 *
 * NSIS cannot read `package.json`, so the name is spelled in both files and the
 * duplication is guarded rather than trusted. Three claims, because the defect
 * had three shapes: the define drifting from the name, a raw path bypassing the
 * define, and - the original form - a header comment asserting a directory the
 * script does not use. Comments are scanned exactly like code for that reason.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(join(here, "..", "installer", "installer.nsh"), "utf8");
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
	name?: string;
};
const builder = JSON.parse(readFileSync(join(here, "..", "electron-builder.json"), "utf8")) as {
	productName?: string;
};

/**
 * Every `%APPDATA%` / `$LOCALAPPDATA` reference in the script, with the path
 * segment that follows it. Both the NSIS variable form (`$APPDATA\`) and the
 * environment form a comment uses (`%APPDATA%\`) are matched, because the
 * header comment is where the wrong directory was asserted first.
 */
function appDataSegments(): string[] {
	return [...script.matchAll(/[$%](?:LOCAL)?APPDATA%?\\([^\s"\\]*)/g)].map((match) => match[1]);
}

describe("the Windows installer's data directory", () => {
	it("is the name Electron derives userData from", () => {
		expect(pkg.name).toBeTruthy();
		const define = /^!define APP_DATA_DIR "([^"]*)"$/m.exec(script);
		expect(define, "installer.nsh no longer defines APP_DATA_DIR").not.toBeNull();
		expect(define?.[1]).toBe(pkg.name);
	});

	it("is reached only through that define, never a spelled-out path", () => {
		const segments = appDataSegments();
		expect(segments.length).toBeGreaterThan(0);
		for (const segment of segments) {
			expect(segment).toBe("${APP_DATA_DIR}");
		}
	});

	it("is never productName, which names the process and not the directory", () => {
		expect(builder.productName).toBeTruthy();
		const asDirectory = new RegExp(String.raw`\\${builder.productName}(?=[\\"\s]|$)`, "m");
		expect(script).not.toMatch(asDirectory);
	});
});
