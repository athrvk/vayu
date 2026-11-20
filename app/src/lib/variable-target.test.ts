/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { variableTargetOf } from "./variable-target";

describe("variableTargetOf", () => {
	it("names the singleton for a global, with or without an id", () => {
		expect(variableTargetOf({ scope: "global" })).toEqual({ scope: "global" });
		expect(variableTargetOf({ scope: "global", sourceId: "x" })).toEqual({ scope: "global" });
	});

	it.each(["collection", "environment"] as const)("names the %s by its sourceId", (scope) => {
		expect(variableTargetOf({ scope, sourceId: "abc" })).toEqual({ scope, id: "abc" });
	});

	it.each(["collection", "environment"] as const)("is null for a %s with no id", (scope) => {
		expect(variableTargetOf({ scope })).toBeNull();
	});
});
