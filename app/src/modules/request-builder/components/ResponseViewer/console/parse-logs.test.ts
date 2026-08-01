/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Turning the engine's console output into what the panel renders.
 *
 * Two shapes reach this decoder. The structured one carries the script and the
 * `console.*` level as fields. The bare-string one is what a pre-structured
 * engine sent: the script encoded as a `"[pre] "` prefix, and no level at all -
 * which is why `console.error` used to look exactly like `console.log`.
 *
 * The legacy edges below are kept rather than deleted with the format: they are
 * still reachable against an older sidecar, and they were only ever visible by
 * rendering the Console tab and reading its sections.
 */

import { describe, it, expect } from "vitest";
import { parseConsoleLogs, splitBySource } from "./parse-logs";

describe("structured entries", () => {
	it("keeps the level the script called", () => {
		expect(
			parseConsoleLogs([
				{ source: "pre", level: "error", message: "boom" },
				{ source: "test", level: "warn", message: "careful" },
			])
		).toEqual([
			{ source: "pre", level: "error", message: "boom" },
			{ source: "test", level: "warn", message: "careful" },
		]);
	});

	it("reads a level it has never heard of as `log` rather than dropping the line", () => {
		// What a *newer* engine would send. A line the panel refuses to draw is
		// worse than one drawn in the plain tone.
		const [entry] = parseConsoleLogs([
			{ source: "test", level: "trace" as "log", message: "still shown" },
		]);
		expect(entry).toEqual({ source: "test", level: "log", message: "still shown" });
	});

	it("does not treat a `[pre] ` message as a prefix", () => {
		// The whole reason the source became a field: this line is from the test
		// script and merely happens to start with those six characters.
		expect(parseConsoleLogs([{ source: "test", level: "log", message: "[pre] x" }])).toEqual([
			{ source: "test", level: "log", message: "[pre] x" },
		]);
	});
});

describe("the pre-structured string shape", () => {
	it("reads the engine's prefix and strips it", () => {
		expect(parseConsoleLogs(["[pre] setting a token"])).toEqual([
			{ source: "pre", level: "log", message: "setting a token" },
		]);
	});

	it("treats an unprefixed line as the test script", () => {
		expect(parseConsoleLogs(["assertion passed"])).toEqual([
			{ source: "test", level: "log", message: "assertion passed" },
		]);
	});

	it("strips the prefix once, not every occurrence", () => {
		// A pre-request script that logs the string "[pre] " itself. Stripping
		// globally would eat the payload.
		expect(parseConsoleLogs(["[pre] echo: [pre] x"])).toEqual([
			{ source: "pre", level: "log", message: "echo: [pre] x" },
		]);
	});

	it("needs the prefix at the start, not merely present", () => {
		expect(parseConsoleLogs(["result was [pre] shaped"])).toEqual([
			{ source: "test", level: "log", message: "result was [pre] shaped" },
		]);
	});

	it("keeps an empty line rather than dropping it", () => {
		// `console.log()` with no argument is a real thing a script does, and a
		// vanished line is worse than a blank one.
		expect(parseConsoleLogs(["[pre] ", ""])).toEqual([
			{ source: "pre", level: "log", message: "" },
			{ source: "test", level: "log", message: "" },
		]);
	});

	it("preserves order within the array", () => {
		const parsed = parseConsoleLogs(["[pre] a", "b", "[pre] c"]);
		expect(parsed.map((l) => l.message)).toEqual(["a", "b", "c"]);
	});

	it("mixes with structured entries in one array", () => {
		// Not a shape the engine sends, but the decoder is per-entry and saying so
		// is cheaper than reasoning about it later.
		const parsed = parseConsoleLogs([
			"[pre] old",
			{ source: "test", level: "warn", message: "new" },
		]);
		expect(parsed.map((l) => l.level)).toEqual(["log", "warn"]);
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
