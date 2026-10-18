/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { ENGINE_NO_ANSWER } from "./engine-error-text";

describe("ENGINE_NO_ANSWER", () => {
	it("names Vayu's engine rather than a bare 'the engine'", () => {
		expect(ENGINE_NO_ANSWER.startsWith("Vayu's engine")).toBe(true);
		expect(ENGINE_NO_ANSWER).not.toMatch(/\bthe engine\b/i);
	});

	it("gives a next step and stays free of 'Please'", () => {
		expect(ENGINE_NO_ANSWER).toContain("Restart Vayu");
		expect(ENGINE_NO_ANSWER).not.toMatch(/please/i);
	});
});
