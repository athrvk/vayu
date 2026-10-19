/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache License, Version 2.0
 * found in the LICENSE file in the "app" directory of this source tree.
 */

/**
 * Both response funnels name the request lines libcurl added (issue #2464).
 *
 * The pair `validation-funnels.test.ts` guards, with one asymmetry that is the
 * point here: a restored row can hold no wire frame, and the funnel then
 * fabricates one for the Raw tab with `buildRawRequest`, a `Host` and a
 * `Content-Length` included. The group must read only a frame the engine
 * recorded, or an old row would list lines the engine never reported.
 */

import { describe, expect, it } from "vitest";

import type { SanityResult } from "@/types";
import { responseFromExecuteResult } from "./execute-mapping";
import { responseFromRunResult, type RunResultSample } from "./restore-response";

const SENT = { "Content-Type": "text/plain", "User-Agent": "vayu/1" };
const FRAME =
	"POST /pets HTTP/1.1\r\n" +
	"Host: api.example.com\r\n" +
	"User-Agent: vayu/1\r\n" +
	"Accept: */*\r\n" +
	"Content-Type: text/plain\r\n" +
	"Content-Length: 5\r\n" +
	"Cookie: sid=abc\r\n" +
	"\r\n" +
	"hello";
const ADDED = { Host: "api.example.com", Accept: "*/*", "Content-Length": "5", Cookie: "sid=abc" };

const executeResult = (overrides: Record<string, unknown> = {}): SanityResult =>
	({
		status: 200,
		statusText: "OK",
		headers: {},
		body: "",
		bodyRaw: "",
		bodySize: 0,
		requestHeaders: SENT,
		rawRequest: FRAME,
		...overrides,
	}) as unknown as SanityResult;

const runResult = (request: Record<string, unknown> = {}, withResponse = true): RunResultSample =>
	({
		timestamp: 1_700_000_000_000,
		statusCode: withResponse ? 200 : 0,
		statusText: "OK",
		latencyMs: 12,
		trace: {
			request: {
				method: "POST",
				url: "https://api.example.com/pets",
				headers: SENT,
				body: "hello",
				sentHeaders: SENT,
				rawRequest: FRAME,
				...request,
			},
			...(withResponse
				? { response: { status: 200, headers: {}, body: "" } }
				: { error_type: "ConnectionFailed", error_message: "refused" }),
		},
	}) as unknown as RunResultSample;

describe("the libcurl group across both funnels", () => {
	it("is the same for the same exchange, live and restored", () => {
		const live = responseFromExecuteResult(executeResult());
		const restored = responseFromRunResult(runResult());

		expect(live.libcurlHeaders).toEqual(ADDED);
		expect(restored?.libcurlHeaders).toEqual(live.libcurlHeaders);
	});

	it("is absent on a restored row with no recorded frame, though the Raw tab is fabricated", () => {
		const restored = responseFromRunResult(runResult({ rawRequest: undefined }));

		// The fabricated frame carries lines the group would list if it read it.
		expect(restored?.rawRequest).toContain("Host: api.example.com");
		expect(restored?.rawRequest).toContain("Content-Length: 5");
		expect(restored?.libcurlHeaders).toBeUndefined();
	});

	it("is absent on a restored row whose recorded frame is empty", () => {
		expect(
			responseFromRunResult(runResult({ rawRequest: "" }))?.libcurlHeaders
		).toBeUndefined();
	});

	it("is absent when the exchange failed, live and restored", () => {
		const live = responseFromExecuteResult(executeResult({ status: 0, errorCode: "TIMEOUT" }));
		const restored = responseFromRunResult(runResult({}, false));

		expect(live.libcurlHeaders).toBeUndefined();
		expect(restored?.libcurlHeaders).toBeUndefined();
	});

	it("is absent on both when libcurl added nothing", () => {
		const frame = "GET / HTTP/1.1\r\nUser-Agent: vayu/1\r\n\r\n";
		const live = responseFromExecuteResult(executeResult({ rawRequest: frame }));
		const restored = responseFromRunResult(runResult({ rawRequest: frame }));

		expect(live.libcurlHeaders).toBeUndefined();
		expect(restored?.libcurlHeaders).toBeUndefined();
	});

	it("measures a restored row against the sent record, not the composed headers", () => {
		// `headers` is the composed request; `sentHeaders` is what went out, and it
		// is the one the group subtracts - `Content-Type` is in neither list here.
		const restored = responseFromRunResult(runResult({ headers: {}, sentHeaders: SENT }));

		expect(restored?.libcurlHeaders).toEqual(ADDED);
	});
});
