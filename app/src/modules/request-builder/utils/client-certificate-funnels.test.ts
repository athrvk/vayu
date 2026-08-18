/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache License, Version 2.0
 * found in the LICENSE file in the "app" directory of this source tree.
 */

/**
 * Both response funnels name the client certificate that was used (issue #707).
 *
 * The same reason `validation-funnels.test.ts` exists: `execute-mapping.ts` and
 * `restore-response.ts` are a copy pair and a field added to one has gone
 * missing from the other before. What is specific here is the empty case -
 * the live body always carries the key (`""` when nothing matched) while a
 * stored trace omits it, so the two funnels reach "no certificate" by different
 * routes and have to arrive at the same `undefined`.
 */

import { describe, expect, it } from "vitest";

import type { SanityResult } from "@/types";
import { responseFromExecuteResult } from "./execute-mapping";
import { responseFromRunResult, type RunResultSample } from "./restore-response";

const ENTRY = "api.example.com:8443";

const executeResult = (clientCertificate?: string): SanityResult =>
	({
		status: 200,
		statusText: "OK",
		headers: { "content-type": "application/json" },
		body: { id: "one" },
		bodyRaw: '{"id":"one"}',
		bodySize: 12,
		...(clientCertificate === undefined ? {} : { clientCertificate }),
	}) as unknown as SanityResult;

const runResult = (clientCertificate?: string): RunResultSample =>
	({
		timestamp: 1_700_000_000_000,
		statusCode: 200,
		statusText: "OK",
		latencyMs: 12,
		trace: {
			request: { method: "GET", url: "https://api.example.com:8443/pets/1", headers: {} },
			response: {
				status: 200,
				headers: { "content-type": "application/json" },
				body: '{"id":"one"}',
			},
			...(clientCertificate === undefined ? {} : { clientCertificate }),
		},
	}) as unknown as RunResultSample;

/** A transfer that never reached a server: no `response` node, only an error. */
const failedRunResult = (clientCertificate?: string): RunResultSample =>
	({
		timestamp: 1_700_000_000_000,
		statusCode: 0,
		statusText: "Error",
		latencyMs: 3,
		trace: {
			request: { method: "GET", url: "https://api.example.com:8443/pets/1", headers: {} },
			error_type: "SslError",
			error_message: "handshake failure",
			...(clientCertificate === undefined ? {} : { clientCertificate }),
		},
	}) as unknown as RunResultSample;

describe("the live funnel", () => {
	it("carries the entry that matched", () => {
		expect(responseFromExecuteResult(executeResult(ENTRY)).clientCertificate).toBe(ENTRY);
	});

	it('maps the engine\'s "" to undefined', () => {
		// The engine always sends the key so a reader can tell "none" from "this
		// engine cannot say". The pane has nothing to show for either, and the
		// restored funnel produces `undefined` - so this one must too, or parity
		// below is a lie.
		expect(responseFromExecuteResult(executeResult("")).clientCertificate).toBeUndefined();
	});
});

describe("the restore funnel", () => {
	it("carries the entry that matched", () => {
		expect(responseFromRunResult(runResult(ENTRY))?.clientCertificate).toBe(ENTRY);
	});

	it("leaves it absent when the trace carries none", () => {
		expect(responseFromRunResult(runResult())?.clientCertificate).toBeUndefined();
	});

	it("carries it on a failed exchange, which has no response node at all", () => {
		// The case that matters most: a refused handshake is exactly when "which
		// certificate did we present" is the question, and that trace stores an
		// error instead of a response.
		expect(responseFromRunResult(failedRunResult(ENTRY))?.clientCertificate).toBe(ENTRY);
	});
});

describe("funnel parity", () => {
	it("names the same entry live and restored", () => {
		const live = responseFromExecuteResult(executeResult(ENTRY));
		const restored = responseFromRunResult(runResult(ENTRY));
		expect(restored?.clientCertificate).toEqual(live.clientCertificate);
	});

	it("agrees that no certificate is no certificate", () => {
		const live = responseFromExecuteResult(executeResult(""));
		const restored = responseFromRunResult(runResult());
		expect(restored?.clientCertificate).toEqual(live.clientCertificate);
	});
});
