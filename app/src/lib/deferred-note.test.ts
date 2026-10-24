/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { deferredNote, deferredTokens } from "./deferred-note";

describe("deferredNote", () => {
	it("speaks of one name in the singular", () => {
		expect(deferredNote(["token"])).toBe("{{token}} is set by a pre-request script at send.");
	});

	it("speaks of several in the plural", () => {
		expect(deferredNote(["host", "token"])).toBe(
			"{{host}}, {{token}} are set by a pre-request script at send."
		);
	});
});

describe("deferredTokens", () => {
	it("writes each name as a {{name}} token, in order, comma separated", () => {
		expect(deferredTokens(["host", "token"])).toBe("{{host}}, {{token}}");
	});

	it("writes one name with no separator", () => {
		expect(deferredTokens(["token"])).toBe("{{token}}");
	});

	it("writes nothing for no names", () => {
		expect(deferredTokens([])).toBe("");
	});
});
