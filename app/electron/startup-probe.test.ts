/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The startup probe writes one line, only when asked, and only where its reader
 * can find it.
 *
 * Three separable failures, one per group below: printing timings out of a
 * shipped app (the guard), reporting a number measured from somewhere else (the
 * basis), and the two ends of the marker drifting apart - `main.ts` printing one
 * string while `scripts/perf/measure-app.mjs` waits for another, which the
 * workflow would report as an unavailable startup leg rather than a wrong
 * number. `measure-app.mjs` is registered against this file in
 * `ROOT_READING_GUARDS` so an edit to it runs this suite.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	STARTUP_MARKER,
	STARTUP_MEASURE_ENV,
	reportStartupIfRequested,
	sampleStartup,
	type StartupClock,
} from "./startup-probe.js";
import { ENGINE_PORT } from "./constants.js";
import { ROOT_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";

const [measurerPath] = ROOT_READING_GUARDS.startupMarker.paths.map(fromRepoRoot);

/** A clock that answers with fixed readings, and counts nothing else. */
function fixedClock(overrides: Partial<StartupClock> = {}): StartupClock {
	return {
		now: () => 1_700_000_000_500,
		elapsedMs: () => 320,
		processCreatedAt: () => 1_700_000_000_000,
		...overrides,
	};
}

function collect(env: Record<string, string | undefined>, clock = fixedClock()) {
	const lines: string[] = [];
	const wrote = reportStartupIfRequested(env, clock, (line) => lines.push(line));
	return { lines, wrote };
}

describe("the startup probe's guard", () => {
	it("writes nothing when nothing asked", () => {
		const { lines, wrote } = collect({});
		expect(wrote).toBe(false);
		expect(lines).toEqual([]);
	});

	it("writes nothing for any value but 1", () => {
		// A measurement surface that answered to "true", "0" or "" would print
		// timings out of a shipped app on a stray environment variable.
		for (const value of ["0", "", "true", "yes", "2"]) {
			const { lines, wrote } = collect({ [STARTUP_MEASURE_ENV]: value });
			expect(wrote, `${STARTUP_MEASURE_ENV}=${value}`).toBe(false);
			expect(lines).toEqual([]);
		}
	});

	it("writes exactly one parseable line when asked", () => {
		const { lines, wrote } = collect({ [STARTUP_MEASURE_ENV]: "1" });

		expect(wrote).toBe(true);
		expect(lines).toHaveLength(1);
		expect(lines[0].startsWith(`${STARTUP_MARKER} `)).toBe(true);

		const payload = JSON.parse(lines[0].slice(STARTUP_MARKER.length));
		expect(payload).toEqual({ readyToShowMs: 500, basis: "process-creation" });
	});

	it("writes no newline of its own - the sink adds it", () => {
		// The reader is line-oriented; a payload carrying its own newline would
		// split into a marker line and an unparseable remainder.
		const { lines } = collect({ [STARTUP_MEASURE_ENV]: "1" });
		expect(lines[0]).not.toContain("\n");
	});
});

describe("what the number is measured from", () => {
	it("measures from process creation when the platform can say", () => {
		const sample = sampleStartup(fixedClock());
		expect(sample).toEqual({ readyToShowMs: 500, basis: "process-creation" });
	});

	it("falls back to the time origin, and says so", () => {
		// Electron's getCreationTime() answers null where the platform cannot
		// tell. Reporting the fallback as if it were a cold start would compare
		// numbers that start counting at different moments.
		const sample = sampleStartup(fixedClock({ processCreatedAt: () => null }));
		expect(sample).toEqual({ readyToShowMs: 320, basis: "time-origin" });
	});
});

describe("the probe's two ends", () => {
	const electronDir = dirname(fileURLToPath(import.meta.url));
	const main = readFileSync(join(electronDir, "main.ts"), "utf8");
	const measurer = readFileSync(measurerPath, "utf8");

	it("is called from the window's ready-to-show handler", () => {
		// main.ts creates windows and starts the engine at import time, so the
		// wiring can only be read - the approach startup-order.test.ts takes to
		// the same file. Without this the probe is a function nobody calls.
		const handlerAt = main.indexOf('mainWindow.once("ready-to-show"');
		expect(handlerAt).toBeGreaterThan(-1);

		const handlerEnd = main.indexOf("});", handlerAt);
		expect(handlerEnd).toBeGreaterThan(handlerAt);
		expect(main.slice(handlerAt, handlerEnd)).toContain("reportStartupIfRequested()");
	});

	it("prints the marker the perf script waits for", () => {
		const declared = /const PACKAGED_MARKER = "([^"]+)";/.exec(measurer);

		expect(declared, "measure-app.mjs no longer declares PACKAGED_MARKER").not.toBeNull();
		expect(declared?.[1]).toBe(STARTUP_MARKER);
	});

	it("is asked for it by the env var the app reads", () => {
		const declared = /const PACKAGED_MEASURE_ENV = "([^"]+)";/.exec(measurer);

		expect(declared, "measure-app.mjs no longer declares PACKAGED_MEASURE_ENV").not.toBeNull();
		expect(declared?.[1]).toBe(STARTUP_MEASURE_ENV);
	});

	it("waits on the port the sidecar would adopt an engine from", () => {
		// Between launches the script waits for the engine to stop listening,
		// because the sidecar adopts one that is still up and an adopted engine
		// is not a cold start. Watching the wrong port would wait on nothing and
		// report the adoption as a measurement.
		const declared = /const ENGINE_PORT = (\d+);/.exec(measurer);

		expect(declared, "measure-app.mjs no longer declares ENGINE_PORT").not.toBeNull();
		expect(Number(declared?.[1])).toBe(ENGINE_PORT);
	});
});
