/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache License, Version 2.0
 * found in the LICENSE file in the "app" directory of this source tree.
 */

/**
 * Both response funnels carry the script results (issue #725).
 *
 * The restore funnel already read the stored `scripts` node, but only a
 * *streaming* send ever wrote one - so an ordinary send's restored Tests pane
 * showed its empty state whether the assertions had passed or never run. The
 * engine now stores the same object it returns on every design send, and these
 * are the tests that redden if either side stops carrying it: delete the
 * `scriptsFromTrace` spread from `responseFromRunResult` and the restore and
 * parity cases fail.
 *
 * The sibling of `validation-funnels.test.ts`, for the same reason that file
 * exists: `execute-mapping.ts` and `restore-response.ts` are the copy pair this
 * codebase keeps finding drifted.
 */

import { describe, expect, it } from "vitest";

import type { ConsoleLogEntry, SanityResult, TestResult } from "@/types";
import { responseFromExecuteResult } from "./execute-mapping";
import { responseFromRunResult, type RunResultSample } from "./restore-response";

/**
 * One passing and one failing assertion: the pane draws them differently.
 *
 * One from each script, carrying the `source` the engine stamps (issue #810):
 * the phase is inside the object both funnels pass through, so a funnel that
 * rebuilt the list instead of carrying it would drop it here first.
 */
const TEST_RESULTS: TestResult[] = [
	{ name: "Token was issued", passed: true, source: "pre" },
	{
		name: "Body carries an id",
		passed: false,
		error: "expected undefined to equal 1",
		source: "test",
	},
];

const CONSOLE_LOGS: ConsoleLogEntry[] = [
	{ source: "pre", level: "log", message: "token refreshed" },
	{ source: "test", level: "error", message: "unexpected shape" },
];

/** The four keys as the engine writes them, live body and stored node alike. */
const SCRIPTS = {
	testResults: TEST_RESULTS,
	consoleLogs: CONSOLE_LOGS,
	postScriptError: "ReferenceError: pmm is not defined",
};

const executeResult = (scripts?: typeof SCRIPTS): SanityResult =>
	({
		status: 200,
		statusText: "OK",
		headers: { "content-type": "application/json" },
		body: { id: "one" },
		bodyRaw: '{"id":"one"}',
		bodySize: 12,
		...(scripts ?? {}),
	}) as unknown as SanityResult;

const runResult = (scripts?: typeof SCRIPTS): RunResultSample =>
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
			...(scripts ? { scripts } : {}),
		},
	}) as unknown as RunResultSample;

describe("the live funnel", () => {
	it("carries the four script keys", () => {
		const live = responseFromExecuteResult(executeResult(SCRIPTS));
		expect(live.testResults).toEqual(TEST_RESULTS);
		expect(live.consoleLogs).toEqual(CONSOLE_LOGS);
		expect(live.postScriptError).toBe(SCRIPTS.postScriptError);
	});
});

describe("the restore funnel", () => {
	it("carries the four script keys from the stored node", () => {
		const restored = responseFromRunResult(runResult(SCRIPTS));
		expect(restored?.testResults).toEqual(TEST_RESULTS);
		expect(restored?.consoleLogs).toEqual(CONSOLE_LOGS);
		expect(restored?.postScriptError).toBe(SCRIPTS.postScriptError);
	});

	it("leaves them absent when the trace carries no node", () => {
		// A trace written before #725, and a send that ran no scripts, are the
		// same shape - so absent has to read as "no results", never as "none
		// passed". The empty state is what the pane shows either way.
		const restored = responseFromRunResult(runResult());
		expect(restored?.testResults).toBeUndefined();
		expect(restored?.consoleLogs).toBeUndefined();
		expect(restored?.postScriptError).toBeUndefined();
	});
});

describe("funnel parity", () => {
	it("shows the same assertions live and restored", () => {
		// The point of the engine storing the object it returned rather than the
		// app deriving a second one: a run reopened from History is the run that
		// was sent, failure messages included.
		const live = responseFromExecuteResult(executeResult(SCRIPTS));
		const restored = responseFromRunResult(runResult(SCRIPTS));

		expect(restored?.testResults).toEqual(live.testResults);
		expect(restored?.consoleLogs).toEqual(live.consoleLogs);
		expect(restored?.preScriptError).toEqual(live.preScriptError);
		expect(restored?.postScriptError).toEqual(live.postScriptError);
	});
});
