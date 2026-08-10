/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `resolveMode` is a funnel every mode-adaptive component reads through, and
 * its failure mode is silent: an unrecognised mode is *normalised*, not
 * rejected, so a mode missing from `KNOWN_MODES` renders the constant_rps
 * dashboard and looks merely wrong rather than broken.
 *
 * That is exactly what happened to `capacity` - it reached the union, the
 * profile picker and both mode-adaptive rows while this set still listed four
 * modes, leaving every `case "capacity"` arm downstream unreachable. The first
 * test below is the guard that makes a repeat impossible: it walks the shipped
 * vocabulary rather than a list written here, so a mode added to
 * `LOAD_TEST_MODES` and forgotten here fails without anyone thinking to add a
 * case.
 */

import { describe, expect, it } from "vitest";
import { LOAD_TEST_MODES } from "@/constants/load-test-modes";
import { resolveMode } from "./useMode";

describe("resolveMode", () => {
	it("resolves every shipped mode to itself", () => {
		// Non-empty first: a guard that iterates an empty list passes forever.
		expect(LOAD_TEST_MODES.length).toBeGreaterThan(0);
		for (const mode of LOAD_TEST_MODES) {
			expect(resolveMode(mode.value), mode.value).toBe(mode.value);
		}
	});

	it("keeps capacity distinct from the open-loop default", () => {
		// The specific regression: `capacity` is closed-loop and adaptive, and
		// falling back to `constant_rps` hands it Target-RPS hero cards for a
		// target it never had.
		expect(resolveMode("capacity")).toBe("capacity");
	});

	it("falls back to constant_rps for a mode it does not know", () => {
		// Runs predating explicit mode tagging, and runs from a newer sidecar.
		expect(resolveMode(undefined)).toBe("constant_rps");
		expect(resolveMode("")).toBe("constant_rps");
		expect(resolveMode("some_future_mode")).toBe("constant_rps");
	});
});
