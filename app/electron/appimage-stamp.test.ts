/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The stamp is install.sh's only way to know which version is installed on
 * Linux, so the two failure directions are asymmetric. Not writing it costs one
 * redundant 160MB download. Writing it from the *wrong* process - an AppImage
 * someone is trying out of ~/Downloads - tells the installer that the managed
 * install is a version it is not, and that survives until something corrects it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveStampPath, stampInstalledVersion, writeVersionStamp } from "./appimage-stamp.js";

let root: string;

beforeEach(() => {
	// Forward slashes even on Windows: resolveStampPath computes the Linux
	// layout with posix semantics, and Node's fs accepts either separator - so
	// one root can serve both the path arithmetic and the real writes below.
	root = mkdtempSync(path.join(tmpdir(), "vayu-stamp-")).replace(/\\/g, "/");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const managed = (home: string) => path.posix.join(home, ".local", "share", "vayu", "Vayu.AppImage");

describe("resolveStampPath", () => {
	it("points beside the AppImage install.sh manages", () => {
		expect(
			resolveStampPath({ platform: "linux", appImagePath: managed(root), home: root })
		).toBe(path.posix.join(root, ".local", "share", "vayu", "version"));
	});

	it("follows XDG_DATA_HOME, as the installer does", () => {
		const xdg = path.join(root, "data");
		expect(
			resolveStampPath({
				platform: "linux",
				appImagePath: path.join(xdg, "vayu", "Vayu.AppImage"),
				xdgDataHome: xdg,
				home: root,
			})
		).toBe(path.posix.join(xdg, "vayu", "version"));
	});

	it("declines for an AppImage running from anywhere else", () => {
		// Trying a build out of ~/Downloads must not rewrite the record of what
		// is installed - that would send the installer's next run to the wrong
		// conclusion about a copy this process is not.
		expect(
			resolveStampPath({
				platform: "linux",
				appImagePath: path.join(root, "Downloads", "Vayu.AppImage"),
				home: root,
			})
		).toBeNull();
	});

	it.each([
		["a .deb or development run, with no AppImage", { platform: "linux", home: "/home/x" }],
		[
			"macOS, which reads the bundle's own Info.plist",
			{ platform: "darwin", home: "/Users/x" },
		],
		["Windows", { platform: "win32", home: "C:\\Users\\x" }],
		["no home to resolve", { platform: "linux", appImagePath: "/x/Vayu.AppImage" }],
	])("declines for %s", (_label, env) => {
		expect(resolveStampPath(env)).toBeNull();
	});
});

describe("writeVersionStamp", () => {
	it("creates the stamp, directory and all", async () => {
		const stamp = path.join(root, ".local", "share", "vayu", "version");
		await expect(writeVersionStamp(stamp, "1.2.3")).resolves.toBe(true);
		// Trailing newline: install.sh trims whitespace when reading, and a bare
		// value is awkward to inspect with cat.
		expect(readFileSync(stamp, "utf8")).toBe("1.2.3\n");
	});

	it("leaves an already-correct stamp alone", async () => {
		const dir = path.join(root, "vayu");
		mkdirSync(dir, { recursive: true });
		const stamp = path.join(dir, "version");
		writeFileSync(stamp, "1.2.3\n");
		await expect(writeVersionStamp(stamp, "1.2.3")).resolves.toBe(false);
	});

	it("overwrites the version the installer wrote before a silent update", async () => {
		const dir = path.join(root, "vayu");
		mkdirSync(dir, { recursive: true });
		const stamp = path.join(dir, "version");
		writeFileSync(stamp, "1.2.3\n");
		await expect(writeVersionStamp(stamp, "1.3.0")).resolves.toBe(true);
		expect(readFileSync(stamp, "utf8")).toBe("1.3.0\n");
	});

	it("gives up quietly when the path cannot be written", async () => {
		// A read-only home or a directory that is really a file is a reason to
		// skip, not a reason to interfere with startup.
		const blocker = path.join(root, "blocked");
		writeFileSync(blocker, "not a directory");
		await expect(writeVersionStamp(path.join(blocker, "version"), "1.2.3")).resolves.toBe(
			false
		);
	});
});

describe("stampInstalledVersion", () => {
	it("writes for the managed install", async () => {
		await expect(
			stampInstalledVersion(
				{ platform: "linux", appImagePath: managed(root), home: root },
				"2.0.0"
			)
		).resolves.toBe(true);
		expect(
			readFileSync(path.posix.join(root, ".local", "share", "vayu", "version"), "utf8")
		).toBe("2.0.0\n");
	});

	it("writes nothing at all on macOS", async () => {
		await expect(
			stampInstalledVersion({ platform: "darwin", home: root }, "2.0.0")
		).resolves.toBe(false);
	});
});
