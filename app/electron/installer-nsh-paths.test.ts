/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The directories the Windows uninstaller deletes (issue #1393).
 *
 * `installer.nsh` once named a directory the app had never written, so
 * "Delete everything" ran `RMDir /r` over nothing and every saved request
 * survived an uninstall the user was told erased it. A wrong `RMDir /r` reports
 * nothing either way, which is why the defect stood.
 *
 * The app names its directory itself (`USER_DATA_DIR_NAME`). NSIS cannot read
 * `constants.ts`, so the name is spelled in both files and the duplication is
 * guarded rather than trusted: the define drifting from the name, a raw path
 * bypassing the define, and the directory left out of the delete.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { USER_DATA_DIR_NAME } from "./constants.js";

const here = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(join(here, "..", "installer", "installer.nsh"), "utf8");

/**
 * Every `%APPDATA%` / `$LOCALAPPDATA` reference in the script, with the path
 * segment that follows it. Both the NSIS variable form (`$APPDATA\`) and the
 * environment form a comment uses (`%APPDATA%\`) are matched, because the
 * header comment is where the wrong directory was asserted first.
 */
function appDataSegments(): string[] {
	return [...script.matchAll(/[$%](?:LOCAL)?APPDATA%?\\([^\s"\\]*)/g)].map((match) => match[1]);
}

/** Every `!macro NAME ... !macroend` block in the script, by name. */
function macros(): [string, string][] {
	return [...script.matchAll(/^!macro (\w+)\b([\s\S]*?)^!macroend$/gm)].map((match) => [
		match[1],
		match[2],
	]);
}

describe("the Windows installer's data directory", () => {
	it("is the directory the app names", () => {
		const define = /^!define APP_DATA_DIR "([^"]*)"$/m.exec(script);
		expect(define, "installer.nsh no longer defines APP_DATA_DIR").not.toBeNull();
		expect(define?.[1]).toBe(USER_DATA_DIR_NAME);
	});

	it("is reached only through that define, never a spelled-out path", () => {
		const segments = appDataSegments();
		expect(segments.length).toBeGreaterThan(0);
		for (const segment of segments) {
			expect(segment).toBe("${APP_DATA_DIR}");
		}
	});

	/** A wrong-`RMDir` shape is silent, as in #1393. Mutation check: drop the `RMDir`. */
	it("deletes the directory when the user asks for everything gone", () => {
		expect(script).toMatch(/RMDir \/r "\$APPDATA\\\$\{APP_DATA_DIR\}"/);
	});

	/**
	 * The same defect in its second shape. An all-users install leaves NSIS in
	 * the machine shell context, where `$APPDATA` is not the profile Electron
	 * writes userData to - so a correctly named path still misses the real
	 * directory unless the context is flipped back for the duration.
	 */
	it("is read in the user's shell context by every macro that touches it", () => {
		const reading = macros().filter(([, body]) => body.includes("$APPDATA"));
		expect(reading.length).toBeGreaterThan(0);
		for (const [name, body] of reading) {
			expect(body, `${name} reads $APPDATA outside the user's shell context`).toContain(
				"!insertmacro useUserShellContext"
			);
			expect(body, `${name} leaves the shell context flipped`).toContain(
				"!insertmacro restoreShellContext"
			);
		}
	});
});

/**
 * A silent install or uninstall (winget, an unattended reinstall) has nobody
 * to answer a `MessageBox` - NSIS does not suppress a raw `MessageBox` under
 * `/S` on its own, so an unguarded one blocks an unattended update forever on
 * a dialog nobody can see. Every macro that raises one must check `IfSilent`
 * first and skip straight to its default answer (issue #1662): close the
 * running app without asking in `customInit`, and keep the user's data without
 * asking in `customUnInstall`.
 *
 * Mutation check: delete either `IfSilent` line and the corresponding case
 * below reds, because the macro body no longer contains it ahead of its
 * `MessageBox`.
 */
describe("a silent install or uninstall never blocks on a MessageBox", () => {
	function macroBody(name: string): string {
		const [match] = macros().filter(([macroName]) => macroName === name);
		expect(match, `installer.nsh has no ${name} macro`).toBeDefined();
		return match![1];
	}

	it.each([
		["customInit", "closeApp"],
		["customUnInstall", "keepData"],
	])("%s checks IfSilent before its MessageBox, defaulting to %s", (name, silentTarget) => {
		const body = macroBody(name);
		// The real instruction, not a mention of the word in a comment above it
		// (this file's own explanatory comments say "MessageBox" ahead of the
		// line that raises one).
		const messageBoxAt = body.search(/^\s*MessageBox\s+MB_/m);
		const ifSilentAt = body.indexOf("IfSilent");
		expect(messageBoxAt, `${name} has no MessageBox instruction`).toBeGreaterThan(-1);
		expect(ifSilentAt, `${name} raises a MessageBox with no IfSilent guard`).toBeGreaterThan(
			-1
		);
		expect(ifSilentAt, `${name}'s IfSilent guard runs after its MessageBox`).toBeLessThan(
			messageBoxAt
		);
		const ifSilentLine = body.slice(ifSilentAt, body.indexOf("\n", ifSilentAt));
		expect(ifSilentLine).toContain(silentTarget);
	});
});

/**
 * electron-updater's `quitAndInstall()` is not silent: it launches the installer
 * with `--updated` while the app is still in its before-quit shutdown (renderer
 * save flush, then the engine's graceful exit). `customInit` must not prompt,
 * kill or delete the lock on that launch, or it cuts the shutdown short
 * (issue #1882); electron-builder's `CHECK_APP_RUNNING` waits for the app.
 *
 * Mutation check: delete the `${If} ${isUpdated}` guard (or point its `Goto`
 * at a label above the `MessageBox`) and each case below reds.
 */
describe("an updated launch leaves the running app to electron-builder", () => {
	const [, body] = macros().find(([name]) => name === "customInit") ?? ["", ""];
	const guard = /^\s*\$\{If\} \$\{isUpdated\}\s*\n\s*Goto (\w+)\s*\n\s*\$\{EndIf\}$/m.exec(body);
	const skipTarget = guard ? body.indexOf(`\n  ${guard[1]}:`) : -1;

	/** The instructions a launch with `--updated` must jump over. */
	const skipped: [string, RegExp][] = [
		["the running-app MessageBox", /^\s*MessageBox\s+MB_/m],
		["the Vayu.exe taskkill", /^\s*nsExec::ExecToStack 'taskkill [^']*Vayu\.exe/m],
		[
			"the orphaned-engine taskkill",
			/^\s*nsExec::ExecToStack 'taskkill [^']*vayu-engine\.exe/m,
		],
		["the stale-lock Delete", /^\s*Delete\s+"[^"]*vayu\.lock"/m],
	];

	it("guards customInit with ${If} ${isUpdated} that jumps to a label ending the macro", () => {
		expect(body.length, "installer.nsh has no customInit body").toBeGreaterThan(0);
		expect(
			guard,
			"customInit has no `${If} ${isUpdated}` / Goto / `${EndIf}` guard"
		).not.toBeNull();
		expect(skipTarget, `customInit never defines the label ${guard?.[1]}`).toBeGreaterThan(-1);
		expect(body.slice(skipTarget).trim()).toBe(`${guard?.[1]}:`);
	});

	it.each(skipped)("jumps over %s", (_what, instruction) => {
		const at = body.search(instruction);
		expect(
			at,
			"the instruction is gone from customInit, so this guard checks nothing"
		).toBeGreaterThan(-1);
		expect(guard?.index ?? Infinity, "the guard runs after it").toBeLessThan(at);
		expect(skipTarget, "the guard's target is above it").toBeGreaterThan(at);
	});
});
