/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The data-driven runs page is where a user learns that a CSV cell is text
 * unless **Read numbers as numbers** is on, and that Newman's
 * `--csv-auto-parse` casts more than Vayu does (issue #2540). Nothing else in
 * the app states that difference, so a rewrite of the page that drops it
 * leaves no test red. This scans text: it holds the two claims to the page, not
 * their truth, which the cast rule's own tests cover.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DOC_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";

const [DATA_DRIVEN_RUNS_DOC] = DOC_READING_GUARDS.dataFileReading.paths;

// The page is hand-wrapped prose; collapse whitespace so a reflow that changes
// no words cannot quiet the guard.
const doc = readFileSync(fromRepoRoot(DATA_DRIVEN_RUNS_DOC), "utf8").replace(/\s+/g, " ");

describe("what the data-driven runs page says about reading numbers", () => {
	it("read the page, and it was not empty", () => {
		expect(doc.length).toBeGreaterThan(500);
	});

	it("says where the option the picker shows is turned on", () => {
		expect(doc).toMatch(
			/\*\*Read numbers as numbers\*\* checkbox sits in the picker's preview card/
		);
	});

	it("says Newman's reading is looser than Vayu's", () => {
		expect(doc).toMatch(/Newman's `--csv-auto-parse`/);
		expect(doc).toMatch(/Newman is looser/);
	});
});
