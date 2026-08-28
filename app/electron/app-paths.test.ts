/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One data directory, three places that used to name it.
 *
 * `app:getPaths` re-derived the sidecar's dev-vs-production rule inline and
 * hardcoded the `logs`/`db` subdirectories the engine creates, so the paths
 * Settings - General shows the user were a second opinion rather than a
 * readout. Nothing would have failed on drift: the panel renders whatever it is
 * handed, and the directories it named would simply have been ones nothing
 * writes to.
 *
 * So the assertions here compare the two derivations against each other rather
 * than against expected strings - the point is that there is one source, not
 * that it currently produces a particular path. `getAppPath()` and
 * `getPath("userData")` are deliberately given different values, so a
 * re-inlined copy that reaches for the wrong one fails instead of coinciding.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";

const APP_PATH = join("/fake", "vayu", "app");
const USER_DATA = join("/fake", "userData", "vayu-client");

vi.mock("electron", () => ({
	app: {
		getAppPath: () => APP_PATH,
		getPath: (name: string) => {
			if (name !== "userData") throw new Error(`unexpected app.getPath(${name})`);
			return USER_DATA;
		},
		getVersion: () => "0.0.0-test",
	},
}));

/**
 * `isDev` is read at module load in both modules, so each mode needs a fresh
 * graph. Imported through this helper rather than at the top of the file for
 * that reason alone.
 */
async function loadForMode(mode: "development" | "production") {
	process.env.NODE_ENV = mode;
	// Only Electron sets this, and the sidecar's production binary lookup joins
	// it in its constructor - unrelated to the paths under test, but it runs.
	processWithResources.resourcesPath = join("/fake", "resources");
	vi.resetModules();
	const [{ resolveAppPaths }, { EngineSidecar, engineDataDirectory }] = await Promise.all([
		import("./app-paths"),
		import("./sidecar"),
	]);
	return { resolveAppPaths, EngineSidecar, engineDataDirectory };
}

const originalNodeEnv = process.env.NODE_ENV;
const processWithResources = process as NodeJS.Process & { resourcesPath?: string };
const originalResourcesPath = processWithResources.resourcesPath;

beforeEach(() => {
	vi.resetModules();
});

afterEach(() => {
	process.env.NODE_ENV = originalNodeEnv;
	processWithResources.resourcesPath = originalResourcesPath;
	vi.resetModules();
});

describe("app:getPaths and the sidecar share one data directory", () => {
	for (const mode of ["development", "production"] as const) {
		it(`agrees with the sidecar in ${mode}`, async () => {
			const { resolveAppPaths, EngineSidecar } = await loadForMode(mode);

			const paths = resolveAppPaths();
			const sidecarDataDir = new EngineSidecar().getDataDirectory();

			expect(paths.dataDir).toBe(sidecarDataDir);
			// Both modes must resolve somewhere; an empty agreement is not agreement.
			expect(paths.dataDir.length).toBeGreaterThan(0);
		});
	}

	it("takes the repo's engine/data in development and userData in production", async () => {
		const dev = await loadForMode("development");
		expect(dev.engineDataDirectory()).toBe(join(APP_PATH, "..", "engine", "data"));

		const prod = await loadForMode("production");
		expect(prod.engineDataDirectory()).toBe(USER_DATA);
	});

	it("puts logs and db under the data directory, and nowhere else", async () => {
		const { resolveAppPaths } = await loadForMode("production");
		const { ENGINE_LOGS_DIR, ENGINE_DB_DIR } = await import("./constants");

		const paths = resolveAppPaths();
		expect(paths.logsPath).toBe(join(paths.dataDir, ENGINE_LOGS_DIR));
		expect(paths.dbPath).toBe(join(paths.dataDir, ENGINE_DB_DIR));
		expect(paths.appDir).toBe(APP_PATH);
	});
});

describe("the logs/db names match the engine that creates them", () => {
	it("finds both constants in daemon.cpp's data-dir layout", async () => {
		const { ENGINE_LOGS_DIR, ENGINE_DB_DIR } = await import("./constants");
		// Held in the testkit, so CI routes an edit to the daemon back to this
		// suite rather than to the next unrelated change under `app/`.
		const [daemonPath] = ENGINE_READING_GUARDS.dataDirLayout.paths.map(fromRepoRoot);

		const source = readFileSync(daemonPath, "utf-8");
		// A scan that read nothing passes every assertion below it.
		expect(source.length).toBeGreaterThan(0);

		const joined = [...source.matchAll(/path_join\s*\(\s*data_dir\s*,\s*"([^"]+)"/g)].map(
			(match) => match[1]
		);
		expect(joined).not.toHaveLength(0);
		expect(joined).toContain(ENGINE_LOGS_DIR);
		expect(joined).toContain(ENGINE_DB_DIR);
	});
});
