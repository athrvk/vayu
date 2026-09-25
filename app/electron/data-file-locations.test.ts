/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The main process's copy of the remembered data-file paths (issue #1742):
 * what a published payload may put in it, and that the channel between the
 * renderer and the MCP server is wired end to end.
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

import { DataFileLocations, normalizeDataFileLocations } from "./data-file-locations.js";

const ABSOLUTE = path.resolve("/data/users.csv");

describe("normalizeDataFileLocations", () => {
	it("keeps an absolute path the read channel would open", () => {
		const locations = normalizeDataFileLocations({
			col_1: { path: ABSOLUTE, fileName: "users.csv" },
		});
		expect(locations.get("col_1")).toEqual({ path: ABSOLUTE, fileName: "users.csv" });
	});

	it.each([
		["a relative path", { path: "users.csv", fileName: "users.csv" }],
		[
			"an extension dataFile:read refuses",
			{ path: path.resolve("/home/me/.ssh/id_rsa"), fileName: "id_rsa" },
		],
		["a non-string path", { path: 42, fileName: "users.csv" }],
		["a missing file name", { path: ABSOLUTE }],
		["null", null],
	])("drops %s", (_label, entry) => {
		expect(normalizeDataFileLocations({ col_1: entry }).size).toBe(0);
	});

	it.each([[null], [[]], ["col_1"], [undefined]])(
		"answers nothing for a payload of %j",
		(payload) => {
			expect(normalizeDataFileLocations(payload).size).toBe(0);
		}
	);
});

describe("DataFileLocations", () => {
	it("replaces the whole copy on each publish, so a cleared entry is gone", () => {
		const store = new DataFileLocations();
		store.replace({ col_1: { path: ABSOLUTE, fileName: "users.csv" } });
		expect(store.get("col_1")?.path).toBe(ABSOLUTE);
		store.replace({});
		expect(store.get("col_1")).toBeUndefined();
	});
});

describe("the wiring", () => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const main = readFileSync(path.join(here, "main.ts"), "utf8");
	const preload = readFileSync(path.join(here, "preload.ts"), "utf8");

	it("sends and receives on the same channel", () => {
		expect(preload).toContain('ipcRenderer.send("dataFile:locations"');
		expect(main).toContain('ipcMain.on("dataFile:locations"');
	});

	it("hands the copy to the MCP service, which is its only reader", () => {
		// Written but never read is the defect this guards: a copy main holds
		// and no MCP context is given is a path no agent ever sees.
		expect(main).toContain(
			"dataFileLocation: (collectionId) => dataFileLocations.get(collectionId)"
		);
	});
});
