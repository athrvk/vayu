/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache License, Version 2.0
 * found in the LICENSE file in the "app" directory of this source tree.
 */

/**
 * Both response funnels carry the schema verdict (issue #628).
 *
 * This file exists because of the defect CLAUDE.md names: `execute-mapping.ts`
 * and `restore-response.ts` are a copy pair, and a field added to one of them
 * has gone missing from the other before. The parity test at the bottom is the
 * one that reddens if that happens again - it drives both funnels with the same
 * verdict and asserts they produce the same `validation`.
 */

import { describe, expect, it } from "vitest";

import type { ResponseValidation, SanityResult } from "@/types";
import { responseFromExecuteResult } from "./execute-mapping";
import {
	responseFromRunResult,
	validationFromTrace,
	type RunResultSample,
} from "./restore-response";

const VERDICT: ResponseValidation = {
	checked: true,
	valid: false,
	failures: [{ path: "/id", message: "Value type not permitted by 'type' constraint." }],
	failuresTotal: 3,
	matchedStatus: "200",
	matchedContentType: "application/json",
	unevaluatedKeywords: [{ keyword: "unevaluatedProperties", count: 2 }],
};

const executeResult = (validation?: ResponseValidation): SanityResult =>
	({
		status: 200,
		statusText: "OK",
		headers: { "content-type": "application/json" },
		body: { id: "one" },
		bodyRaw: '{"id":"one"}',
		bodySize: 12,
		...(validation ? { validation } : {}),
	}) as unknown as SanityResult;

const runResult = (validation?: ResponseValidation): RunResultSample =>
	({
		timestamp: 1_700_000_000_000,
		statusCode: 200,
		statusText: "OK",
		latencyMs: 12,
		trace: {
			request: { method: "GET", url: "https://api.example.com/pets/1", headers: {} },
			response: {
				status: 200,
				headers: { "content-type": "application/json" },
				body: '{"id":"one"}',
			},
			...(validation ? { validation } : {}),
		},
	}) as unknown as RunResultSample;

describe("validationFromTrace", () => {
	it("reads the stored node verbatim", () => {
		expect(validationFromTrace(runResult(VERDICT).trace!)).toEqual({ validation: VERDICT });
	});

	it("is empty when the trace carries none", () => {
		// Absent must stay absent: a collection bound to no document gets no
		// verdict at all, and an "unchecked" one would be a claim about a
		// contract that does not exist.
		expect(validationFromTrace(runResult().trace!)).toEqual({});
	});
});

describe("the live funnel", () => {
	it("carries the verdict", () => {
		expect(responseFromExecuteResult(executeResult(VERDICT)).validation).toEqual(VERDICT);
	});

	it("leaves it absent when the engine sent none", () => {
		expect(responseFromExecuteResult(executeResult())).not.toHaveProperty("validation");
	});
});

describe("the restore funnel", () => {
	it("carries the verdict", () => {
		expect(responseFromRunResult(runResult(VERDICT))?.validation).toEqual(VERDICT);
	});

	it("leaves it absent when the trace carries none", () => {
		expect(responseFromRunResult(runResult())?.validation).toBeUndefined();
	});
});

describe("funnel parity", () => {
	it("shows the same verdict live and restored", () => {
		// The whole point of the engine storing its own payload rather than the
		// app recomputing one: delete the `validationFromTrace` spread from
		// either funnel and this fails.
		const live = responseFromExecuteResult(executeResult(VERDICT));
		const restored = responseFromRunResult(runResult(VERDICT));
		expect(restored?.validation).toEqual(live.validation);
	});
});
