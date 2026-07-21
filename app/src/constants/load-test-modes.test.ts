/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The mode vocabulary lives here and nowhere else.
 *
 * It used to live in four places and gave four answers for the same run:
 * "Iterations" in the history detail, "Fixed Iterations" in the config dialog,
 * and a raw `constant_rps` in the dashboard header, which matched on values
 * `LoadTestMode` cannot hold and fell through. The scan below is the part that
 * keeps it that way — a label copied into a component is exactly how the drift
 * started, and it is invisible in review.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { LOAD_TEST_MODES, loadTestModeLabel, loadTestModeDescription } from "./load-test-modes";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("load test mode vocabulary", () => {
	it("covers every mode the type allows", () => {
		// Mirrors `LoadTestMode` in types/domain.ts. Listed literally rather than
		// derived, so adding a mode to the union fails here until it gets words.
		expect(LOAD_TEST_MODES.map((m) => m.value)).toEqual([
			"constant_rps",
			"constant_concurrency",
			"iterations",
			"ramp_up",
		]);
	});

	it("gives every mode a label and a description", () => {
		for (const mode of LOAD_TEST_MODES) {
			expect(mode.label, mode.value).toBeTruthy();
			expect(mode.description, mode.value).toBeTruthy();
		}
	});

	it("humanises a mode it does not know, rather than showing the raw token", () => {
		// Runs come back from storage and from the engine; a newer engine sending
		// a mode this build has never heard of should still read as a name.
		expect(loadTestModeLabel("some_future_mode")).toBe("Some future mode");
		expect(loadTestModeLabel(undefined)).toBe("");
		expect(loadTestModeDescription("some_future_mode")).toBe("");
	});

	it("is the only place the labels are written", () => {
		const labels = LOAD_TEST_MODES.map((m) => m.label);
		const offences: string[] = [];

		const files = globSync("**/*.{ts,tsx}", { cwd: srcRoot }).filter(
			(f) =>
				!f.includes("load-test-modes") &&
				!f.includes(".test.") &&
				!f.includes("__snapshots__")
		);
		expect(files.length, "scan matched nothing").toBeGreaterThan(100);

		for (const file of files) {
			const source = readFileSync(join(srcRoot, file), "utf8");
			// Strip comments: several files legitimately *discuss* the names.
			const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
			for (const label of labels) {
				if (code.includes(`"${label}"`) || code.includes(`>${label}<`)) {
					offences.push(`${relative(".", file)} hardcodes "${label}"`);
				}
			}
		}

		expect(offences.join("\n")).toBe("");
	});
});
