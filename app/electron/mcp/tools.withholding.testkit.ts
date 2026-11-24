/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file tools.withholding.testkit.ts
 * @brief What the `tools.withholding*.test.ts` files share: the read helpers and
 *        the run-exchange fixtures a withheld secret is looked for in.
 */

import { expect, vi } from "vitest";
import { dispatchTool } from "./tools.js";
import type { McpSafetyConfig } from "./config.js";
import type { EngineClient } from "./engine-client.js";
import { fakeClient, ctxWith, firstText } from "./tools.testkit.js";

export const REVEAL = { revealSecretsToAgents: true };
export const ALLOW_API = { allowlist: ["api.example.com"] };

export const read = async (
	tool: string,
	client: EngineClient,
	safety?: Partial<McpSafetyConfig>,
	args: Record<string, unknown> = {}
) => {
	const res = await dispatchTool(tool, args, ctxWith(client, safety));
	expect(res.isError).toBeFalsy();
	return { text: firstText(res), body: JSON.parse(firstText(res)) };
};

/** A paged list read for whole rows, its `data` as `body`. */
export const readFull = async (
	tool: string,
	client: EngineClient,
	safety?: Partial<McpSafetyConfig>,
	args: Record<string, unknown> = {}
) => {
	const { text, body } = await read(tool, client, safety, { ...args, fields: "full" });
	return { text, body: body.data };
};

// What a run recorded carries the secrets it sent, in whatever encoding they
// went out in, and the credential headers on both sides of the exchange: the
// engine's snapshot rule masks them in place (#1809).
export const RUN_SECRET = 'p@ss "w/rd"&x';
/** Each of `RUN_SECRET`'s forms holds one of these, so their absence is every form's. */
export const RUN_SECRET_CORES = ["p@ss", "p%40ss"];
export const RUN_LEAKS = [
	...RUN_SECRET_CORES,
	"glob-secret-1",
	"col-secret-9",
	"typed-bearer-token",
	"resp-cookie-value",
	"theme=dark",
	"req-typed-key",
	"tenant-typed-key",
];
export const PERCENT_FORM = "p%40ss%20%22w%2Frd%22%26x";
export const QUERY_FORM = "p@ss%20%22w/rd%22%26x";
export const XML_FORM = 'p@ss "w/rd"&amp;x';

/** The reads `runOutputShape` makes, holding one secret per scope. */
export const runScopes = () => ({
	getGlobals: vi.fn().mockResolvedValue({
		id: "globals",
		variables: { gtok: { value: "glob-secret-1", secret: true, enabled: true } },
	}),
	listEnvironments: vi.fn().mockResolvedValue([
		{
			id: "env_1",
			variables: {
				pass: { value: RUN_SECRET, secret: true, enabled: true },
				// Under the engine's four-byte floor: masked nowhere.
				short: { value: "abc", secret: true, enabled: true },
				plain: { value: "visible-value", enabled: true },
			},
		},
	]),
	listCollections: vi.fn().mockResolvedValue([
		{
			id: "c1",
			variables: { ck: { value: "col-secret-9", secret: true } },
			auth: { mode: "apikey", key: "X-Tenant-Key", in: "header" },
		},
	]),
	listAllRequests: vi
		.fn()
		.mockResolvedValue([
			{ id: "r1", auth: { mode: "apikey", key: "X-Req-Key", value: "v", in: "header" } },
		]),
});

