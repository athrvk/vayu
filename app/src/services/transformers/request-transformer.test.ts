/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The redirect policy has to survive the load chain, and its riskiest hop is
 * this one: `followRedirects` / `maxRedirects` are new columns, so every request
 * saved before they existed comes back from `GET /requests` without them. Read
 * naively, `raw.followRedirects ?? false` or a bare `raw.maxRedirects` would
 * turn every pre-existing request into "do not follow" / "zero hops" - the
 * opposite of how it behaved yesterday.
 */

import { describe, expect, it } from "vitest";
import { RequestTransformer } from "./request-transformer";
import { DEFAULT_FOLLOW_REDIRECTS, DEFAULT_MAX_REDIRECTS } from "@/constants/request";

const base = {
	id: "req_1",
	collectionId: "col_1",
	name: "Example",
	method: "GET",
	url: "https://example.com",
	createdAt: 1_700_000_000_000,
	updatedAt: 1_700_000_000_000,
};

describe("RequestTransformer redirect policy", () => {
	it("defaults a row that predates the columns to the engine defaults", () => {
		const req = RequestTransformer.toFrontend({ ...base });
		expect(req.followRedirects).toBe(DEFAULT_FOLLOW_REDIRECTS);
		expect(req.maxRedirects).toBe(DEFAULT_MAX_REDIRECTS);
	});

	it("preserves a stored non-default policy", () => {
		const req = RequestTransformer.toFrontend({
			...base,
			followRedirects: false,
			maxRedirects: 2,
		});
		expect(req.followRedirects).toBe(false);
		expect(req.maxRedirects).toBe(2);
	});

	it("keeps a stored maxRedirects of 0 rather than treating it as absent", () => {
		// `?? DEFAULT` is correct here but `|| DEFAULT` is not: 0 is falsy and a
		// legitimate value (follow nothing, but still report the 3xx).
		const req = RequestTransformer.toFrontend({ ...base, maxRedirects: 0 });
		expect(req.maxRedirects).toBe(0);
	});

	it("clamps a stored value outside the range the engine accepts", () => {
		expect(RequestTransformer.toFrontend({ ...base, maxRedirects: 9999 }).maxRedirects).toBe(
			100
		);
		expect(RequestTransformer.toFrontend({ ...base, maxRedirects: -1 }).maxRedirects).toBe(0);
	});

	it("falls back when the stored value is not a number", () => {
		const req = RequestTransformer.toFrontend({ ...base, maxRedirects: "ten" });
		expect(req.maxRedirects).toBe(DEFAULT_MAX_REDIRECTS);
	});
});
