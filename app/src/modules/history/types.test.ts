/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { RUN_TYPE_NAME } from "./types";

describe("RUN_TYPE_NAME", () => {
	it("names each run type in title case, never by its wire value", () => {
		expect(RUN_TYPE_NAME).toEqual({
			design: "Send",
			scenario: "Collection run",
			load: "Load test",
		});
	});
});
