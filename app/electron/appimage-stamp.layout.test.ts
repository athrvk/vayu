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
 * definitions - including `LINUX_DATA_HOME`, the root the rest hang off - and
 * asserts the TypeScript computes the same paths from them. Nothing here may
 * hardcode a path segment the shell also spells: a constant the test invents is
 * a hole in the guard, since both sides of the assertion would keep using it
 * after `install.sh` moved on.
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

/**
 * Expand the shell syntax these definitions actually use: `$NAME`, `${NAME}`
 * and `${NAME:-default}`, the last nestable because `LINUX_DATA_HOME` nests it
 * (`${XDG_DATA_HOME:-${HOME:-}/.local/share}`). An unset name expands empty, as
 * the shell does - a definition that leans on a variable this test does not
 * supply collapses to a path `resolveStampPath` cannot match, which fails.
 */
function expand(value: string, vars: Record<string, string>): string {
	let out = "";
	let i = 0;
	while (i < value.length) {
		const dollar = value.indexOf("$", i);
		if (dollar === -1) return out + value.slice(i);
		out += value.slice(i, dollar);

		if (value[dollar + 1] === "{") {
			const close = closingBrace(value, dollar + 1);
			out += expandBraced(value.slice(dollar + 2, close), vars);
			i = close + 1;
			continue;
		}

		const bare = /^\w+/.exec(value.slice(dollar + 1));
		if (!bare) throw new Error(`install.sh uses shell syntax this test cannot read: ${value}`);
		out += vars[bare[0]] ?? "";
		i = dollar + 1 + bare[0].length;
	}
	return out;
}

/** The index of the `}` closing the `{` at `open`, counting nested braces. */
function closingBrace(value: string, open: number): number {
	let depth = 0;
	for (let i = open; i < value.length; i++) {
		if (value[i] === "{") depth++;
		else if (value[i] === "}" && --depth === 0) return i;
	}
	throw new Error(`unbalanced \${...} in install.sh: ${value}`);
}

/** The inside of a `${...}`, which is either a name or `name:-default`. */
function expandBraced(body: string, vars: Record<string, string>): string {
	let depth = 0;
	for (let i = 0; i < body.length; i++) {
		if (body[i] === "{") depth++;
		else if (body[i] === "}") depth--;
		else if (depth === 0 && body[i] === ":" && body[i + 1] === "-") {
			const set = vars[body.slice(0, i)];
			// `:-` takes the default when unset *or* empty, which is why
			// `${HOME:-}` in install.sh yields "" rather than an unexpanded name.
			return set ? set : expand(body.slice(i + 2), vars);
		}
	}
	return vars[body] ?? "";
}

/** Every path in the Linux layout, as install.sh computes it for one shell env. */
function layoutFor(shellEnv: Record<string, string>) {
	const vars: Record<string, string> = { ...shellEnv };
	for (const name of [
		"LINUX_DATA_HOME",
		"LINUX_APP_DIR",
		"LINUX_APP_BIN",
		"LINUX_VERSION_FILE",
	]) {
		vars[name] = expand(shellValue(name), vars);
	}
	return vars;
}

const home = "/home/tester";
const xdg = "/home/tester/xdg-data";

/**
 * Scanned rather than supplied, because `LINUX_APP_BIN` is
 * `$LINUX_APP_DIR/${APP_NAME}.AppImage`: a test-invented `APP_NAME` would keep
 * expanding to today's name after install.sh renamed it, still match the
 * `Vayu.AppImage` that `appimage-stamp.ts` hardcodes, and leave this guard green
 * while the installer wrote a differently named binary.
 *
 * HOME and XDG_DATA_HOME stay invented - they are the shell's environment, not
 * install.sh's definitions, and each case exists to pick one of their branches.
 */
const appName = shellValue("APP_NAME");

/**
 * Both halves of `LINUX_DATA_HOME`'s `${XDG_DATA_HOME:-...}`. Each case names
 * the shell environment and the `resolveStampPath` environment together, so a
 * scenario cannot describe one side of the duplication and not the other.
 */
const cases = [
	{
		what: "with XDG_DATA_HOME unset, so the layout falls back to $HOME",
		shell: { APP_NAME: appName, HOME: home },
		app: { platform: "linux", home },
		expectedDataHome: `${home}/.local/share`,
	},
	{
		what: "with XDG_DATA_HOME set, which the installer honours",
		shell: { APP_NAME: appName, HOME: home, XDG_DATA_HOME: xdg },
		app: { platform: "linux", home, xdgDataHome: xdg },
		expectedDataHome: xdg,
	},
] as const;

describe("the Linux layout, as install.sh defines it", () => {
	it("scans definitions rather than nothing", () => {
		// Without this the regexes above could quietly match empty strings and
		// every assertion below would compare "" to "" and pass.
		expect(installer.length).toBeGreaterThan(1000);
		expect(shellValue("LINUX_DATA_HOME")).toContain("XDG_DATA_HOME");
		expect(appName).not.toBe("");
		const linux = layoutFor(cases[0].shell);
		expect(linux.LINUX_DATA_HOME).toBe(`${home}/.local/share`);
		expect(linux.LINUX_APP_DIR).toContain("/vayu");
		// A pin, not an invented constant: only one side of this comparison is
		// scanned, so it fails when install.sh renames APP_NAME - which is the
		// point, since `appimage-stamp.ts` spells the same name in source.
		expect(linux.LINUX_APP_BIN).toContain("Vayu.AppImage");
		expect(linux.LINUX_VERSION_FILE).toContain("/vayu/");
	});

	describe.each(cases)("$what", ({ shell, app, expectedDataHome }) => {
		const linux = layoutFor(shell);

		it("roots the layout where the app roots it", () => {
			// The one path the test used to invent. Scanning it is what makes the
			// two assertions below able to fail when install.sh moves alone.
			expect(linux.LINUX_DATA_HOME).toBe(expectedDataHome);
		});

		it("puts the AppImage where the app expects to find itself", () => {
			// resolveStampPath only answers for the managed install, so agreeing on
			// this path is what makes the stamp get written at all.
			expect(resolveStampPath({ ...app, appImagePath: linux.LINUX_APP_BIN })).not.toBeNull();
		});

		it("puts the version stamp where the app writes it", () => {
			expect(resolveStampPath({ ...app, appImagePath: linux.LINUX_APP_BIN })).toBe(
				linux.LINUX_VERSION_FILE
			);
		});
	});
});
