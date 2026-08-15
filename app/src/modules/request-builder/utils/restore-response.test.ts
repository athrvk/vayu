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
import {
	eventsFromTrace,
	responseFromRunResult,
	scriptsFromTrace,
	timingFromTrace,
	type RunResultSample,
} from "./restore-response";

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
			totalMs: 254.5,
			dnsMs: 4.2,
			connectMs: 21.7,
			tlsMs: 63.1,
			firstByteMs: 160.4,
			downloadMs: 5.1,
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

	/**
	 * The gap issue #348 closed. `trace.request.headers` is the *composed* map
	 * and libcurl attaches the jar's cookies itself, so a view rebuilt from it
	 * can never show a `Cookie` line - the same request showed one right after
	 * a send and none after a reload. The engine now stores the wire message it
	 * already had; this asserts the restored view reads it rather than
	 * rebuilding around it.
	 *
	 * Mutation-check: drop the `request.rawRequest ||` preference in `sentSide`
	 * and this fails on the missing `Cookie` line.
	 */
	it("prefers the stored wire message, cookies and all, over rebuilding one", () => {
		const wire =
			"GET /users HTTP/1.1\r\n" +
			"Host: api.example.test\r\n" +
			"Accept: application/json\r\n" +
			"Cookie: session=abc123\r\n" +
			"\r\n";

		const restored = responseFromRunResult(
			sample({
				trace: {
					request: {
						method: "GET",
						url: "https://api.example.test/users",
						headers: { Accept: "application/json" },
						rawRequest: wire,
					},
					response: { headers: {}, body: "{}" },
				},
			})
		);

		expect(restored?.rawRequest).toBe(wire);
		// A row with no `sentHeaders` still falls back to the composed map, so
		// the raw preference and the header preference are independent.
		expect(restored?.requestHeaders).toEqual({ Accept: "application/json" });
	});

	/**
	 * A row written before #348 has no `rawRequest`, and a restored run from
	 * last week has to keep rendering. Same fallback shape as
	 * `trace.response?.httpVersion`.
	 */
	it("falls back to rebuilding when the row predates the stored wire message", () => {
		const restored = responseFromRunResult(
			sample({
				trace: {
					request: {
						method: "GET",
						url: "https://api.example.test/users",
						headers: { Accept: "application/json" },
					},
					response: { headers: {}, body: "{}" },
				},
			})
		);

		expect(restored?.rawRequest).toBe(
			"GET /users HTTP/1.1\r\n" +
				"Host: api.example.test\r\n" +
				"Accept: application/json\r\n" +
				"\r\n"
		);
	});

	/**
	 * The gap issue #664 closed, one field over from #348. The panel this feeds
	 * is labelled as what was sent, and `trace.request.headers` is the
	 * *composed* request: it names an empty-valued header libcurl dropped and a
	 * `form-data` `Content-Type` libcurl rewrote with its boundary, and it is
	 * missing the body-implied `Content-Type` and the default `User-Agent` the
	 * engine derives at send time - which the live panel showed. The engine now
	 * stores the sent record it already had.
	 *
	 * Mutation-check: drop the `request.sentHeaders ||` preference in `sentSide`
	 * and every assertion in this test fails.
	 */
	it("prefers the stored sent record over the composed map for the sent panel", () => {
		const restored = responseFromRunResult(
			sample({
				trace: {
					request: {
						method: "POST",
						url: "https://api.example.test/upload",
						headers: {
							"Content-Type": "multipart/form-data",
							"X-Blank": "",
							accept: "application/json",
						},
						sentHeaders: {
							accept: "application/json",
							"Content-Type": "multipart/form-data; boundary=------abc123",
							"User-Agent": "vayu/0.17.0",
						},
					},
					response: { headers: {}, body: "{}" },
				},
			})
		);

		// Exhaustive, so all three drifts fail here at once: the derived
		// `User-Agent` the composed map lacks, the boundary libcurl added to the
		// multipart `Content-Type`, and the value-less `X-Blank` that never
		// reached the wire.
		expect(restored?.requestHeaders).toEqual({
			accept: "application/json",
			"Content-Type": "multipart/form-data; boundary=------abc123",
			"User-Agent": "vayu/0.17.0",
		});
	});

	/**
	 * Absent-not-empty, the same contract `rawRequest` has: a run recorded
	 * before #664 - and a step that sent nothing, whose response carries no sent
	 * record either - restores exactly as it does today.
	 */
	it("falls back to the composed map when the row predates the stored sent record", () => {
		const restored = responseFromRunResult(
			sample({
				trace: {
					request: {
						method: "GET",
						url: "https://api.example.test/users",
						headers: { Accept: "application/json", "X-Trace": "abc" },
					},
					response: { headers: {}, body: "{}" },
				},
			})
		);

		expect(restored?.requestHeaders).toEqual({
			Accept: "application/json",
			"X-Trace": "abc",
		});
	});

	/**
	 * A failed transfer stores the engine's synthesized message rather than
	 * nothing, so the preference has to hold on the error path too - that path
	 * builds its `ResponseState` through a different branch of
	 * `responseFromRunResult`, and only `sentSide` is shared.
	 */
	it("prefers the stored wire message on a run that never reached a server", () => {
		const restored = responseFromRunResult(
			sample({
				statusCode: 0,
				trace: {
					request: {
						method: "GET",
						url: "https://nope.example.test/",
						headers: {},
						rawRequest: "GET / HTTP/2\r\nHost: nope.example.test\r\n\r\n",
					},
					error_type: "CONNECTION_FAILED",
					error_message: "Could not connect to host",
				},
			})
		);

		expect(restored?.rawRequest).toBe("GET / HTTP/2\r\nHost: nope.example.test\r\n\r\n");
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

	/**
	 * The engine caps a stored trace body at `maxTraceBodyBytes`. When it does,
	 * the trace carries `bodyTruncated` / `bodyBytes`, and the restore must pass
	 * them through so ResponseViewer can show the truncation notice - and report
	 * the *original* size, not the stored slice's length. Reverting the mapping
	 * in `responseFromRunResult` fails this test.
	 */
	it("surfaces a truncated response body's flag and original size", () => {
		const restored = responseFromRunResult(
			sample({
				trace: {
					request: { method: "GET", url: "https://api.example.test/big", headers: {} },
					response: {
						headers: { "content-type": "application/json" },
						body: "STORED_SLICE",
						bodyTruncated: true,
						bodyBytes: 5_242_880,
					},
				},
			})
		);

		expect(restored?.bodyTruncated).toBe(true);
		expect(restored?.bodyBytes).toBe(5_242_880);
		// `size` shows the original length, not the 12-char stored slice.
		expect(restored?.size).toBe(5_242_880);
		expect(restored?.body).toBe("STORED_SLICE");
	});

	it("leaves the truncation fields unset for an untruncated body", () => {
		const restored = responseFromRunResult(sample());

		expect(restored?.bodyTruncated).toBeUndefined();
		expect(restored?.bodyBytes).toBeUndefined();
		// Falls back to the stored body's own length.
		expect(restored?.size).toBe('{"ok":true}'.length);
	});

	/**
	 * The negotiated protocol lands on both lines the Raw tab prints - the
	 * request line (via `buildRawRequest`, baked into `rawRequest` here) and
	 * the status line (via `ResponseState.httpVersion`, which `RawRequestResponse`
	 * reads at render time). Missing either one shows a restored HTTP/2 run as
	 * HTTP/2 on one line and the HTTP/1.1 default on the other.
	 */
	it("carries the negotiated protocol onto the request line and the response state", () => {
		const restored = responseFromRunResult(
			sample({
				trace: {
					request: {
						method: "GET",
						url: "https://api.example.test/users",
						headers: {},
					},
					response: { headers: {}, body: "{}", httpVersion: "HTTP/2" },
				},
			})
		);

		expect(restored?.rawRequest).toContain("HTTP/2");
		expect(restored?.httpVersion).toBe("HTTP/2");
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
		expect(restored?.timing?.dnsMs).toBe(12);
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
	it("treats an omitted phase as zero - older engines only wrote non-zero phases", () => {
		// Reused connection: no TCP handshake, no TLS, so neither key was written.
		const timing = timingFromTrace({ dnsMs: 0.4, firstByteMs: 88.2, downloadMs: 1.1 }, 90.3);

		expect(timing).toEqual({
			totalMs: 90.3,
			dnsMs: 0.4,
			connectMs: 0,
			tlsMs: 0,
			firstByteMs: 88.2,
			downloadMs: 1.1,
		});
	});

	it("passes wireMs and queueWaitMs through when the trace stored them", () => {
		// The current design-mode writer stores all eight keys (store_result,
		// execution.cpp), so a restored Timing tab shows Wire and Queue too.
		const timing = timingFromTrace(
			{
				totalMs: 90.3,
				wireMs: 89.9,
				queueWaitMs: 0.4,
				dnsMs: 0.4,
				connectMs: 0,
				tlsMs: 0,
				firstByteMs: 88.2,
				downloadMs: 1.1,
			},
			90.3
		);

		expect(timing?.wireMs).toBe(89.9);
		expect(timing?.queueWaitMs).toBe(0.4);
	});

	it("leaves wireMs and queueWaitMs unset on rows older engines wrote without them", () => {
		const timing = timingFromTrace({ firstByteMs: 12 }, 14);

		expect(timing).not.toHaveProperty("wireMs");
		expect(timing).not.toHaveProperty("queueWaitMs");
	});

	it("is undefined when no phase was stored, so no empty Timing tab appears", () => {
		expect(timingFromTrace({}, 90)).toBeUndefined();
		expect(timingFromTrace({ isSlow: true, thresholdMs: 500 }, 90)).toBeUndefined();
	});

	it("falls back to the trace total when the result carries no latency", () => {
		expect(timingFromTrace({ totalMs: 77, firstByteMs: 70 }, undefined)?.totalMs).toBe(77);
	});
});

/**
 * A streaming run's timeline has to survive the same restart (issue #574).
 *
 * The whole point of the stored `events` node is that reopening a finished
 * stream from History shows what it received. Its two markers are the part that
 * cannot be recomputed here: the engine compared the true total against what it
 * stored, and a reader on this side does not know what the cap was when the run
 * happened - so deriving `eventsTruncated` from `items.length` would quietly
 * turn a capped list into a complete one.
 */
describe("eventsFromTrace", () => {
	it("gives nothing at all for a trace that is not a stream's", () => {
		// Absent, not empty: the Events tab tells "not a stream" from "a stream
		// that produced nothing" by exactly this difference.
		expect(eventsFromTrace({})).toEqual({});
		expect(responseFromRunResult(sample())).not.toHaveProperty("events");
	});

	it("restores the list, the markers and the end reason", () => {
		const restored = responseFromRunResult(
			sample({
				trace: {
					...sample().trace,
					events: {
						items: [{ event: "token", data: "hi", sourceId: "7" }],
						totalEvents: 4000,
						eventsTruncated: true,
						endReason: "maxStreamEvents",
					},
				},
			})
		);

		expect(restored?.events).toEqual([{ event: "token", data: "hi", sourceId: "7" }]);
		expect(restored?.totalEvents).toBe(4000);
		expect(restored?.eventsTruncated).toBe(true);
		expect(restored?.streamEndReason).toBe("maxStreamEvents");
	});

	it("keeps the engine's total rather than counting the rows", () => {
		// Mutation check: recompute `totalEvents` from `items.length` here and
		// this is the assertion that reddens.
		const restored = eventsFromTrace({
			events: { items: [], totalEvents: 12, eventsTruncated: true, endReason: "stopped" },
		});
		expect(restored.totalEvents).toBe(12);
		expect(restored.events).toEqual([]);
	});

	it("restores an empty-but-real timeline as an empty list", () => {
		const restored = eventsFromTrace({
			events: { items: [], totalEvents: 0, eventsTruncated: false, endReason: "completed" },
		});
		expect(restored.events).toEqual([]);
		expect(restored.eventsTruncated).toBe(false);
	});

	it("carries the events of a stream that ended without a response node", () => {
		// A run that failed before any response still recorded whatever the
		// stream received, and `build_result_trace` writes the node either way.
		const restored = responseFromRunResult(
			sample({
				statusCode: 0,
				trace: {
					request: { method: "GET", url: "https://api.example.test/sse" },
					error_type: "CONNECTION_FAILED",
					error_message: "connection reset",
					events: {
						items: [{ event: "message", data: "before the drop" }],
						totalEvents: 1,
						eventsTruncated: false,
						endReason: "error",
					},
				},
			})
		);

		expect(restored?.status).toBe(0);
		expect(restored?.events).toHaveLength(1);
		expect(restored?.streamEndReason).toBe("error");
	});
});

/**
 * The `scripts` node a streaming run stores (issue #575).
 *
 * This is the *only* route a streaming send's test results ever take: that send
 * was answered `202` before its post-request script had run, so nothing came
 * back in a response body to put in the pane. Dropping this mapping is the
 * "written but never read" shape - the engine would store results no surface
 * shows - which is what the last case here pins.
 */
describe("scriptsFromTrace", () => {
	it("gives nothing at all for a trace with no scripts node", () => {
		expect(scriptsFromTrace({})).toEqual({});
		expect(responseFromRunResult(sample())).not.toHaveProperty("testResults");
	});

	it("restores test results, console lines and both script errors", () => {
		const restored = responseFromRunResult(
			sample({
				trace: {
					...sample().trace,
					scripts: {
						testResults: [
							{ name: "got the done event", passed: false, error: "expected 3" },
						],
						consoleLogs: [{ source: "test", level: "log", message: "seen 2" }],
						preScriptError: "pre blew up",
						postScriptError: "post blew up",
					},
				},
			})
		);
		expect(restored?.testResults).toEqual([
			{ name: "got the done event", passed: false, error: "expected 3" },
		]);
		expect(restored?.consoleLogs).toEqual([
			{ source: "test", level: "log", message: "seen 2" },
		]);
		expect(restored?.preScriptError).toBe("pre blew up");
		expect(restored?.postScriptError).toBe("post blew up");
	});

	it("restores them on the failure path too, where a stream that errored still ran its script", () => {
		const restored = responseFromRunResult(
			sample({
				statusCode: 0,
				trace: {
					request: sample().trace!.request,
					error_type: "CONNECTION_FAILED",
					error_message: "refused",
					scripts: { testResults: [{ name: "never reached", passed: false }] },
				},
			})
		);
		expect(restored?.testResults).toHaveLength(1);
	});

	it("keeps the engine's own key names rather than renaming on the way through", () => {
		// A rename here would be the one place the live pane and the restored
		// pane could drift, since both read `ResponseState` under these names.
		const node = {
			testResults: [{ name: "t", passed: true }],
			consoleLogs: [{ source: "pre" as const, level: "warn" as const, message: "m" }],
		};
		expect(scriptsFromTrace({ scripts: node })).toEqual(node);
	});
});
