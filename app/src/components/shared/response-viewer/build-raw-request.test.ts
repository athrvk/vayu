/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The raw request shown for a stored run.
 *
 * A live send gets this string from the engine, which builds the real wire
 * message. A restored one has to rebuild it from the four fields the trace
 * stores, and the two are read in the same tab, so the shape has to match
 * `Client::send` in engine/src/http/client.cpp:277-331.
 */

import { describe, it, expect } from "vitest";
import { buildRawRequest } from "./utils";

describe("buildRawRequest", () => {
	it("uses the path, not the whole URL, and takes Host from the URL", () => {
		expect(buildRawRequest("GET", "https://api.example.test/v1/users?page=2")).toBe(
			"GET /v1/users?page=2 HTTP/1.1\r\nHost: api.example.test\r\n\r\n"
		);
	});

	it("keeps the port, which is part of the host", () => {
		expect(buildRawRequest("GET", "http://127.0.0.1:8080/health")).toContain(
			"Host: 127.0.0.1:8080\r\n"
		);
	});

	it("gives a bare origin the root path", () => {
		expect(buildRawRequest("GET", "https://example.test")).toMatch(/^GET \/ HTTP\/1\.1\r\n/);
	});

	it("does not print Host twice when the trace already has one", () => {
		const raw = buildRawRequest("GET", "https://example.test/", {
			Host: "example.test",
			Accept: "*/*",
		});

		expect(raw.match(/^Host:/gm)).toHaveLength(1);
		expect(raw).toContain("Accept: */*\r\n");
	});

	it("adds Content-Length and the body after a blank line", () => {
		expect(buildRawRequest("POST", "https://example.test/x", {}, "hi")).toBe(
			"POST /x HTTP/1.1\r\nHost: example.test\r\nContent-Length: 2\r\n\r\nhi"
		);
	});

	it("counts Content-Length in bytes, not characters", () => {
		// The engine counts content.size(). "é" is one character and two bytes.
		expect(buildRawRequest("POST", "https://e.test/", {}, "é")).toContain(
			"Content-Length: 2\r\n"
		);
	});

	it("omits Content-Length when there is no body", () => {
		expect(buildRawRequest("GET", "https://example.test/")).not.toContain("Content-Length");
	});

	it("keeps a URL it cannot parse whole", () => {
		const raw = buildRawRequest("GET", "{{base}}/users");

		expect(raw).toBe("GET {{base}}/users HTTP/1.1\r\n\r\n");
		expect(raw).not.toContain("Host:");
	});
});
