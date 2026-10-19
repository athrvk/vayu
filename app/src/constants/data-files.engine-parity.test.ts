/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The nesting bound a data cell is refused at, held on both sides (#2362).
 *
 * Drift here is silent in one direction and loud in the other: a picker bound
 * above the engine's accepts a file whose run then dies on its first iteration,
 * and one below it refuses a file the engine would have run. The bound is read
 * out of the engine's own header rather than restated, so moving either side
 * fails this.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENGINE_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import { DATA_FILE_MAX_NESTING } from "./data-files";

/** Held in the testkit, so CI routes an edit to the header back to this suite. */
const [CONSTANTS_HPP] = ENGINE_READING_GUARDS.dataFileNesting.paths.map(fromRepoRoot);
const constantsHpp = readFileSync(CONSTANTS_HPP, "utf8");

describe("data cell nesting bound matches the engine", () => {
	it("reads the engine header, so the scan is not vacuous", () => {
		expect(constantsHpp).not.toBe("");
	});

	it("MAX_READ_DEPTH", () => {
		const match = constantsHpp.match(/constexpr\s+size_t\s+MAX_READ_DEPTH\s*=\s*(\d+)\s*;/);
		expect(match, "constants.hpp declares no size_t MAX_READ_DEPTH").not.toBeNull();
		expect(DATA_FILE_MAX_NESTING).toBe(Number(match![1]));
	});
});
