/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A size named for its job must survive being composed with a text colour.
 *
 * `text-<x>` is either a font size or a text colour, and tailwind-merge tells
 * them apart from the list of size labels it ships - so a *custom* step is read
 * as a colour and dropped when a colour follows it. `text-hero` disappeared out
 * of `HeroCardShell`'s `cn("text-hero ...", "text-foreground")` exactly that
 * way, leaving the dashboard's largest number at body size with nothing in the
 * source to look wrong (#1409).
 *
 * The cases below are the app's real compositions. `text-md` and `text-sm` are
 * here as the control: they always survived, which is why the defect did not
 * show up when the scale gained its title step.
 */

import { describe, it, expect } from "vitest";
import { cn } from "./utils";

describe("cn keeps a custom font size beside a text colour", () => {
	it.each([
		// HeroCardShell: the size is in the base, the colour in the caller's.
		["text-hero", "text-hero font-bold leading-none font-mono tabular-nums", "text-foreground"],
		// PerformanceTab's percentile value, whose colour is conditional.
		["text-metric", "text-metric font-bold", "text-destructive-text"],
		// CardTitle with a caller that tints it, and body text - the controls.
		["text-md", "text-md font-semibold leading-none tracking-tight", "text-destructive-text"],
		["text-sm", "text-sm", "text-foreground"],
	])("%s", (step, base, caller) => {
		expect(cn(base, caller).split(" ")).toContain(step);
	});

	it("still lets one size replace another", () => {
		// The merge has to keep doing its job: a caller naming a size wins, which
		// is what makes the primitives' steps overridable at all.
		expect(cn("text-hero font-bold", "text-metric")).toBe("font-bold text-metric");
		expect(cn("text-md", "text-sm")).toBe("text-sm");
	});
});
