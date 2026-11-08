/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * #3339, #3377: the response preview's sandboxed iframe starts loading too, and
 * only the main frame's `did-finish-load` releases held intents or ends a
 * renderer's cleanup. Mutation check: drop the `isMainFrame` or the
 * `isSameDocument` term and a row reddens.
 */

import { describe, it, expect } from "vitest";
import { startsMainFramePage } from "./main-frame-page";

describe("startsMainFramePage", () => {
	it.each([
		["a main-frame cross-document navigation", true, false, true],
		["a subframe navigation", false, false, false],
		["a main-frame same-document navigation", true, true, false],
		["a subframe same-document navigation", false, true, false],
	])("%s", (_name, isMainFrame, isSameDocument, expected) => {
		expect(startsMainFramePage({ isMainFrame, isSameDocument })).toBe(expected);
	});
});
