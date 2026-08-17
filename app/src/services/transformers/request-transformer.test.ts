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
import {
	DEFAULT_FOLLOW_REDIRECTS,
	DEFAULT_HTTP_VERSION,
	DEFAULT_MAX_REDIRECTS,
	DEFAULT_VERIFY_SSL,
} from "@/constants/request";

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

	it("reads a row with no verifySSL as verifying", () => {
		// The same hop, and the one where the wrong default is a security
		// decision: every request stored before the column existed comes back
		// without the key, and must not read as "accept any certificate"
		// (issue #706).
		expect(RequestTransformer.toFrontend({ ...base }).verifySSL).toBe(DEFAULT_VERIFY_SSL);
	});

	it("preserves a stored verifySSL of false", () => {
		expect(RequestTransformer.toFrontend({ ...base, verifySSL: false }).verifySSL).toBe(false);
	});

	it("ignores a non-boolean verifySSL rather than coercing it", () => {
		// `"false"` is truthy, so a coercing read would turn a corrupted row
		// into a verifying one silently - the reason every field here checks
		// the type rather than the value.
		expect(RequestTransformer.toFrontend({ ...base, verifySSL: "false" }).verifySSL).toBe(
			DEFAULT_VERIFY_SSL
		);
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

/**
 * `httpVersion` is a new column, same story as the redirect policy above: a
 * row written before this feature existed - or by a newer engine with a
 * protocol this app does not know about - must not surface as a value the
 * request-builder can't render or send back unchanged.
 */
describe("RequestTransformer httpVersion coercion", () => {
	it("keeps a valid stored value", () => {
		const req = RequestTransformer.toFrontend({ ...base, httpVersion: "http2" });
		expect(req.httpVersion).toBe("http2");
	});

	it("falls back to auto for a value outside the domain", () => {
		// A row written by a newer engine version, or a corrupted one.
		const req = RequestTransformer.toFrontend({ ...base, httpVersion: "http3" });
		expect(req.httpVersion).toBe(DEFAULT_HTTP_VERSION);
	});

	it("falls back to auto when the field is absent", () => {
		const req = RequestTransformer.toFrontend({ ...base });
		expect(req.httpVersion).toBe(DEFAULT_HTTP_VERSION);
	});
});

/**
 * `specOperation` is the request half of the binding (issue #637). The engine
 * serializes `null` for a request that names none - the key is always present -
 * so the common case is a non-object arriving here, and it has to leave as an
 * absent key rather than as `null`, which no reader here checks for.
 */
describe("RequestTransformer spec operation", () => {
	it("carries an identity through, operationId and all", () => {
		const req = RequestTransformer.toFrontend({
			...base,
			specOperation: { operationId: "getPet", method: "GET", path: "/pets/{petId}" },
		});
		expect(req.specOperation).toEqual({
			operationId: "getPet",
			method: "GET",
			path: "/pets/{petId}",
		});
	});

	it("keeps an identity that declares no operationId", () => {
		const req = RequestTransformer.toFrontend({
			...base,
			specOperation: { method: "POST", path: "/pets" },
		});
		expect(req.specOperation).toEqual({ method: "POST", path: "/pets" });
	});

	it("reads the engine's null as no operation, with the key absent", () => {
		const req = RequestTransformer.toFrontend({ ...base, specOperation: null });
		expect("specOperation" in req).toBe(false);
	});

	it("drops a half-written identity rather than passing one with no path", () => {
		// Every later diff keys off method *and* path; an identity missing one is
		// not an identity, and matching on it would name the wrong operation.
		for (const bad of [{ method: "GET" }, { path: "/pets" }, { method: "", path: "/pets" }]) {
			const req = RequestTransformer.toFrontend({ ...base, specOperation: bad });
			expect(req.specOperation).toBeUndefined();
		}
	});
});
