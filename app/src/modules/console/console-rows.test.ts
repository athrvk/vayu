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
 * Mutation check: pass `[]` for `authHeaders` in `sendRow` and "a custom
 * API-key header named by authHeaders" stores the key in clear; drop the
 * `authQueryParam` extra name and "masks a query name only the send's auth
 * claims" fails; build
 * the rows in `consoleRows` order without the pre/post split and "lists a Send's
 * rows in execution order" fails.
 */

import { describe, expect, it } from "vitest";
import type { ConsoleLogEntry, ScenarioStepEvent, ScriptRequestRecord } from "@/types";
import type { ResponseState } from "@/modules/request-builder/types";
import type { ConsoleScriptRequestRow, ConsoleSendRow } from "@/stores/console-store";
import { sendConsoleRows, type CompletedSend } from "./console-rows";
import { stepConsoleRow } from "./step-row";

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
			expect(row().url).toBe("https://alice@api.test/token?access_token=<redacted>&page=2");
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
		url: "https://api.test/token?access_token=",
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
			url: "https://api.test/token?access_token=",
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
