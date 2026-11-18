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
 * parity cases fail. The same holds for `scriptRequests` (#3633), which rides
 * the node beside the other four.
 *
 * The sibling of `validation-funnels.test.ts`, for the same reason that file
 * exists: `execute-mapping.ts` and `restore-response.ts` are the copy pair this
 * codebase keeps finding drifted.
 */

import { describe, expect, it } from "vitest";

import type { ConsoleLogEntry, SanityResult, ScriptRequestRecord, TestResult } from "@/types";
import { responseFromExecuteResult } from "./execute-mapping";
import { responseFromRunResult, type RunResultSample } from "./restore-response";

/**
 * One passing and one failing assertion: the pane draws them differently.
 *
 * One from each script, carrying the `source` the engine stamps (issue #810):
 * the phase is inside the object both funnels pass through, so a funnel that
 * rebuilt the list instead of carrying it would drop it here first. The same
 * goes for the `scope` (issue #2522): one entry from each level, so a funnel
 * that rebuilt an entry from named fields loses it on the first one.
 */
const TEST_RESULTS: TestResult[] = [
	{ name: "Token was issued", passed: true, source: "pre", scope: "collection" },
	{ name: "Folder is tagged", passed: true, source: "test", scope: "folder" },
	{
		name: "Body carries an id",
		passed: false,
		error: "expected undefined to equal 1",
		source: "test",
		scope: "request",
	},
];

const CONSOLE_LOGS: ConsoleLogEntry[] = [
	{
		source: "pre",
		scope: "collection",
		level: "info",
		message: "pm.sendRequest POST https://auth.example.test/token -> 200 (41 ms)",
		scriptRequest: 0,
	},
	{ source: "pre", scope: "collection", level: "log", message: "token refreshed" },
	{ source: "test", scope: "request", level: "error", message: "unexpected shape" },
];

/**
 * One answered call and one that never connected (#3633): the line above
 * indexes the first, and the second has no line, as with the console off.
 */
const SCRIPT_REQUESTS: ScriptRequestRecord[] = [
	{
		source: "pre",
		scope: "collection",
		startedAt: 1_763_452_800_123,
		status: 200,
		statusText: "OK",
		request: {
			method: "POST",
			url: "https://auth.example.test/token",
			headers: { Authorization: "<redacted>" },
			sentHeaderLines: [{ name: "Authorization", value: "<redacted>" }],
			body: "grant_type=client_credentials",
		},
		response: {
			headers: { "content-type": "application/json" },
			body: '{"access_token":"tok_123"}',
			bodyBytes: 26,
		},
		totalMs: 41.2,
		dnsMs: 0,
		firstByteMs: 38.9,
	},
	{
		source: "test",
		scope: "request",
		status: 0,
		statusText: "Error",
		request: { method: "GET", url: "http://127.0.0.1:1/down" },
		error_type: "CONNECTION_FAILED",
		error_message: "Connection refused",
		totalMs: 0.4,
	},
];

/** The script keys as the engine writes them, live body and stored node alike. */
const SCRIPTS = {
	testResults: TEST_RESULTS,
	consoleLogs: CONSOLE_LOGS,
	preScriptError: "Collection pre-request script failed - boom",
	postScriptError: "ReferenceError: pmm is not defined",
	scriptRequests: SCRIPT_REQUESTS,
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
	it("carries the script keys", () => {
		const live = responseFromExecuteResult(executeResult(SCRIPTS));
		expect(live.testResults).toEqual(TEST_RESULTS);
		expect(live.consoleLogs).toEqual(CONSOLE_LOGS);
		expect(live.preScriptError).toBe(SCRIPTS.preScriptError);
		expect(live.postScriptError).toBe(SCRIPTS.postScriptError);
		expect(live.scriptRequests).toEqual(SCRIPT_REQUESTS);
	});
});

describe("the restore funnel", () => {
	it("carries the script keys from the stored node", () => {
		const restored = responseFromRunResult(runResult(SCRIPTS));
		expect(restored?.testResults).toEqual(TEST_RESULTS);
		expect(restored?.consoleLogs).toEqual(CONSOLE_LOGS);
		expect(restored?.preScriptError).toBe(SCRIPTS.preScriptError);
		expect(restored?.postScriptError).toBe(SCRIPTS.postScriptError);
		expect(restored?.scriptRequests).toEqual(SCRIPT_REQUESTS);
	});

	it("leaves them absent when the trace carries no node", () => {
		// A trace written before #725, and a send that ran no scripts, are the
		// same shape - so absent has to read as "no results", never as "none
		// passed". The empty state is what the pane shows either way.
		const restored = responseFromRunResult(runResult());
		expect(restored?.testResults).toBeUndefined();
		expect(restored?.consoleLogs).toBeUndefined();
		expect(restored?.postScriptError).toBeUndefined();
		expect(restored?.scriptRequests).toBeUndefined();
	});
});

describe("funnel parity", () => {
	it("carries each entry's scope, live and restored alike", () => {
		const live = responseFromExecuteResult(executeResult(SCRIPTS));
		const restored = responseFromRunResult(runResult(SCRIPTS));

		const scopes = (r: { testResults?: TestResult[] } | null | undefined) =>
			r?.testResults?.map((t) => t.scope);
		expect(scopes(live)).toEqual(["collection", "folder", "request"]);
		expect(scopes(restored)).toEqual(scopes(live));
	});

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
		expect(restored?.scriptRequests).toEqual(live.scriptRequests);
	});

	it("leaves the records absent on both when no script sent a request (#3633)", () => {
		// The live body may omit the key as the stored node does; `undefined`
		// on one side and a missing key on the other would differ in a deep
		// compare of the two states.
		const { scriptRequests: _omitted, ...rest } = SCRIPTS;
		const live = responseFromExecuteResult(executeResult(rest as typeof SCRIPTS));
		const restored = responseFromRunResult(runResult(rest as typeof SCRIPTS));
		expect(live).not.toHaveProperty("scriptRequests");
		expect(restored).not.toHaveProperty("scriptRequests");
	});
});
