/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache License, Version 2.0
 * found in the LICENSE file in the "app" directory of this source tree.
 */

/**
 * Both response funnels say when the engine only read part of the body
 * (issue #1157).
 *
 * The same reason `validation-funnels.test.ts` and
 * `client-certificate-funnels.test.ts` exist: `execute-mapping.ts` and
 * `restore-response.ts` are a copy pair and a field added to one has gone
 * missing from the other before. What is specific here is the shape mismatch -
 * `serialize(Response)` always emits `bodyCapped` while `build_result_trace`
 * writes it only when the body was cut - so the live funnel has to normalise
 * `false` or the two disagree on every ordinary response.
 *
 * And the fact itself is one the pane must not conflate with `bodyTruncated`:
 * one is storage shortening a body that was received whole, the other is a body
 * that was never received. Both can be true of one response, which is asserted
 * here rather than left to the components.
 */

import { describe, expect, it } from "vitest";

import type { SanityResult } from "@/types";
import { responseFromExecuteResult } from "./execute-mapping";
import { responseFromRunResult, type RunResultSample } from "./restore-response";

const executeResult = (bodyCapped?: boolean): SanityResult =>
	({
		status: 200,
		statusText: "OK",
		headers: { "content-type": "application/json" },
		body: null,
		bodyRaw: '{"id":"one"',
		bodySize: 11,
		...(bodyCapped === undefined ? {} : { bodyCapped }),
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
				headers: { "content-type": "application/json" },
				body: '{"id":"one"',
				...responseNode,
			},
		},
	}) as unknown as RunResultSample;

describe("the live funnel", () => {
	it("carries the engine's cap flag", () => {
		expect(responseFromExecuteResult(executeResult(true)).bodyCapped).toBe(true);
	});

	it("normalises the engine's false to undefined", () => {
		// The engine always sends the key so a reader can tell "not capped" from
		// "this engine cannot say". The pane has nothing to show for either, and
		// the restored funnel produces `undefined` - so this one must too, or the
		// parity below is a lie.
		expect(responseFromExecuteResult(executeResult(false)).bodyCapped).toBeUndefined();
	});

	it("leaves it absent for an engine too old to send the key", () => {
		expect(responseFromExecuteResult(executeResult()).bodyCapped).toBeUndefined();
	});
});

describe("the restore funnel", () => {
	it("reads the flag off the stored trace", () => {
		expect(responseFromRunResult(runResult({ bodyCapped: true }))?.bodyCapped).toBe(true);
	});

	it("leaves it absent when the trace carries none", () => {
		expect(responseFromRunResult(runResult())?.bodyCapped).toBeUndefined();
	});
});

describe("funnel parity", () => {
	it("agrees that a capped body is capped", () => {
		const live = responseFromExecuteResult(executeResult(true));
		const restored = responseFromRunResult(runResult({ bodyCapped: true }));
		expect(restored?.bodyCapped).toEqual(live.bodyCapped);
	});

	it("agrees that an ordinary body is not", () => {
		const live = responseFromExecuteResult(executeResult(false));
		const restored = responseFromRunResult(runResult());
		expect(restored?.bodyCapped).toEqual(live.bodyCapped);
	});
});

describe("against the storage truncation flag", () => {
	it("keeps the two independent on a restored response", () => {
		// Both really happen together: the engine reads a prefix, then storage
		// shortens even that. Deriving one from the other would leave the pane
		// telling the user to re-send when re-sending changes nothing.
		const restored = responseFromRunResult(
			runResult({ bodyCapped: true, bodyTruncated: true, bodyBytes: 33_554_432 })
		);

		expect(restored?.bodyCapped).toBe(true);
		expect(restored?.bodyTruncated).toBe(true);
		expect(restored?.bodyBytes).toBe(33_554_432);
	});

	it("does not set the storage flag for a live capped send", () => {
		// A live response has nothing stored yet, so a capped read must not read
		// as "truncated for storage" - the two notices give opposite advice.
		const live = responseFromExecuteResult(executeResult(true));

		expect(live.bodyCapped).toBe(true);
		expect(live.bodyTruncated).toBeUndefined();
	});
});
