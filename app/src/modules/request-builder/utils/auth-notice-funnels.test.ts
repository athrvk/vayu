/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache License, Version 2.0
 * found in the LICENSE file in the "app" directory of this source tree.
 */

/**
 * Both response funnels carry the engine's `authNotice` (issue #2474).
 *
 * The live `/execute` body has it at the top level and the stored trace on
 * `trace.request`; both are written by one engine function, and `ResponseState`
 * is built from them by `execute-mapping.ts` and `restore-response.ts`, a copy
 * pair a field has gone missing from before. The key is absent when there is
 * nothing to say, on both sides.
 */

import { describe, expect, it } from "vitest";

import type { SanityResult } from "@/types";
import { responseFromExecuteResult } from "./execute-mapping";
import { responseFromRunResult, type RunResultSample } from "./restore-response";

const NOTICE =
	"auth mode 'ntlm' is not executed by Vayu; the request was sent without authentication";

const executeResult = (authNotice?: string): SanityResult =>
	({
		status: 401,
		statusText: "Unauthorized",
		headers: {},
		body: "",
		bodyRaw: "",
		bodySize: 0,
		...(authNotice === undefined ? {} : { authNotice }),
	}) as unknown as SanityResult;

const runResult = (authNotice?: string): RunResultSample =>
	({
		timestamp: 1_700_000_000_000,
		statusCode: 401,
		statusText: "Unauthorized",
		latencyMs: 12,
		trace: {
			request: {
				method: "GET",
				url: "https://api.example.com/pets/1",
				headers: {},
				...(authNotice === undefined ? {} : { authNotice }),
			},
			response: { status: 401, headers: {}, body: "" },
		},
	}) as unknown as RunResultSample;

/** A transfer that never reached a server: no `response` node, only an error. */
const failedRunResult = (authNotice: string): RunResultSample =>
	({
		timestamp: 1_700_000_000_000,
		statusCode: 0,
		statusText: "Error",
		latencyMs: 3,
		trace: {
			request: {
				method: "GET",
				url: "https://api.example.com/pets/1",
				headers: {},
				authNotice,
			},
			error_type: "ConnectionError",
			error_message: "refused",
		},
	}) as unknown as RunResultSample;

describe("the live funnel", () => {
	it("carries the notice", () => {
		expect(responseFromExecuteResult(executeResult(NOTICE)).authNotice).toBe(NOTICE);
	});

	it("leaves it absent when the engine sent none", () => {
		expect(responseFromExecuteResult(executeResult()).authNotice).toBeUndefined();
	});

	it("reads an empty string as absent, so no empty banner is drawn", () => {
		expect(responseFromExecuteResult(executeResult("")).authNotice).toBeUndefined();
	});
});

describe("the restore funnel", () => {
	it("carries the notice from the trace's request node", () => {
		expect(responseFromRunResult(runResult(NOTICE))?.authNotice).toBe(NOTICE);
	});

	it("leaves it absent when the trace carries none", () => {
		expect(responseFromRunResult(runResult())?.authNotice).toBeUndefined();
	});

	it("carries it on a failed exchange, which has no response node at all", () => {
		expect(responseFromRunResult(failedRunResult(NOTICE))?.authNotice).toBe(NOTICE);
	});
});

describe("funnel parity", () => {
	it("says the same thing live and restored", () => {
		const live = responseFromExecuteResult(executeResult(NOTICE));
		const restored = responseFromRunResult(runResult(NOTICE));
		expect(restored?.authNotice).toEqual(live.authNotice);
		expect(live.authNotice).toBe(NOTICE);
	});

	it("agrees that no notice is no notice", () => {
		const live = responseFromExecuteResult(executeResult());
		const restored = responseFromRunResult(runResult());
		expect(restored?.authNotice).toEqual(live.authNotice);
		expect(live.authNotice).toBeUndefined();
	});
});
