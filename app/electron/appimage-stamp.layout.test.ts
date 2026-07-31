/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Linux install layout exists twice - in `install.sh` and in
 * `appimage-stamp.ts` - because a shell script and an Electron main process
 * cannot share a constant. Both write the same version stamp and both have to
 * agree on where it is: if the installer moves and the app does not, the app
 * silently writes a file nothing reads, the installer's record goes stale after
 * every self-update, and the only symptom is a redundant 160MB download that
 * nobody connects to the rename that caused it.
 *
 * So the duplication is guarded rather than trusted. This reads the shell
 * definitions and asserts the TypeScript computes the same paths from them.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveStampPath } from "./appimage-stamp.js";

const here = dirname(fileURLToPath(import.meta.url));
const installer = readFileSync(join(here, "..", "..", "install.sh"), "utf8");

/** The right-hand side of a top-level assignment in install.sh. */
function shellValue(name: string): string {
	const match = installer.match(new RegExp(`^${name}="([^"]*)"`, "m"));
	if (!match) throw new Error(`install.sh no longer defines ${name}`);
	return match[1];
}

/** Expand the handful of shell variables these definitions actually use. */
function expand(value: string, vars: Record<string, string>): string {
	return value.replace(/\$\{?(\w+)\}?/g, (whole, name: string) =>
		name in vars ? vars[name] : whole
	);
}

describe("the Linux layout, as install.sh defines it", () => {
	const home = "/home/tester";
	const vars: Record<string, string> = { APP_NAME: "Vayu" };
	vars.LINUX_DATA_HOME = `${home}/.local/share`;
	vars.LINUX_APP_DIR = expand(shellValue("LINUX_APP_DIR"), vars);
	vars.LINUX_APP_BIN = expand(shellValue("LINUX_APP_BIN"), vars);

	it("scans a definition rather than nothing", () => {
		// Without this the regexes above could quietly match an empty string and
		// every assertion below would compare "" to "" and pass.
		expect(installer.length).toBeGreaterThan(1000);
		expect(vars.LINUX_APP_DIR).toContain("/vayu");
		expect(vars.LINUX_APP_BIN).toContain("Vayu.AppImage");
	});

	it("puts the AppImage where the app expects to find itself", () => {
		// resolveStampPath only answers for the managed install, so agreeing on
		// this path is what makes the stamp get written at all.
		expect(
			resolveStampPath({ platform: "linux", appImagePath: vars.LINUX_APP_BIN, home })
		).not.toBeNull();
	});

	it("puts the version stamp where the app writes it", () => {
		const stamp = expand(shellValue("LINUX_VERSION_FILE"), vars);
		expect(
			resolveStampPath({ platform: "linux", appImagePath: vars.LINUX_APP_BIN, home })
		).toBe(stamp);
	});
});
