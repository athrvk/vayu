/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The status line the Raw tab prints for a response.
 *
 * Before this, `buildRawResponse` hardcoded `HTTP/1.1` regardless of what was
 * actually negotiated - the last place in the app that stated a protocol it
 * never verified. It now takes the negotiated protocol as a display string
 * (`ResponseState.httpVersion` / `RunResultTrace.response.httpVersion`) and
 * defaults to `HTTP/1.1` only when the caller supplies nothing, so callers
 * that predate this field keep working unchanged.
 */

import { describe, it, expect } from "vitest";
import { buildRawResponse } from "./utils";

describe("buildRawResponse", () => {
	it("prints the negotiated protocol in the status line when given one", () => {
		const raw = buildRawResponse(200, "OK", {}, "");

		expect(raw).toBe("HTTP/1.1 200 OK\r\n\r\n");
	});

	it("prints HTTP/2 when that is what negotiated", () => {
		const raw = buildRawResponse(200, "OK", { "content-type": "text/plain" }, "hi", "HTTP/2");

		expect(raw).toBe("HTTP/2 200 OK\r\ncontent-type: text/plain\r\n\r\nhi");
	});

	it("defaults to HTTP/1.1 when no version is supplied", () => {
		expect(buildRawResponse(404, "Not Found", {}, "")).toMatch(/^HTTP\/1\.1 404 Not Found\r\n/);
	});

	/**
	 * "" is the engine's convention for "nothing was negotiated" - a client
	 * error before any response arrived. Same reasoning as buildRawRequest:
	 * this formatter only ever sees a display string, never the requested
	 * protocol, so it cannot replicate the engine's requested-version fallback
	 * and instead collapses to the same HTTP/1.1 default as an omitted
	 * argument rather than printing a blank version token.
	 */
	it("falls back to HTTP/1.1 when the empty string says nothing was negotiated", () => {
		expect(buildRawResponse(0, "", {}, "", "")).toMatch(/^HTTP\/1\.1 0 \r\n/);
	});
});
