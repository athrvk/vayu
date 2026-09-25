/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The data directory moved from `<appData>/vayu-client` to `<appData>/Vayu`.
 * What must hold for an existing user: their directory is moved whole on the
 * first launch that finds it, nothing is ever moved over a directory that is
 * already in use, and a move that fails leaves them on their data rather than
 * on an empty one. Driven against real directories, because what a rename does
 * to a tree on disk is the whole question.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveUserDataDirectory } from "./user-data-dir.js";
import { APP_NAME, LEGACY_USER_DATA_DIR_NAME, USER_DATA_DIR_NAME } from "./constants.js";

let appData = "";
beforeEach(() => {
	appData = mkdtempSync(join(tmpdir(), "vayu-user-data-"));
});
afterEach(() => {
	rmSync(appData, { recursive: true, force: true });
});

const current = () => join(appData, USER_DATA_DIR_NAME);
const legacy = () => join(appData, LEGACY_USER_DATA_DIR_NAME);

/** A directory as an install leaves it: a workspace database and a settings file. */
function seedInstall(dir: string, marker: string): void {
	mkdirSync(join(dir, "db"), { recursive: true });
	writeFileSync(join(dir, "db", "vayu.db"), marker);
	writeFileSync(join(dir, "window-state.json"), JSON.stringify({ marker }));
}

describe("the data directory", () => {
	it("is named for the product, and was named for the npm package before", () => {
		expect(USER_DATA_DIR_NAME).toBe(APP_NAME);
		expect(USER_DATA_DIR_NAME).toBe("Vayu");
		// What every release up to 0.36 wrote - changing it would strand them.
		expect(LEGACY_USER_DATA_DIR_NAME).toBe("vayu-client");
	});

	it("moves an existing install's directory whole on the first launch", () => {
		seedInstall(legacy(), "user-workspace");

		const resolved = resolveUserDataDirectory(appData);

		expect(resolved).toEqual({ path: current(), outcome: "migrated" });
		expect(existsSync(legacy())).toBe(false);
		expect(readFileSync(join(current(), "db", "vayu.db"), "utf8")).toBe("user-workspace");
		expect(existsSync(join(current(), "window-state.json"))).toBe(true);
	});

	it("uses the new directory on every launch after that", () => {
		seedInstall(legacy(), "user-workspace");
		resolveUserDataDirectory(appData);

		expect(resolveUserDataDirectory(appData)).toEqual({ path: current(), outcome: "current" });
	});

	it("starts a fresh install in the new directory without creating anything", () => {
		// Creating it is Chromium's and the engine's job; a resolver that made
		// the directory would turn a later legacy find into a "both".
		expect(resolveUserDataDirectory(appData)).toEqual({ path: current(), outcome: "fresh" });
		expect(existsSync(current())).toBe(false);
	});

	it("never moves the old directory over one that is already in use", () => {
		// A launch already ran from the new directory, so it may hold the newer
		// data; merging or overwriting would destroy one of the two. Mutation
		// check: drop the `hasCurrent` early return and this test's rename
		// either throws or replaces the current workspace.
		seedInstall(current(), "newer-workspace");
		seedInstall(legacy(), "older-workspace");

		expect(resolveUserDataDirectory(appData)).toEqual({ path: current(), outcome: "both" });
		expect(readFileSync(join(current(), "db", "vayu.db"), "utf8")).toBe("newer-workspace");
		expect(readFileSync(join(legacy(), "db", "vayu.db"), "utf8")).toBe("older-workspace");
	});

	it("stays on the old directory for this launch when the move fails", () => {
		// Windows refuses to rename a directory with a file open in it - an
		// engine left running by a crash, say. An empty workspace is the
		// outcome this must never produce; the move is retried next launch.
		seedInstall(legacy(), "user-workspace");
		const resolved = resolveUserDataDirectory(appData, {
			exists: (target) => existsSync(target),
			rename: () => {
				throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
			},
		});

		expect(resolved.path).toBe(legacy());
		expect(resolved.outcome).toBe("kept-legacy");
		expect(resolved.error).toContain("EBUSY");
		expect(readFileSync(join(legacy(), "db", "vayu.db"), "utf8")).toBe("user-workspace");
	});

	it("follows a move another launch made between the check and the rename", () => {
		seedInstall(legacy(), "user-workspace");
		const resolved = resolveUserDataDirectory(appData, {
			exists: (target) => existsSync(target),
			rename: (from, to) => {
				// The other launch wins the race; this one's rename then fails.
				rmSync(to, { recursive: true, force: true });
				mkdirSync(to, { recursive: true });
				rmSync(from, { recursive: true, force: true });
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			},
		});

		expect(resolved).toEqual({ path: current(), outcome: "current" });
	});
});
