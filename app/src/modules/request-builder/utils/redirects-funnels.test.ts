/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache License, Version 2.0
 * found in the LICENSE file in the "app" directory of this source tree.
 */

/**
 * Both response funnels carry the redirect hops the send followed (issue #2461).
 *
 * `execute-mapping.ts` reads `/execute`'s `redirects`, which the engine always
 * sends (`[]` when nothing was followed); `restore-response.ts` reads
 * `trace.response.redirects`, which `build_result_trace` writes only when
 * non-empty. `receivedRedirects` makes an empty list an absent one, so the same
 * exchange builds the same `ResponseState` either way.
 */

import { describe, expect, it } from "vitest";

import type { RedirectHop, SanityResult } from "@/types";
import { responseFromExecuteResult } from "./execute-mapping";
import { responseFromRunResult, type RunResultSample } from "./restore-response";

const HOPS: RedirectHop[] = [
	{
		status: 302,
		statusText: "Found",
		headerLines: [
			{ name: "Set-Cookie", value: "hop=1; Path=/" },
			{ name: "Location", value: "/next" },
		],
		url: "https://api.example.com/start?token=",
		schemeDowngrade: true,
	},
	{
		status: 301,
		statusText: "Moved Permanently",
		headerLines: [],
		url: "http://api.example.com/next",
		schemeDowngrade: false,
	},
];

const executeResult = (node: Record<string, unknown> = {}): SanityResult =>
	({
		status: 200,
		statusText: "OK",
		headers: { "content-type": "text/plain" },
		headerLines: [{ name: "Content-Type", value: "text/plain" }],
		redirects: HOPS,
		body: null,
		bodyRaw: "hello",
		bodySize: 5,
		...node,
	}) as unknown as SanityResult;

const runResult = (responseNode: Record<string, unknown> = {}): RunResultSample =>
	({
		timestamp: 1_700_000_000_000,
		statusCode: 200,
		statusText: "OK",
		latencyMs: 12,
		trace: {
			request: { method: "GET", url: "https://api.example.com/pets", headers: {} },
			response: {
				status: 200,
				headers: { "content-type": "text/plain" },
				headerLines: [{ name: "Content-Type", value: "text/plain" }],
				redirects: HOPS,
				body: "hello",
				...responseNode,
			},
		},
	}) as unknown as RunResultSample;

describe("fixture guard", () => {
	it("holds hops that carry a cookie, so parity compares something", () => {
		expect(HOPS.length).toBeGreaterThan(0);
		expect(HOPS[0].headerLines.some((l) => l.name === "Set-Cookie")).toBe(true);
	});

	it("holds both values of the downgrade flag and a url on every hop (#2949)", () => {
		expect(HOPS.map((h) => h.schemeDowngrade)).toEqual([true, false]);
		expect(HOPS.every((h) => !!h.url)).toBe(true);
	});
});

describe("the live funnel", () => {
	it("carries the engine's hops in order", () => {
		expect(responseFromExecuteResult(executeResult()).redirects).toEqual(HOPS);
	});

	it("leaves them absent for an engine too old to send the key", () => {
		expect(
			responseFromExecuteResult(executeResult({ redirects: undefined })).redirects
		).toBeUndefined();
	});

	it("reads the engine's [] for a send that followed nothing as absent", () => {
		expect(
			responseFromExecuteResult(executeResult({ redirects: [] })).redirects
		).toBeUndefined();
	});
});

describe("the restore funnel", () => {
	it("reads the hops off the stored trace", () => {
		expect(responseFromRunResult(runResult())?.redirects).toEqual(HOPS);
	});

	it("leaves them absent for a row stored before the key or one that followed nothing", () => {
		expect(
			responseFromRunResult(runResult({ redirects: undefined }))?.redirects
		).toBeUndefined();
	});

	it("leaves them absent for a request that never reached a server", () => {
		const failed = runResult();
		failed.trace = { ...failed.trace!, response: undefined, error_type: "timeout" };
		expect(responseFromRunResult(failed)?.redirects).toBeUndefined();
	});
});

describe("funnel parity", () => {
	it("agrees on a send that followed redirects", () => {
		const live = responseFromExecuteResult(executeResult());
		const restored = responseFromRunResult(runResult());
		expect(restored?.redirects).toEqual(live.redirects);
		expect(live.redirects).toEqual(HOPS);
	});

	it("agrees on a send that followed none: live [] against a stored absence", () => {
		const live = responseFromExecuteResult(executeResult({ redirects: [] }));
		const restored = responseFromRunResult(runResult({ redirects: undefined }));
		expect(restored?.redirects).toEqual(live.redirects);
		expect(live.redirects).toBeUndefined();
	});

	it("leaves the final response's own headers as the last hop's alone", () => {
		const live = responseFromExecuteResult(executeResult());
		const restored = responseFromRunResult(runResult());
		expect(live.headerLines).toEqual(restored?.headerLines);
		expect(live.headerLines).toEqual([{ name: "Content-Type", value: "text/plain" }]);
	});
});
