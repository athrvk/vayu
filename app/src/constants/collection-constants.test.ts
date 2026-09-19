/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * "Folder" is the user-facing word (issue #1689) - the tree row's icon is a
 * folder glyph, and the menu action is "Add Folder", so a default name that
 * still said "Sub Collection" was the one place the old word survived.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_COLLECTION_NAME, DEFAULT_FOLDER_NAME } from "./collection";

describe("collection naming constants", () => {
	it('DEFAULT_FOLDER_NAME contains no "Sub Collection"', () => {
		expect(DEFAULT_FOLDER_NAME).not.toMatch(/sub ?collection/i);
		expect(DEFAULT_FOLDER_NAME).toBe("New Folder");
	});

	it("DEFAULT_COLLECTION_NAME is unaffected", () => {
		expect(DEFAULT_COLLECTION_NAME).toBe("New Collection");
	});

	// Source-scanning guard, not just the two constants above: the phrase can
	// resurface in a menu label or a toast without ever touching this file.
	// Asserts it actually scanned something, per this repo's mutation-check
	// rule for guards.
	it("the phrase is gone from app/src", () => {
		const root = join(__dirname, "..");
		const offenders: string[] = [];
		let filesScanned = 0;

		const walk = (dir: string) => {
			for (const entry of readdirSync(dir)) {
				if (entry === "node_modules") continue;
				const full = join(dir, entry);
				const stat = statSync(full);
				if (stat.isDirectory()) {
					walk(full);
					continue;
				}
				if (!/\.(ts|tsx)$/.test(entry) || /\.test\.(ts|tsx)$/.test(entry)) continue;
				filesScanned++;
				const contents = readFileSync(full, "utf8");
				// Matches the acceptance-criteria regex exactly: a bare hyphenated
				// "sub-collection" is ordinary English for a nested collection and
				// stays; "Sub Collection"/"SubCollection" was the drifted name.
				if (/sub ?collection/i.test(contents)) {
					offenders.push(full);
				}
			}
		};
		walk(root);

		expect(filesScanned).toBeGreaterThan(50);
		expect(offenders).toEqual([]);
	});
});
