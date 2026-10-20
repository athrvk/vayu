/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache License, Version 2.0
 * found in the LICENSE file in the "app" directory of this source tree.
 */

/**
 * Both response funnels carry the request's own header lines as sent (issue
 * #2466).
 *
 * `execute-mapping.ts` reads `/execute`'s `requestHeaderLines`, which the
 * engine always sends; `restore-response.ts` reads
 * `trace.request.sentHeaderLines`, which it stores whenever the transfer sent
 * any and which a row from before the key lacks. `sentHeaderLines` makes an
 * empty list an absent one so the two build the same state, and neither funnel
 * derives lines from the folded record: a derived line looks exactly like a
 * received one.
 */

import { describe, expect, it } from "vitest";

import type { SanityResult } from "@/types";
import { responseFromExecuteResult } from "./execute-mapping";
import { responseFromRunResult, type RunResultSample } from "./restore-response";

const LINES = [
	{ name: "X-Dup", value: "one" },
	{ name: "x-dup", value: "two" },
	{ name: "X-Dup", value: "three" },
	{ name: "User-Agent", value: "vayu/1" },
];
const FOLDED = { "X-Dup": "one, two, three", "User-Agent": "vayu/1" };

const executeResult = (overrides: Record<string, unknown> = {}): SanityResult =>
	({
		status: 200,
		statusText: "OK",
		headers: {},
		body: "",
		bodyRaw: "",
		bodySize: 0,
		requestHeaders: FOLDED,
		requestHeaderLines: LINES,
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
				method: "GET",
				url: "https://api.example.com/",
				headers: FOLDED,
				sentHeaders: FOLDED,
				sentHeaderLines: LINES,
				...request,
			},
			...(withResponse
				? { response: { status: 200, headers: {}, body: "" } }
				: { error_type: "ConnectionFailed", error_message: "refused" }),
		},
	}) as unknown as RunResultSample;

describe("fixture guard", () => {
	it("holds a name that repeats in two cases, which the folded record loses", () => {
		// The agreement below compares fixtures to themselves if these were
		// ordinary: a single-case unique name survives the folding.
		expect(LINES.filter((l) => l.name.toLowerCase() === "x-dup")).toHaveLength(3);
		expect(Object.keys(FOLDED)).toHaveLength(2);
		expect(LINES.length).toBeGreaterThan(Object.keys(FOLDED).length);
	});
});

describe("the live funnel", () => {
	it("carries the engine's lines in order, a repeat repeated", () => {
		expect(responseFromExecuteResult(executeResult()).requestHeaderLines).toEqual(LINES);
	});

	it("leaves them absent for an engine too old to send the key", () => {
		const live = responseFromExecuteResult(executeResult({ requestHeaderLines: undefined }));
		expect(live.requestHeaderLines).toBeUndefined();
		expect(live.requestHeaders).toEqual(FOLDED);
	});

	it("reads the engine's [] as absent", () => {
		const live = responseFromExecuteResult(
			executeResult({ requestHeaders: {}, requestHeaderLines: [] })
		);
		expect(live.requestHeaderLines).toBeUndefined();
	});
});

describe("the restore funnel", () => {
	it("reads the lines off the stored trace", () => {
		expect(responseFromRunResult(runResult())?.requestHeaderLines).toEqual(LINES);
	});

	it("leaves them absent for a row stored before the key, and lists the folded record", () => {
		const restored = responseFromRunResult(runResult({ sentHeaderLines: undefined }));
		expect(restored?.requestHeaderLines).toBeUndefined();
		expect(restored?.requestHeaders).toEqual(FOLDED);
	});

	it("keeps the lines for a send that never got a response", () => {
		// Not a derived value: the engine records what it was about to send, and
		// that is what the Headers tab lists when no wire frame is trusted.
		expect(responseFromRunResult(runResult({}, false))?.requestHeaderLines).toEqual(LINES);
	});
});

describe("funnel parity", () => {
	it("agrees on a request with a repeated header", () => {
		// Mutation check: drop the field from either funnel and this fails.
		const live = responseFromExecuteResult(executeResult());
		const restored = responseFromRunResult(runResult());
		expect(restored?.requestHeaderLines).toEqual(live.requestHeaderLines);
		expect(live.requestHeaderLines).toEqual(LINES);
	});

	it("agrees when the answer predates the key on both sides", () => {
		const live = responseFromExecuteResult(executeResult({ requestHeaderLines: undefined }));
		const restored = responseFromRunResult(runResult({ sentHeaderLines: undefined }));
		expect(restored?.requestHeaderLines).toEqual(live.requestHeaderLines);
		expect(live.requestHeaderLines).toBeUndefined();
	});

	it("agrees on a request that sent no lines: live [] against a stored absence", () => {
		const live = responseFromExecuteResult(executeResult({ requestHeaderLines: [] }));
		const restored = responseFromRunResult(runResult({ sentHeaderLines: undefined }));
		expect(restored?.requestHeaderLines).toEqual(live.requestHeaderLines);
		expect(live.requestHeaderLines).toBeUndefined();
	});

	it("leaves the folded record as it was beside the lines", () => {
		expect(responseFromExecuteResult(executeResult()).requestHeaders).toEqual(FOLDED);
		expect(responseFromRunResult(runResult())?.requestHeaders).toEqual(FOLDED);
	});
});
