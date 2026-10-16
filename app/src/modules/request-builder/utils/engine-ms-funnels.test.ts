/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache License, Version 2.0
 * found in the LICENSE file in the "app" directory of this source tree.
 */

/**
 * Both response funnels carry `engineMs` (issue #2132).
 *
 * What is specific here is the nesting: the live `/execute` body carries it as
 * `timing.engineMs` while the stored design trace holds it flat as
 * `trace.engineMs`. The two funnels must still agree on `timing.engineMs`, and
 * on its absence - a stream, an auth failure and an old row store none.
 */

import { describe, expect, it } from "vitest";

import type { SanityResult } from "@/types";
import { responseFromExecuteResult } from "./execute-mapping";
import { responseFromRunResult, type RunResultSample } from "./restore-response";

const PHASES = { dnsMs: 1, connectMs: 2, tlsMs: 3, firstByteMs: 40, downloadMs: 4 };

const executeResult = (engineMs?: number): SanityResult =>
	({
		status: 200,
		statusText: "OK",
		headers: { "content-type": "application/json" },
		body: { id: "one" },
		bodyRaw: '{"id":"one"}',
		bodySize: 12,
		timing: {
			totalMs: 55,
			wireMs: 50,
			queueWaitMs: 0.4,
			...PHASES,
			...(engineMs === undefined ? {} : { engineMs }),
		},
	}) as unknown as SanityResult;

const runResult = (engineMs?: number): RunResultSample =>
	({
		timestamp: 1_700_000_000_000,
		statusCode: 200,
		statusText: "OK",
		latencyMs: 55,
		trace: {
			request: { method: "GET", url: "https://api.example.com/pets/1", headers: {} },
			response: {
				status: 200,
				headers: { "content-type": "application/json" },
				body: '{"id":"one"}',
			},
			totalMs: 55,
			wireMs: 50,
			queueWaitMs: 0.4,
			...PHASES,
			...(engineMs === undefined ? {} : { engineMs }),
		},
	}) as unknown as RunResultSample;

describe("funnel parity", () => {
	it("reports the same figure live and restored", () => {
		const live = responseFromExecuteResult(executeResult(3.4));
		const restored = responseFromRunResult(runResult(3.4));

		expect(live.timing?.engineMs).toBe(3.4);
		expect(restored?.timing?.engineMs).toBe(3.4);
	});

	it("leaves the key absent in both when none was reported", () => {
		const live = responseFromExecuteResult(executeResult());
		const restored = responseFromRunResult(runResult());

		expect(live.timing).not.toHaveProperty("engineMs");
		expect(restored?.timing).not.toHaveProperty("engineMs");
	});
});
