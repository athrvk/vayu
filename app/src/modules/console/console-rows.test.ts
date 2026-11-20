/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What one Send hands the session Console (#3634): its rows in execution order,
 * masked before they are stored, bodies intact.
 *
 * Mutation check: mask with `maskSensitiveHeaders` alone in `maskedExchange`
 * and "masks a header the engine's logger names" and every fixture-name case
 * but the seven snippet names store the value in clear; pass `[]` for
 * `authHeaders` in `sendRow` and "a custom
 * API-key header named by authHeaders" stores the key in clear; drop the
 * `authQueryParam` extra name and "masks a query name only the send's auth
 * claims" fails; drop the password instead of marking it in
 * `maskUserinfoPassword` and "copies the same cURL as a script request the
 * engine masked" fails; build
 * the rows in `consoleRows` order without the pre/post split and "lists a Send's
 * rows in execution order" fails.
 */

import { describe, expect, it } from "vitest";
import type { ConsoleLogEntry, ScenarioStepEvent, ScriptRequestRecord } from "@/types";
import type { ResponseState } from "@/modules/request-builder/types";
import type { ConsoleScriptRequestRow, ConsoleSendRow } from "@/stores/console-store";
import { sendConsoleRows, type CompletedSend } from "./console-rows";
import { stepConsoleRow } from "./step-row";
import { consoleRowCurl } from "./console-curl";
import { ENGINE_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import { readFileSync } from "node:fs";

const RAW_REQUEST =
	"POST /token HTTP/1.1\r\nHost: api.test\r\nAuthorization: Bearer T\r\n\r\n" +
	'{"grant":"password","password":"hunter2"}';

const response = (overrides: Partial<ResponseState> = {}): ResponseState => ({
	status: 200,
	statusText: "OK",
	headers: { "content-type": "application/json", "set-cookie": "sid=abc" },
	requestHeaders: {
		Authorization: "Bearer T",
		"X-Tenant-Key": "tenant-secret",
		Accept: "application/json",
	},
	rawRequest: RAW_REQUEST,
	body: '{\n  "token": "issued"\n}',
	bodyRaw: '{"token":"issued"}',
	size: 18,
	time: 42,
	timing: { totalMs: 42, dnsMs: 1, connectMs: 2, tlsMs: 3, firstByteMs: 30, downloadMs: 6 },
	authHeaders: ["X-Tenant-Key"],
	...overrides,
});

const send = (overrides: Partial<CompletedSend> = {}): CompletedSend => ({
	method: "POST",
	url: "https://alice:pw@api.test/token?access_token=AT&page=2",
	response: response({ authQueryParam: "access_token" }),
	requestId: "req_1",
	...overrides,
});

const record = (source: "pre" | "test", url: string): ScriptRequestRecord => ({
	source,
	status: 201,
	statusText: "Created",
	totalMs: 9,
	dnsMs: 1,
	request: {
		method: "POST",
		url,
		headers: { Authorization: "<redacted>" },
		body: "client_id=x",
	},
	response: { headers: { "content-type": "text/plain" }, body: "ok", bodyBytes: 2 },
});

const logs: ConsoleLogEntry[] = [
	{ source: "pre", level: "log", message: "fetching a token" },
	{ source: "pre", level: "info", message: "POST http://localhost:4000/t 201", scriptRequest: 0 },
	{ source: "test", level: "warn", message: "slow" },
	{ source: "test", level: "log", message: "GET http://localhost:4000/c 201", scriptRequest: 1 },
];

describe("sendConsoleRows", () => {
	it("lists a Send's rows in execution order: pre-request, the Send, post-response", () => {
		const rows = sendConsoleRows(
			send({
				response: response({
					consoleLogs: logs,
					scriptRequests: [
						record("pre", "http://localhost:4000/t"),
						record("test", "http://localhost:4000/c"),
					],
				}),
			})
		);

		expect(rows.map((row) => `${row.kind}${"source" in row ? `:${row.source}` : ""}`)).toEqual([
			"line:pre",
			"scriptRequest:pre",
			"send",
			"line:test",
			"scriptRequest:test",
		]);
		// The script request stands in for its summary line, which it carries.
		const pre = rows[1] as ConsoleScriptRequestRow;
		expect(pre).toMatchObject({
			url: "http://localhost:4000/t",
			status: 201,
			timeMs: 9,
			sizeBytes: 2,
			line: "POST http://localhost:4000/t 201",
			requestId: "req_1",
		});
		// Kept as the engine wrote it: already masked, and not judged again.
		expect(pre.exchange.requestHeaders).toEqual({ Authorization: "<redacted>" });
		expect(pre.exchange.requestBody).toEqual({ text: "client_id=x" });
		expect(pre.exchange.timing).toMatchObject({ totalMs: 9, dnsMs: 1 });
	});

	it("draws a Send with no script output as its one row", () => {
		const rows = sendConsoleRows(send());
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			kind: "send",
			method: "POST",
			status: 200,
			statusText: "OK",
			timeMs: 42,
			sizeBytes: 18,
			requestId: "req_1",
		});
	});

	describe("masking before the ring", () => {
		const row = () => sendConsoleRows(send())[0] as ConsoleSendRow;

		it("masks an Authorization header", () => {
			expect(row().exchange.requestHeaders.Authorization).toBe("<redacted>");
		});

		it("masks a custom API-key header named by authHeaders", () => {
			expect(row().exchange.requestHeaders["X-Tenant-Key"]).toBe("<redacted>");
			expect(row().exchange.requestHeaders.Accept).toBe("application/json");
		});

		it("masks a credential the response set", () => {
			expect(row().exchange.responseHeaders["set-cookie"]).toBe("<redacted>");
		});

		it("masks an auth-written access_token and a user:pass@ password in the URL", () => {
			expect(row().url).toBe(
				"https://alice:<redacted>@api.test/token?access_token=<redacted>&page=2"
			);
		});

		// The engine writes a script request's URL as `user:<redacted>@host`
		// (#3672), so a Send row in the old `user@host` form copied as
		// `-u 'alice:'` beside `-u 'alice:<redacted>'` for the same request.
		it("copies the same cURL as a script request the engine masked", () => {
			const engineMasked: ConsoleScriptRequestRow = {
				kind: "scriptRequest",
				source: "pre",
				method: "POST",
				url: "https://alice:<redacted>@api.test/token?access_token=<redacted>&page=2",
				status: 200,
				timeMs: 1,
				sizeBytes: 0,
				exchange: { requestHeaders: {}, responseHeaders: {} },
			};
			const sendCurl = consoleRowCurl({
				...row(),
				exchange: { requestHeaders: {}, responseHeaders: {} },
			});
			expect(sendCurl).toContain("-u 'alice:<redacted>'");
			expect(sendCurl).toBe(consoleRowCurl(engineMasked));
		});

		it("masks a query name only the send's auth claims", () => {
			const masked = sendConsoleRows(
				send({
					url: "https://api.test/p?tenant=S",
					response: response({ authQueryParam: "tenant" }),
				})
			)[0] as ConsoleSendRow;
			expect(masked.url).toBe("https://api.test/p?tenant=<redacted>");
		});

		it("masks a header the engine's logger names and the snippet list does not", () => {
			const masked = sendConsoleRows(
				send({
					response: response({
						requestHeaders: {
							apikey: "K-1",
							Token: "T-1",
							"X-Plain": "visible",
							Cookie: "",
						},
					}),
				})
			)[0] as ConsoleSendRow;
			expect(masked.exchange.requestHeaders).toEqual({
				apikey: "<redacted>",
				Token: "<redacted>",
				"X-Plain": "visible",
				Cookie: "",
			});
		});

		it("keeps the copied cURL free of those values", () => {
			const masked = sendConsoleRows(
				send({
					response: response({
						requestHeaders: { apikey: "K-1", token: "T-1", "X-Plain": "visible" },
					}),
				})
			)[0] as ConsoleSendRow;
			const code = consoleRowCurl(masked);
			expect(code).not.toContain("K-1");
			expect(code).not.toContain("T-1");
			expect(code).toContain("visible");
		});

		it("keeps a challenge header the server sent", () => {
			const masked = sendConsoleRows(
				send({
					response: response({
						status: 401,
						headers: {
							"WWW-Authenticate": 'Bearer realm="api"',
							"Proxy-Authenticate": "Basic",
							"Authentication-Info": "nextnonce=1",
						},
					}),
				})
			)[0] as ConsoleSendRow;
			expect(masked.exchange.responseHeaders).toEqual({
				"WWW-Authenticate": 'Bearer realm="api"',
				"Proxy-Authenticate": "Basic",
				"Authentication-Info": "nextnonce=1",
			});
		});

		describe("every name the engine fixture lists", () => {
			const [fixturePath] =
				ENGINE_READING_GUARDS.consoleHeaderMasking.paths.map(fromRepoRoot);
			const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
				secretFieldNames: string[];
				challengeHeaderNames: string[];
			};
			const isChallenge = (name: string) =>
				fixture.challengeHeaderNames.includes(name.toLowerCase());
			const sentWith = (name: string) =>
				(
					sendConsoleRows(
						send({
							response: response({
								requestHeaders: { [name]: "V-1" },
								authHeaders: [],
							}),
						})
					)[0] as ConsoleSendRow
				).exchange.requestHeaders[name];

			it("read a non-empty fixture", () => {
				expect(fixture.secretFieldNames.length).toBeGreaterThan(0);
				expect(fixture.challengeHeaderNames.length).toBeGreaterThan(0);
			});

			it.each(fixture.secretFieldNames.filter((name) => !isChallenge(name)))(
				"masks %s",
				(name) => {
					expect(sentWith(name)).toBe("<redacted>");
				}
			);

			it.each(fixture.challengeHeaderNames)("keeps %s", (name) => {
				expect(sentWith(name)).toBe("V-1");
			});
		});

		it("keeps both bodies intact", () => {
			expect(row().exchange.requestBody).toEqual({
				text: '{"grant":"password","password":"hunter2"}',
			});
			expect(row().exchange.responseBody).toEqual({ text: '{"token":"issued"}' });
		});
	});

	it("keeps no response body for a send that failed before an answer", () => {
		const rows = sendConsoleRows(
			send({
				response: response({
					status: 0,
					headers: {},
					body: "connection refused",
					bodyRaw: undefined,
					errorCode: "CONNECTION_FAILED",
					errorMessage: "connection refused",
				}),
			})
		);
		const failed = rows[0] as ConsoleSendRow;
		expect(failed).toMatchObject({ status: 0, errorCode: "CONNECTION_FAILED" });
		expect(failed.exchange.responseBody).toBeUndefined();
	});
});

describe("stepConsoleRow", () => {
	const frame: ScenarioStepEvent = {
		iteration: 1,
		stepIndex: 2,
		name: "Get token",
		outcome: "passed",
		statusCode: 200,
		latencyMs: 15,
		method: "POST",
		url: "https://api.test/token?access_token=<redacted>",
		bodyBytes: 120,
		requestId: "req_7",
	};

	it("carries the frame's identity and summary", () => {
		expect(stepConsoleRow("run_3", frame)).toEqual({
			kind: "step",
			runId: "run_3",
			iteration: 1,
			stepIndex: 2,
			name: "Get token",
			outcome: "passed",
			method: "POST",
			url: "https://api.test/token?access_token=<redacted>",
			status: 200,
			timeMs: 15,
			sizeBytes: 120,
			requestId: "req_7",
		});
	});

	it("leaves out what a step that sent nothing has none of", () => {
		const row = stepConsoleRow("run_3", {
			iteration: 0,
			stepIndex: 0,
			name: "Skipped",
			outcome: "skipped",
			statusCode: 0,
			latencyMs: 0,
		});
		expect(row).not.toHaveProperty("method");
		expect(row).not.toHaveProperty("url");
		expect(row).not.toHaveProperty("sizeBytes");
	});
});
