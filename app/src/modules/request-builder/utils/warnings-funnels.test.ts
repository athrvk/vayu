/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache License, Version 2.0
 * found in the LICENSE file in the "app" directory of this source tree.
 */

/**
 * Both response funnels carry the engine's `warnings` (issue #3307).
 *
 * The live `/execute` body always has the array, `[]` when empty; the stored
 * trace has it at the top level and only when non-empty, and a failed exchange
 * (no `response` node) can still carry it. `ResponseState` is built from them
 * by `execute-mapping.ts` and `restore-response.ts`, a copy pair a field has
 * gone missing from before. Empty and absent are one case on both sides.
 */

import { describe, expect, it } from "vitest";

import type { ExchangeWarning, SanityResult } from "@/types";
import { responseFromExecuteResult } from "./execute-mapping";
import { responseFromRunResult, type RunResultSample } from "./restore-response";

const WARNINGS: ExchangeWarning[] = [
	{ code: "cookie_not_sent", message: "The cookie 'session' was left out." },
	{ code: "cookie_dropped_oversized", message: "1 Set-Cookie header was too large: big." },
];

const executeResult = (warnings?: unknown): SanityResult =>
	({
		status: 200,
		statusText: "OK",
		headers: {},
		body: "",
		bodyRaw: "",
		bodySize: 0,
		...(warnings === undefined ? {} : { warnings }),
	}) as unknown as SanityResult;

const runResult = (warnings?: unknown): RunResultSample =>
	({
		timestamp: 1_700_000_000_000,
		statusCode: 200,
		statusText: "OK",
		latencyMs: 12,
		trace: {
			request: { method: "GET", url: "https://api.example.com/pets/1", headers: {} },
			response: { status: 200, headers: {}, body: "" },
			...(warnings === undefined ? {} : { warnings }),
		},
	}) as unknown as RunResultSample;

/** A transfer that never reached a server: no `response` node, only an error. */
const failedRunResult = (warnings: ExchangeWarning[]): RunResultSample =>
	({
		timestamp: 1_700_000_000_000,
		statusCode: 0,
		statusText: "Error",
		latencyMs: 3,
		trace: {
			request: { method: "GET", url: "https://api.example.com/pets/1", headers: {} },
			error_type: "ConnectionError",
			error_message: "refused",
			warnings,
		},
	}) as unknown as RunResultSample;

describe("the live funnel", () => {
	it("carries the warnings in order", () => {
		expect(responseFromExecuteResult(executeResult(WARNINGS)).warnings).toEqual(WARNINGS);
	});

	it.each([
		["absent", undefined],
		["empty, as a live body always sends it", []],
	])("leaves them absent when they are %s", (_name, warnings) => {
		expect(responseFromExecuteResult(executeResult(warnings)).warnings).toBeUndefined();
	});

	it("skips an entry that is not a code and a message", () => {
		const result = executeResult([WARNINGS[0], { code: "cookie_not_sent" }, "text", null]);
		expect(responseFromExecuteResult(result).warnings).toEqual([WARNINGS[0]]);
	});

	it("leaves them absent when none of the entries is readable", () => {
		expect(responseFromExecuteResult(executeResult([{ code: 1 }])).warnings).toBeUndefined();
	});
});

describe("the restore funnel", () => {
	it("carries the warnings from the trace's top level", () => {
		expect(responseFromRunResult(runResult(WARNINGS))?.warnings).toEqual(WARNINGS);
	});

	it.each([
		["absent, as the engine stores a send with none", undefined],
		["empty", []],
	])("leaves them absent when they are %s", (_name, warnings) => {
		expect(responseFromRunResult(runResult(warnings))?.warnings).toBeUndefined();
	});

	it("carries them on a failed exchange, which has no response node at all", () => {
		expect(responseFromRunResult(failedRunResult(WARNINGS))?.warnings).toEqual(WARNINGS);
	});
});

/**
 * A streaming send answers `202` before the exchange runs, so its warnings are
 * on the stored trace beside the `events` node (issue #3315) and nowhere else.
 */
const streamRunResult = (warnings?: ExchangeWarning[]): RunResultSample =>
	({
		timestamp: 1_700_000_000_000,
		statusCode: 200,
		statusText: "OK",
		latencyMs: 40,
		trace: {
			request: { method: "GET", url: "https://api.example.com/stream", headers: {} },
			response: { status: 200, headers: { "content-type": "text/event-stream" }, body: "" },
			events: {
				items: [{ event: "token", data: "a" }],
				totalEvents: 1,
				eventsTruncated: false,
				endReason: "completed",
			},
			...(warnings === undefined ? {} : { warnings }),
		},
	}) as unknown as RunResultSample;

describe("a streaming send's stored trace", () => {
	it("restores the events and the warnings together", () => {
		const restored = responseFromRunResult(streamRunResult(WARNINGS));
		expect(restored?.warnings).toEqual(WARNINGS);
		expect(restored?.events).toEqual([{ event: "token", data: "a" }]);
		expect(restored?.streamEndReason).toBe("completed");
	});

	it("restores the events alone when the stream had nothing to report", () => {
		const restored = responseFromRunResult(streamRunResult());
		expect(restored?.events).toHaveLength(1);
		expect(restored?.warnings).toBeUndefined();
	});
});

describe("funnel parity", () => {
	it("says the same thing live and restored", () => {
		const live = responseFromExecuteResult(executeResult(WARNINGS));
		const restored = responseFromRunResult(runResult(WARNINGS));
		expect(restored?.warnings).toEqual(live.warnings);
		expect(live.warnings).toEqual(WARNINGS);
	});

	it("agrees that none is none, whichever spelling each side uses", () => {
		const live = responseFromExecuteResult(executeResult([]));
		const restored = responseFromRunResult(runResult());
		expect(restored?.warnings).toEqual(live.warnings);
		expect(live.warnings).toBeUndefined();
	});
});
