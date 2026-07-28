/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Splitting one flat log array back into the two scripts that wrote it.
 *
 * The engine runs both scripts in one QuickJS context and returns their output
 * as one array, prefixing pre-request lines with `"[pre] "`. This was inline in
 * `ConsoleOutput`, so the edges below were reachable only by rendering the tab
 * and reading its sections - which is how a log whose own text begins with
 * `[pre]` would have gone unnoticed.
 */

import { describe, it, expect } from "vitest";
import { parseConsoleLogs, splitBySource } from "./parse-logs";

describe("which script a line came from", () => {
	it("reads the engine's prefix and strips it", () => {
		expect(parseConsoleLogs(["[pre] setting a token"])).toEqual([
			{ source: "pre", message: "setting a token" },
		]);
	});

	it("treats an unprefixed line as the test script", () => {
		expect(parseConsoleLogs(["assertion passed"])).toEqual([
			{ source: "test", message: "assertion passed" },
		]);
	});

	it("strips the prefix once, not every occurrence", () => {
		// A pre-request script that logs the string "[pre] " itself. Stripping
		// globally would eat the payload.
		expect(parseConsoleLogs(["[pre] echo: [pre] x"])).toEqual([
			{ source: "pre", message: "echo: [pre] x" },
		]);
	});

	it("needs the prefix at the start, not merely present", () => {
		expect(parseConsoleLogs(["result was [pre] shaped"])).toEqual([
			{ source: "test", message: "result was [pre] shaped" },
		]);
	});

	it("keeps an empty line rather than dropping it", () => {
		// `console.log()` with no argument is a real thing a script does, and a
		// vanished line is worse than a blank one.
		expect(parseConsoleLogs(["[pre] ", ""])).toEqual([
			{ source: "pre", message: "" },
			{ source: "test", message: "" },
		]);
	});

	it("preserves order within the array", () => {
		const parsed = parseConsoleLogs(["[pre] a", "b", "[pre] c"]);
		expect(parsed.map((l) => l.message)).toEqual(["a", "b", "c"]);
	});
});

describe("splitting into the two sections", () => {
	it("puts each line under its own source, in order", () => {
		const split = splitBySource(parseConsoleLogs(["[pre] a", "b", "[pre] c", "d"]));
		expect(split.pre.map((l) => l.message)).toEqual(["a", "c"]);
		expect(split.test.map((l) => l.message)).toEqual(["b", "d"]);
	});

	it("returns both keys even when one side is empty", () => {
		// The panel renders `bySource.pre` unconditionally; an absent key would
		// be a crash rather than an empty section.
		const split = splitBySource(parseConsoleLogs(["only a test log"]));
		expect(split.pre).toEqual([]);
		expect(split.test).toHaveLength(1);
	});

	it("loses nothing", () => {
		const logs = ["[pre] a", "b", "c", "[pre] d"];
		const split = splitBySource(parseConsoleLogs(logs));
		expect(split.pre.length + split.test.length).toBe(logs.length);
	});
});
