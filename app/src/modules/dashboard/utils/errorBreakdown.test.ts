/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { errorBreakdown } from "./errorBreakdown";

describe("errorBreakdown", () => {
	it("passes the engine's split through", () => {
		expect(errorBreakdown(17, 15, 2)).toEqual({ httpErrors: 15, noResponse: 2 });
	});

	it("derives the HTTP errors from the total when only No response is known", () => {
		// A tick stored by an older engine: a zero here would read as "none of
		// these errors were HTTP ones" beside a non-zero rate.
		expect(errorBreakdown(17, undefined, 2)).toEqual({ httpErrors: 15, noResponse: 2 });
	});

	it("reads a total with no split as all HTTP errors", () => {
		expect(errorBreakdown(15, undefined, undefined)).toEqual({ httpErrors: 15, noResponse: 0 });
	});

	it("never goes negative on a split larger than the total", () => {
		expect(errorBreakdown(1, undefined, 3)).toEqual({ httpErrors: 0, noResponse: 3 });
	});
});
