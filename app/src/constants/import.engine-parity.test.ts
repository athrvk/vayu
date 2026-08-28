/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The streamed-fetch event names, held on both sides (issue #882).
 *
 * This drift is silent by construction, which is why it needs a guard: an SSE
 * event whose name the reader does not recognize is an event the reader
 * *skips*. Rename `EVENT_PROGRESS` engine-side and nothing throws - the download
 * runs, the frames arrive, and the bar sits at zero for the whole of it, because
 * every one of them falls through a chain of `===` that no longer matches.
 *
 * Read out of the engine's own header rather than restated here, which is what
 * makes this a drift guard instead of a second copy of the same list: move
 * either side and it fails.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENGINE_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import { IMPORT_FETCH_EVENTS } from "./import";

/** Held in the testkit, so CI routes an edit to the header back to this suite. */
const [CONSTANTS_HPP] = ENGINE_READING_GUARDS.importEvents.paths.map(fromRepoRoot);
const constantsHpp = readFileSync(CONSTANTS_HPP, "utf8");

/** One `constexpr const char* NAME = "value";` from the engine header. */
function engineString(name: string): string {
	const match = constantsHpp.match(
		new RegExp(`constexpr\\s+const\\s+char\\*\\s+${name}\\s*=\\s*"([^"]*)"\\s*;`)
	);
	if (!match) throw new Error(`constants.hpp declares no const char* ${name}`);
	return match[1];
}

describe("streamed import-fetch events match the engine", () => {
	it("reads the engine's own names, so the scan is not vacuous", () => {
		// The regex above returns nothing for a header that moved, and "nothing"
		// would make every assertion below pass against an empty string.
		expect(engineString("EVENT_PROGRESS")).not.toBe("");
	});

	it.each([
		["EVENT_PROGRESS", IMPORT_FETCH_EVENTS.PROGRESS],
		["EVENT_RESULT", IMPORT_FETCH_EVENTS.RESULT],
		["EVENT_ERROR", IMPORT_FETCH_EVENTS.ERROR],
	])("%s", (engineName, rendererValue) => {
		expect(engineString(engineName)).toBe(rendererValue);
	});
});
