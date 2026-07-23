/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Timing must survive a restart.
 *
 * Nothing about a response is written to localStorage - only the tab list is.
 * So on relaunch, a restored request tab rebuilds its response pane from the
 * last stored design run (`useLastDesignRunQuery` → this reconstruction). The
 * engine has always persisted the per-phase breakdown into that run's trace
 * (`store_result`, execution.cpp writes dnsMs/connectMs/tlsMs/firstByteMs/
 * downloadMs), and the history module reads it - but the request-builder's
 * restore mapped status/headers/body and silently dropped the timing, so
 * `ResponseState.timing` came back undefined and ResponseViewer, which gates
 * both the trigger and the panel on `response.timing`, hid the Timing tab
 * outright. The tab came back; its contents did not.
 */

import { describe, it, expect } from "vitest";
import { responseFromRunResult, timingFromTrace, type RunResultSample } from "./restore-response";

/** A design-run result as `GET /runs/:id/report` returns it. */
function sample(overrides: Partial<RunResultSample> = {}): RunResultSample {
	return {
		timestamp: 1_750_000_000_000,
		statusCode: 200,
		statusText: "OK",
		latencyMs: 254.5,
		trace: {
			request: {
				method: "GET",
				url: "https://api.example.test/users",
				headers: { Accept: "application/json" },
			},
			response: {
				headers: { "content-type": "application/json" },
				body: '{"ok":true}',
			},
			dnsMs: 4.2,
			connectMs: 21.7,
			tlsMs: 63.1,
			firstByteMs: 160.4,
			downloadMs: 5.1,
		},
		...overrides,
	};
}

describe("responseFromRunResult", () => {
	it("restores the timing breakdown the engine persisted", () => {
		const restored = responseFromRunResult(sample());

		// The regression: this was undefined, which hides the whole Timing tab.
		expect(restored?.timing).toBeDefined();
		expect(restored?.timing).toEqual({
			total: 254.5,
			dns: 4.2,
			connect: 21.7,
			tls: 63.1,
			firstByte: 160.4,
			download: 5.1,
		});
	});

	it("still restores status, headers and body", () => {
		const restored = responseFromRunResult(sample());

		expect(restored?.status).toBe(200);
		expect(restored?.statusText).toBe("OK");
		expect(restored?.headers).toEqual({ "content-type": "application/json" });
		expect(restored?.body).toBe('{"ok":true}');
		expect(restored?.bodyType).toBe("json");
		expect(restored?.time).toBe(254.5);
		expect(restored?.requestHeaders).toEqual({ Accept: "application/json" });
	});

	/**
	 * The Raw tab answers "what did I actually send", and the request pane
	 * beside it cannot - it shows the request as it is now, possibly edited
	 * since the run. This used to collapse the whole trace to `GET <url>`, so
	 * a reopened run showed one line and the body that was sent was not
	 * reachable anywhere in the app.
	 */
	it("rebuilds a real raw request, not a method-and-url line", () => {
		const restored = responseFromRunResult(
			sample({
				trace: {
					request: {
						method: "POST",
						url: "https://api.example.test/users?dry=1",
						headers: { "content-type": "application/json" },
						body: '{"name":"ada"}',
					},
					response: { headers: {}, body: "{}" },
				},
			})
		);

		expect(restored?.rawRequest).toBe(
			"POST /users?dry=1 HTTP/1.1\r\n" +
				"Host: api.example.test\r\n" +
				"content-type: application/json\r\n" +
				"Content-Length: 14\r\n" +
				"\r\n" +
				'{"name":"ada"}'
		);
	});

	it("returns null when the run result carries neither an exchange nor an error", () => {
		expect(responseFromRunResult(undefined)).toBeNull();
		expect(responseFromRunResult(sample({ trace: { dnsMs: 4.2 } }))).toBeNull();
	});

	it("does not choke on a trace whose response body is missing", () => {
		const restored = responseFromRunResult(sample({ trace: { response: { headers: {} } } }));

		expect(restored?.body).toBe("");
		expect(restored?.bodyType).toBe("text");
	});
});

/**
 * A request that never reached a server stores no `response` node at all -
 * `store_result` writes `error_type`/`error_message` instead. Returning null
 * left the response pane blank, which was survivable while a second viewer
 * showed the error in its own callout. Once the builder is the only place a
 * design run is displayed, the failure has to arrive with it.
 */
describe("a run that failed before reaching the server", () => {
	const failed = sample({
		statusCode: 0,
		statusText: "",
		trace: {
			request: {
				method: "GET",
				url: "https://nope.example.test/",
				headers: {},
			},
			error_type: "CONNECTION_FAILED",
			error_message: "Could not connect to host",
			dnsMs: 12,
		},
	});

	it("maps to the same status-0 shape a live failure produces", () => {
		const restored = responseFromRunResult(failed);

		// status 0 is what sends the pane to ClientErrorView, and errorCode
		// picks its icon and hint. The engine's `to_string(ErrorCode)` uses
		// the same words as a live `errorCode`.
		expect(restored?.status).toBe(0);
		expect(restored?.errorCode).toBe("CONNECTION_FAILED");
		expect(restored?.errorMessage).toBe("Could not connect to host");
	});

	it("still carries what was sent, and the phases that got as far as they did", () => {
		const restored = responseFromRunResult(failed);

		expect(restored?.rawRequest).toContain("GET / HTTP/1.1");
		expect(restored?.timing?.dns).toBe(12);
	});

	it("falls back to the result's own error text", () => {
		// Older rows, and the load-test writer, do not fill `error_message`.
		const restored = responseFromRunResult(
			sample({
				error: "Timeout was reached",
				trace: { error_type: "TIMEOUT" },
			})
		);

		expect(restored?.errorMessage).toBe("Timeout was reached");
	});
});

describe("timingFromTrace", () => {
	it("treats an omitted phase as zero - the engine only writes non-zero phases", () => {
		// Reused connection: no TCP handshake, no TLS, so neither key is written.
		const timing = timingFromTrace({ dnsMs: 0.4, firstByteMs: 88.2, downloadMs: 1.1 }, 90.3);

		expect(timing).toEqual({
			total: 90.3,
			dns: 0.4,
			connect: 0,
			tls: 0,
			firstByte: 88.2,
			download: 1.1,
		});
	});

	it("leaves wire and queueWait unset - the design-mode writer omits them", () => {
		const timing = timingFromTrace({ firstByteMs: 12 }, 14);

		expect(timing).not.toHaveProperty("wire");
		expect(timing).not.toHaveProperty("queueWait");
	});

	it("is undefined when no phase was stored, so no empty Timing tab appears", () => {
		expect(timingFromTrace({}, 90)).toBeUndefined();
		expect(timingFromTrace({ isSlow: true, thresholdMs: 500 }, 90)).toBeUndefined();
	});

	it("falls back to the trace total when the result carries no latency", () => {
		expect(timingFromTrace({ totalMs: 77, firstByteMs: 70 }, undefined)?.total).toBe(77);
	});
});
