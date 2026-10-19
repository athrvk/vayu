/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache License, Version 2.0
 * found in the LICENSE file in the "app" directory of this source tree.
 */

/**
 * Both response funnels carry the header lines as received (issue #2460).
 *
 * `execute-mapping.ts` reads `/execute`'s `headerLines`, which the engine
 * always sends; `restore-response.ts` reads `trace.response.headerLines`,
 * which `build_result_trace` writes only when there were lines. The rule that
 * makes the two agree is `receivedHeaderLines`: an empty list is an absent
 * one. Without it a response with no headers is `[]` live and `undefined`
 * restored. Absence is also what the Cookies tab reads as "this answer
 * predates the lines", so neither funnel fills it in from the folded map.
 */

import { describe, expect, it } from "vitest";

import type { SanityResult } from "@/types";
import { responseFromExecuteResult } from "./execute-mapping";
import { responseFromRunResult, type RunResultSample } from "./restore-response";

const LINES = [
	{ name: "Content-Type", value: "text/plain" },
	{ name: "X-Dup", value: "one" },
	{ name: "x-dup", value: "two" },
	{ name: "Set-Cookie", value: "a=1; Path=/" },
	{ name: "Set-Cookie", value: "b=2; Expires=Wed, 21 Oct 2015 07:28:00 GMT" },
];

const FOLDED = {
	"content-type": "text/plain",
	"x-dup": "one, two",
	"set-cookie": "a=1; Path=/, b=2; Expires=Wed, 21 Oct 2015 07:28:00 GMT",
};

const executeResult = (node: Record<string, unknown> = {}): SanityResult =>
	({
		status: 200,
		statusText: "OK",
		headers: FOLDED,
		headerLines: LINES,
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
				headers: FOLDED,
				headerLines: LINES,
				body: "hello",
				...responseNode,
			},
		},
	}) as unknown as RunResultSample;

describe("fixture guard", () => {
	it("holds a name that repeats, in two cases, and a folded map that loses both", () => {
		// The parity below compares fixtures to themselves if these were
		// ordinary: a single-case unique name survives the folding.
		expect(LINES.filter((l) => l.name.toLowerCase() === "x-dup")).toHaveLength(2);
		expect(LINES.filter((l) => l.name === "Set-Cookie")).toHaveLength(2);
		expect(Object.keys(FOLDED)).toHaveLength(3);
		expect(LINES.length).toBeGreaterThan(Object.keys(FOLDED).length);
	});
});

describe("the live funnel", () => {
	it("carries the engine's lines in order, as received", () => {
		expect(responseFromExecuteResult(executeResult()).headerLines).toEqual(LINES);
	});

	it("leaves them absent for an engine too old to send the key", () => {
		const live = responseFromExecuteResult(executeResult({ headerLines: undefined }));
		expect(live.headerLines).toBeUndefined();
		expect(live.headers).toEqual(FOLDED);
	});

	it("reads the engine's [] for a response with no headers as absent", () => {
		const live = responseFromExecuteResult(executeResult({ headers: {}, headerLines: [] }));
		expect(live.headerLines).toBeUndefined();
	});
});

describe("the restore funnel", () => {
	it("reads the lines off the stored trace", () => {
		expect(responseFromRunResult(runResult())?.headerLines).toEqual(LINES);
	});

	it("leaves them absent for a row stored before the key", () => {
		const restored = responseFromRunResult(runResult({ headerLines: undefined }));
		expect(restored?.headerLines).toBeUndefined();
		expect(restored?.headers).toEqual(FOLDED);
	});

	it("leaves them absent for a request that never reached a server", () => {
		const failed = runResult();
		failed.trace = { ...failed.trace!, response: undefined, error_type: "timeout" };
		expect(responseFromRunResult(failed)?.headerLines).toBeUndefined();
	});
});

describe("funnel parity", () => {
	it("agrees on a response with repeated headers", () => {
		const live = responseFromExecuteResult(executeResult());
		const restored = responseFromRunResult(runResult());
		expect(restored?.headerLines).toEqual(live.headerLines);
		expect(live.headerLines).toEqual(LINES);
	});

	it("agrees when the answer predates the key on both sides", () => {
		const live = responseFromExecuteResult(executeResult({ headerLines: undefined }));
		const restored = responseFromRunResult(runResult({ headerLines: undefined }));
		expect(restored?.headerLines).toEqual(live.headerLines);
		expect(live.headerLines).toBeUndefined();
	});

	it("agrees on a response with no headers: live [] against a stored absence", () => {
		const live = responseFromExecuteResult(executeResult({ headers: {}, headerLines: [] }));
		const restored = responseFromRunResult(runResult({ headers: {}, headerLines: undefined }));
		expect(restored?.headerLines).toBeUndefined();
		expect(live.headerLines).toBeUndefined();
	});

	it("leaves the folded map as it was beside the lines", () => {
		const live = responseFromExecuteResult(executeResult());
		const restored = responseFromRunResult(runResult());
		expect(live.headers).toEqual(FOLDED);
		expect(restored?.headers).toEqual(FOLDED);
	});
});
