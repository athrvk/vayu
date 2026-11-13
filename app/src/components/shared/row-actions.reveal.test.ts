/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `ROW_ACTIONS_REVEAL` collapses a control out of its row's flow and has three
 * ways back in (#3495). Each is a separate token set, so each is asserted: a
 * dropped `hover: none` half leaves a touch device with Restore and Delete
 * forever permanently collapsed, and a dropped focus half strands a keyboard
 * user on a control that is not there.
 */

import { describe, it, expect } from "vitest";
import { ROW_ACTIONS_REVEAL } from "./row-actions";

const tokens = ROW_ACTIONS_REVEAL.split(" ");

describe("ROW_ACTIONS_REVEAL", () => {
	it("is out of the flow but not out of the tab order while collapsed", () => {
		expect(tokens).toContain("absolute");
		expect(tokens).toContain("opacity-0");
		expect(tokens).toContain("pointer-events-none");
		for (const removed of ["hidden", "invisible", "sr-only"]) {
			expect(tokens, removed).not.toContain(removed);
		}
	});

	it.each([
		["hover", "group-hover"],
		["focus", "group-focus-within"],
		["a device with no hover", "[@media(hover:none)]"],
	])("returns to the flow on %s", (_name, variant) => {
		for (const utility of ["static", "opacity-100", "pointer-events-auto"]) {
			expect(tokens, `${variant}:${utility}`).toContain(`${variant}:${utility}`);
		}
	});
});