/** One trace node pair as `build_result_trace` stores it, every form of every secret on it. */
export const RUN_TRACE = {
	request: {
		method: "POST",
		url: `https://api.example.com/v1?key=${QUERY_FORM}&abc=1&plain=visible-value`,
		headers: {
			Authorization: "Bearer typed-bearer-token",
			"X-Tenant-Key": "tenant-typed-key",
			"X-Echo": "glob-secret-1",
			Accept: "*/*",
		},
		body: JSON.stringify({ password: RUN_SECRET, region: "eu" }),
		rawRequest:
			`POST /v1?key=${PERCENT_FORM} HTTP/1.1\r\nHost: api.example.com\r\n` +
			"Authorization: Bearer typed-bearer-token\r\nX-Req-Key: req-typed-key\r\n" +
			"Cookie: {{session}}\r\nAccept: */*\r\n\r\n" +
			`<login pw="${XML_FORM}">col-secret-9</login>`,
	},
	response: {
		headers: {
			"Set-Cookie": "sid=resp-cookie-value; HttpOnly",
			"Content-Type": "application/json",
		},
		// The rows as received (#2460): the Set-Cookie the map folds is a row each.
		headerLines: [
			{ name: "Set-Cookie", value: "sid=resp-cookie-value; HttpOnly" },
			{ name: "Content-Type", value: "application/json" },
			{ name: "set-cookie", value: "theme=dark" },
		],
		body: JSON.stringify({ echo: RUN_SECRET }),
		bodyBytes: 4321,
	},
};

export const runClient = (overrides: Partial<Record<keyof EngineClient, unknown>>) =>
	fakeClient({ ...runScopes(), ...overrides });

export function expectRunOutputWithheld(text: string) {
	for (const leak of RUN_LEAKS) expect(text, leak).not.toContain(leak);
	expect(text).toContain("<redacted>");
}

/** A trace node pair after the mask: every value gone, every name, order and size kept. */
export function expectTraceMasked(trace: typeof RUN_TRACE) {
	expect(trace.request.url).toBe(
		"https://api.example.com/v1?key=<redacted>&abc=1&plain=visible-value"
	);
	expect(trace.request.headers).toEqual({
		Authorization: "<redacted>",
		"X-Tenant-Key": "<redacted>",
		"X-Echo": "<redacted>",
		Accept: "*/*",
	});
	expect(JSON.parse(trace.request.body)).toEqual({ password: "<redacted>", region: "eu" });
	expect(trace.request.rawRequest).toBe(
		"POST /v1?key=<redacted> HTTP/1.1\r\nHost: api.example.com\r\n" +
			"Authorization: <redacted>\r\nX-Req-Key: <redacted>\r\n" +
			"Cookie: {{session}}\r\nAccept: */*\r\n\r\n" +
			'<login pw="<redacted>"><redacted></login>'
	);
	expect(trace.response.headers).toEqual({
		"Set-Cookie": "<redacted>",
		"Content-Type": "application/json",
	});
	expect(trace.response.headerLines).toEqual([
		{ name: "Set-Cookie", value: "<redacted>" },
		{ name: "Content-Type", value: "application/json" },
		{ name: "set-cookie", value: "<redacted>" },
	]);
	expect(JSON.parse(trace.response.body)).toEqual({ echo: "<redacted>" });
	expect(trace.response.bodyBytes).toBe(4321);
}

export const EXECUTE_ANSWER = {
	status: 200,
	headers: RUN_TRACE.response.headers,
	headerLines: RUN_TRACE.response.headerLines,
	requestHeaders: RUN_TRACE.request.headers,
	rawRequest: RUN_TRACE.request.rawRequest,
	body: { echo: RUN_SECRET },
	bodyRaw: RUN_TRACE.response.body,
	bodySize: 4321,
	bodyCapped: false,
};

export const sendRequest = (client: EngineClient, safety: Partial<McpSafetyConfig> = {}) =>
	read(
		"run_request",
		client,
		{ ...ALLOW_API, ...safety },
		{
			url: "https://api.example.com/v1",
		}
	);

export const RUN_REPORT = {
	metadata: {
		runId: "run_1",
		status: "completed",
		requestUrl: `https://api.example.com/v1?key=${QUERY_FORM}`,
	},
	summary: { totalRequests: 1 },
	results: [{ id: 1, statusCode: 200, trace: RUN_TRACE }],
};
