/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test, vi } from "vitest";
import { dispatchTool, MAX_INLINE_BODY_BYTES, TOOLS } from "./tools.js";
import type { McpSafetyConfig } from "./config.js";
import { EngineRequestError, type EngineClient } from "./engine-client.js";
import { REDACTED_MARKER, withheldPointer } from "./withhold.js";
import {
	descriptionOf,
	page,
	lastPageAnswer,
	fakeClient,
	ctxWith,
	firstText,
	engineErrorBody,
	ctxAsking,
	askedQuestion,
} from "./tools.testkit.js";
import {
	REVEAL,
	ALLOW_API,
	read,
	RUN_SECRET,
	RUN_SECRET_CORES,
	RUN_LEAKS,
	PERCENT_FORM,
	QUERY_FORM,
	runClient,
	expectRunOutputWithheld,
	expectTraceMasked,
	EXECUTE_ANSWER,
	sendRequest,
	RUN_REPORT,
} from "./tools.withholding.testkit.js";

describe("secret withholding", () => {
	test("run_request masks every secret form and credential header in the exchange", async () => {
		const client = runClient({ executeRequest: vi.fn().mockResolvedValue(EXECUTE_ANSWER) });
		const { text, body } = await sendRequest(client);
		expectRunOutputWithheld(text);
		expect(body).toEqual({
			status: 200,
			headers: { "Set-Cookie": "<redacted>", "Content-Type": "application/json" },
			headerLines: [
				{ name: "Set-Cookie", value: "<redacted>" },
				{ name: "Content-Type", value: "application/json" },
				{ name: "set-cookie", value: "<redacted>" },
			],
			requestHeaders: {
				Authorization: "<redacted>",
				"X-Tenant-Key": "<redacted>",
				"X-Echo": "<redacted>",
				Accept: "*/*",
			},
			rawRequest:
				"POST /v1?key=<redacted> HTTP/1.1\r\nHost: api.example.com\r\n" +
				"Authorization: <redacted>\r\nX-Req-Key: <redacted>\r\n" +
				"Cookie: {{session}}\r\nAccept: */*\r\n\r\n" +
				'<login pw="<redacted>"><redacted></login>',
			body: { echo: "<redacted>" },
			bodyRaw: '{"echo":"<redacted>"}',
			bodySize: 4321,
			bodyCapped: false,
		});
	});

	test("run_request masks credential lines in requestHeaderLines, every repeat, keeping names and order (#2466)", async () => {
		// Mutation check: match only `headers` / `headerLines` and these lines
		// read back verbatim.
		const lines = [
			{ name: "Authorization", value: "Bearer typed-bearer-token" },
			{ name: "authorization", value: "Bearer second-typed-token" },
			{ name: "Cookie", value: "sid=request-cookie-value" },
			{ name: "Cookie", value: "theme=dark" },
			{ name: "X-Api-Key", value: "api-key-line-value" },
			{ name: "X-Plain", value: "kept-one" },
			{ name: "X-Plain", value: "kept-two" },
		];
		const client = runClient({
			executeRequest: vi.fn().mockResolvedValue({
				...EXECUTE_ANSWER,
				requestHeaderLines: lines,
			}),
		});
		const { text, body } = await sendRequest(client);
		expect(body.requestHeaderLines).toEqual([
			{ name: "Authorization", value: "<redacted>" },
			{ name: "authorization", value: "<redacted>" },
			{ name: "Cookie", value: "<redacted>" },
			{ name: "Cookie", value: "<redacted>" },
			{ name: "X-Api-Key", value: "<redacted>" },
			{ name: "X-Plain", value: "kept-one" },
			{ name: "X-Plain", value: "kept-two" },
		]);
		for (const leak of ["typed-bearer-token", "second-typed-token", "request-cookie-value"]) {
			expect(text).not.toContain(leak);
		}

		const revealed = await sendRequest(
			runClient({
				executeRequest: vi
					.fn()
					.mockResolvedValue({ ...EXECUTE_ANSWER, requestHeaderLines: lines }),
			}),
			REVEAL
		);
		expect(revealed.body.requestHeaderLines).toEqual(lines);
	});

	test("run_request passes a followed redirect through and masks the hop's Set-Cookie and url credential (#2461, #2949)", async () => {
		const hop = {
			status: 302,
			statusText: "Found",
			headerLines: [
				{ name: "Set-Cookie", value: "session=hop-cookie-value; Path=/" },
				{ name: "Location", value: "http://api.example.com/home" },
			],
			url: "https://api.example.com/login?api_key=hop-url-key-value",
			schemeDowngrade: true,
		};
		const client = runClient({
			executeRequest: vi.fn().mockResolvedValue({ ...EXECUTE_ANSWER, redirects: [hop] }),
		});
		const { text, body } = await sendRequest(client);
		expect(text).not.toContain("hop-cookie-value");
		expect(text).not.toContain("hop-url-key-value");
		expect(body.redirects).toEqual([
			{
				status: 302,
				statusText: "Found",
				headerLines: [
					{ name: "Set-Cookie", value: "<redacted>" },
					{ name: "Location", value: "http://api.example.com/home" },
				],
				url: "https://api.example.com/login?api_key=<redacted>",
				schemeDowngrade: true,
			},
		]);
	});

	test("run_request returns the exchange as the engine answered it with reveal on", async () => {
		const client = runClient({ executeRequest: vi.fn().mockResolvedValue(EXECUTE_ANSWER) });
		const { body } = await sendRequest(client, REVEAL);
		expect(body).toEqual(EXECUTE_ANSWER);
		// The identity costs nothing: no secret is read to build it.
		expect(client.getGlobals).not.toHaveBeenCalled();
		expect(client.listAllRequests).not.toHaveBeenCalled();
	});

	test("run_request masks the query value and headers the live answer says auth wrote (#1845)", async () => {
		const TOKEN = "oauth-token-placed-by-the-engine-55";
		const SESSION = "session-header-value-66";
		const answer = {
			...EXECUTE_ANSWER,
			// The answer's `url` is the dialled one (#3650), raw, so the placed
			// token is in it and in the request line of `rawRequest`.
			method: "GET",
			url: `https://u:pw-literal-77@api.example.com/v1?page=2&access_token=${TOKEN}`,
			authQueryParam: "access_token",
			authHeaders: ["X-Session"],
			requestHeaders: { "X-Session": SESSION, Accept: "*/*" },
			rawRequest:
				`GET /v1?page=2&access_token=${TOKEN} HTTP/1.1\r\nHost: api.example.com\r\n` +
				`X-Session: ${SESSION}\r\n\r\n`,
		};
		const client = runClient({ executeRequest: vi.fn().mockResolvedValue(answer) });
		const withheld = await sendRequest(client);
		expect(withheld.text).not.toContain(TOKEN);
		expect(withheld.text).not.toContain(SESSION);
		expect(withheld.text).not.toContain("pw-literal-77");
		expect(withheld.body.url).toBe(
			"https://u@api.example.com/v1?page=2&access_token=<redacted>"
		);
		expect(withheld.body.authQueryParam).toBe("access_token");
		expect(withheld.body.requestHeaders).toEqual({ "X-Session": "<redacted>", Accept: "*/*" });
		expect(withheld.body.rawRequest).toBe(
			"GET /v1?page=2&access_token=<redacted> HTTP/1.1\r\nHost: api.example.com\r\n" +
				"X-Session: <redacted>\r\n\r\n"
		);
		const revealed = await sendRequest(client, REVEAL);
		expect(revealed.body).toEqual(answer);
	});

	test("run_request passes the engine's authNotice through, masked or revealed (#2474)", async () => {
		// The agent that sees a 401 from a request whose auth mode is not
		// executed is the reader who most needs to be told it was never sent.
		const NOTICE =
			"auth mode 'ntlm' is not executed by Vayu; the request was sent without authentication";
		const answer = { ...EXECUTE_ANSWER, status: 401, authNotice: NOTICE };
		const client = runClient({ executeRequest: vi.fn().mockResolvedValue(answer) });
		const withheld = await sendRequest(client);
		expect(withheld.body.authNotice).toBe(NOTICE);
		const revealed = await sendRequest(client, REVEAL);
		expect(revealed.body.authNotice).toBe(NOTICE);
		// A response without the key stays without it, so the pass-through adds no
		// empty field for an executed mode.
		const plain = runClient({ executeRequest: vi.fn().mockResolvedValue(EXECUTE_ANSWER) });
		expect("authNotice" in (await sendRequest(plain)).body).toBe(false);
	});

	test("run_request passes the engine's warnings through, masked or revealed, empty or not (#3307)", async () => {
		// An agent debugging a cookie-bearing flow needs to be told a cookie was
		// left off the line or discarded; the message names it, never its value.
		const warnings = [
			{
				code: "cookie_not_sent",
				message: "The cookie 'session' did not fit in the Cookie header and was left out.",
			},
		];
		const client = runClient({
			executeRequest: vi.fn().mockResolvedValue({ ...EXECUTE_ANSWER, warnings }),
		});
		expect((await sendRequest(client)).body.warnings).toEqual(warnings);
		expect((await sendRequest(client, REVEAL)).body.warnings).toEqual(warnings);
		// The live body always carries the key, `[]` when empty: kept as is, so an
		// agent can tell "none" from an engine too old to warn.
		const none = runClient({
			executeRequest: vi.fn().mockResolvedValue({ ...EXECUTE_ANSWER, warnings: [] }),
		});
		expect((await sendRequest(none)).body.warnings).toEqual([]);
	});

	test("run_request masks the header an inline API-key auth names", async () => {
		const client = runClient({
			executeRequest: vi.fn().mockResolvedValue({
				...EXECUTE_ANSWER,
				requestHeaders: { "X-Inline-Key": "inline-typed-key" },
			}),
		});
		const { text, body } = await read("run_request", client, ALLOW_API, {
			url: "https://api.example.com/v1",
			auth: { mode: "apikey", key: "X-Inline-Key", value: "inline-typed-key", in: "header" },
		});
		expect(text).not.toContain("inline-typed-key");
		expect(body.requestHeaders).toEqual({ "X-Inline-Key": "<redacted>" });
	});

	test("run_request masks a streamed run's events unless revealed", async () => {
		const events = [{ event: "token", data: `{"t":"glob-secret-1","u":"${PERCENT_FORM}"}` }];
		const client = runClient({
			executeRequest: vi
				.fn()
				.mockResolvedValue({ runId: "run_s", eventsUrl: "/runs/run_s/events" }),
			consumeStreamEvents: vi
				.fn()
				.mockResolvedValue({ events, completed: true, capReached: false }),
		});
		const args = { url: "https://api.example.com/v1", stream: true };
		const withheld = await read("run_request", client, ALLOW_API, args);
		expectRunOutputWithheld(withheld.text);
		expect(withheld.body.events).toEqual([
			{ event: "token", data: '{"t":"<redacted>","u":"<redacted>"}' },
		]);
		const revealed = await read("run_request", client, { ...ALLOW_API, ...REVEAL }, args);
		expect(revealed.body.events).toEqual(events);
	});

	// Mutation check: return the joined text without `withhold` and it carries
	// the secret, which no row reveals once the reply is split across events.
	test("run_request masks a streamed run's text, joined across events, unless revealed", async () => {
		const events = [
			{ event: "token", data: "{}", text: "key glob-" },
			{ event: "token", data: "{}", text: "secret-1 ok" },
		];
		const client = runClient({
			composeRequest: vi.fn().mockResolvedValue({
				method: "GET",
				url: "https://api.example.com/v1",
				stream: true,
				streamTextPath: "$.t",
			}),
			executeRequest: vi
				.fn()
				.mockResolvedValue({ runId: "run_s", eventsUrl: "/runs/run_s/events" }),
			consumeStreamEvents: vi
				.fn()
				.mockResolvedValue({ events, completed: true, capReached: false }),
		});
		const args = { requestId: "req_1", events: false };
		const withheld = await read("run_request", client, ALLOW_API, args);
		expect(withheld.body.text).toBe("key <redacted> ok");
		expect(withheld.body).not.toHaveProperty("events");
		const revealed = await read("run_request", client, { ...ALLOW_API, ...REVEAL }, args);
		expect(revealed.body.text).toBe("key glob-secret-1 ok");
	});

	test("get_run_report masks the stored trace and keeps its shape", async () => {
		const client = runClient({ getRunReport: vi.fn().mockResolvedValue(RUN_REPORT) });
		const { text, body } = await read("get_run_report", client, undefined, { runId: "run_1" });
		expectRunOutputWithheld(text);
		expectTraceMasked(body.results[0].trace);
		expect(body.metadata.requestUrl).toBe("https://api.example.com/v1?key=<redacted>");
		expect(body.summary).toEqual(RUN_REPORT.summary);
	});

	test("get_run_report returns the stored trace whole with reveal on", async () => {
		const client = runClient({ getRunReport: vi.fn().mockResolvedValue(RUN_REPORT) });
		const { body } = await read("get_run_report", client, REVEAL, { runId: "run_1" });
		expect(body).toEqual(RUN_REPORT);
	});

	test("get_run masks a secret in the snapshot fields it echoes unless revealed", async () => {
		// `duration` is echoed; the secret reaching it shows the mask runs before
		// the projection, so what the projection keeps cannot carry a secret.
		const row = {
			id: "run_1",
			type: "load",
			status: "running",
			startTime: 1_755_000_000_000,
			endTime: 1_755_000_000_000,
			configSnapshot: {
				url: `https://api.example.com/v1?key=${QUERY_FORM}`,
				mode: "constant_rps",
				duration: "glob-secret-1",
			},
		};
		const client = runClient({ getRun: vi.fn().mockResolvedValue(row) });
		const withheld = await read("get_run", client, undefined, { runId: "run_1" });
		expect(withheld.text).not.toContain("glob-secret-1");
		for (const leak of RUN_SECRET_CORES) expect(withheld.text).not.toContain(leak);
		expect(withheld.body.duration).toBe("<redacted>");
		expect(withheld.body.plannedDurationMs).toBeNull();
		const revealed = await read("get_run", client, REVEAL, { runId: "run_1" });
		expect(revealed.body.duration).toBe("glob-secret-1");
	});

	test("get_run_report masks before it cuts, so no prefix of a secret survives the cut", async () => {
		// The secret straddles the per-body cut: bounded first, its first three
		// bytes would be left behind where no form can match them.
		const body = "x".repeat(MAX_INLINE_BODY_BYTES - 3) + "col-secret-9" + "y".repeat(100);
		const report = { results: [{ id: 1, trace: { response: { body } } }] };
		const client = runClient({ getRunReport: vi.fn().mockResolvedValue(report) });
		const out = await read("get_run_report", client, undefined, { runId: "run_1" });
		const cut = out.body.results[0].trace.response;
		expect(cut.bodyTruncated).toBe(true);
		expect(cut.body.endsWith("<re")).toBe(true);
		expect(cut.body).not.toContain("col");
	});

	test("get_run_samples masks a sample's Set-Cookie and body unless revealed", async () => {
		const samples = page([
			{
				resultId: 1,
				response: {
					headers: {
						"set-cookie": "sid=resp-cookie-value",
						"content-type": "text/plain",
					},
					body: `token=glob-secret-1&p=${PERCENT_FORM}`,
					bodyBytes: 40,
				},
			},
		]);
		const client = runClient({ getRunSamples: vi.fn().mockResolvedValue(samples) });
		const withheld = await read("get_run_samples", client, undefined, { runId: "run_1" });
		expectRunOutputWithheld(withheld.text);
		expect(withheld.body.data[0].response).toEqual({
			headers: { "set-cookie": "<redacted>", "content-type": "text/plain" },
			body: "token=<redacted>&p=<redacted>",
			bodyBytes: 40,
		});
		expect(withheld.body.pagination).toEqual(lastPageAnswer(samples).pagination);
		const revealed = await read("get_run_samples", client, REVEAL, { runId: "run_1" });
		expect(revealed.body).toEqual(lastPageAnswer(samples));
	});

	const RUN_ROW = {
		id: "run_1",
		type: "design",
		baseline: true,
		summary: {
			url: `https://api.example.com/v1?key=${PERCENT_FORM}`,
			comment: "after rotating col-secret-9",
			// The rows' file (issue #2051): a name and a digest, no secret in
			// either, so withholding passes both through.
			dataFileName: "users.csv",
			dataFileHash: "c".repeat(64),
			dataFileCastNumbers: true,
		},
	};

	test("list_runs masks a run row's summary unless revealed", async () => {
		const runs = page([RUN_ROW]);
		const client = runClient({ listRuns: vi.fn().mockResolvedValue(runs) });
		const withheld = await read("list_runs", client);
		expectRunOutputWithheld(withheld.text);
		expect(withheld.body.data[0].summary).toEqual({
			url: "https://api.example.com/v1?key=<redacted>",
			comment: "after rotating <redacted>",
			dataFileName: "users.csv",
			dataFileHash: "c".repeat(64),
			dataFileCastNumbers: true,
		});
		expect((await read("list_runs", client, REVEAL)).body).toEqual(lastPageAnswer(runs));
	});

	test("set_run_baseline masks the run row it echoes unless revealed", async () => {
		const client = runClient({ setRunBaseline: vi.fn().mockResolvedValue(RUN_ROW) });
		const args = { runId: "run_1", baseline: true };
		const withheld = await read("set_run_baseline", client, { allowWrites: true }, args);
		expectRunOutputWithheld(withheld.text);
		expect(withheld.body.summary.url).toBe("https://api.example.com/v1?key=<redacted>");
		const revealed = await read(
			"set_run_baseline",
			client,
			{ allowWrites: true, ...REVEAL },
			args
		);
		expect(revealed.body).toEqual(RUN_ROW);
	});

	test("get_inbox_captures masks a capture's credential headers and secrets unless revealed", async () => {
		const captures = page([
			{
				id: 1,
				method: "POST",
				path: "/hook",
				query: `token=${QUERY_FORM}`,
				headers: { Authorization: "Bearer typed-bearer-token", "User-Agent": "sender/1" },
				body: JSON.stringify({ key: RUN_SECRET }),
				bodyBytes: 30,
				bodyTruncated: false,
			},
		]);
		const client = runClient({ getInboxCaptures: vi.fn().mockResolvedValue(captures) });
		const withheld = await read("get_inbox_captures", client, undefined, {
			inboxId: "inbox_1",
		});
		expectRunOutputWithheld(withheld.text);
		expect(withheld.body.data[0]).toMatchObject({
			query: "token=<redacted>",
			headers: { Authorization: "<redacted>", "User-Agent": "sender/1" },
			body: '{"key":"<redacted>"}',
			bodyBytes: 30,
		});
		const revealed = await read("get_inbox_captures", client, REVEAL, { inboxId: "inbox_1" });
		expect(revealed.body).toEqual(lastPageAnswer(captures));
	});

	test("get_run_samples masks a secret inside a base64 sample body and keeps it base64", async () => {
		const bytes = Buffer.concat([Buffer.from([0xff, 0x00]), Buffer.from(`key=${RUN_SECRET}`)]);
		const samples = page([
			{
				resultId: 1,
				response: {
					headers: {},
					body: bytes.toString("base64"),
					bodyEncoding: "base64",
					bodyBytes: bytes.length,
				},
			},
		]);
		const client = runClient({ getRunSamples: vi.fn().mockResolvedValue(samples) });
		const withheld = await read("get_run_samples", client, undefined, { runId: "run_1" });
		const { response } = withheld.body.data[0];
		expect(response.bodyEncoding).toBe("base64");
		expect(response.bodyBytes).toBe(bytes.length);
		const decoded = Buffer.from(response.body, "base64").toString("latin1");
		expect(decoded).not.toContain(RUN_SECRET);
		expect(decoded).toContain("key=<redacted>");
		const revealed = await read("get_run_samples", client, REVEAL, { runId: "run_1" });
		expect(revealed.body).toEqual(lastPageAnswer(samples));
	});

	test("get_inbox_captures masks a secret inside a base64 capture body and keeps it base64", async () => {
		// A multipart upload or a protobuf is not UTF-8, so the engine sends it
		// base64 (#3109); the secret is in the bytes, not in the base64 text.
		const bytes = Buffer.concat([
			Buffer.from([0xff, 0xfe]),
			Buffer.from(`key=${RUN_SECRET}`),
			Buffer.from([0x00]),
		]);
		const captures = page([
			{
				id: 1,
				method: "POST",
				path: "/hook",
				headers: {},
				body: bytes.toString("base64"),
				bodyEncoding: "base64",
				bodyBytes: bytes.length,
				bodyTruncated: false,
			},
		]);
		const client = runClient({ getInboxCaptures: vi.fn().mockResolvedValue(captures) });
		const withheld = await read("get_inbox_captures", client, undefined, {
			inboxId: "inbox_1",
		});
		const [capture] = withheld.body.data;
		expect(capture.bodyEncoding).toBe("base64");
		expect(capture.bodyBytes).toBe(bytes.length);
		const decoded = Buffer.from(capture.body, "base64").toString("latin1");
		expect(decoded).not.toContain(RUN_SECRET);
		expect(decoded).toContain("key=<redacted>");
		const revealed = await read("get_inbox_captures", client, REVEAL, { inboxId: "inbox_1" });
		expect(revealed.body).toEqual(lastPageAnswer(captures));
	});

	test("get_mock_activity masks a secret in a logged path unless revealed", async () => {
		// The engine logs `req.path`, which cpp-httplib splits from the query, so a
		// query never reaches the log today; the by-value mask covers it all the same.
		const activity = {
			data: [
				{
					at_ms: 3,
					method: "GET",
					path: `/db/${PERCENT_FORM}`,
					status: 200,
					request_id: "r1",
				},
				{ at_ms: 2, method: "GET", path: `/x?token=${QUERY_FORM}`, status: 404 },
				{ at_ms: 1, method: "GET", path: "/db/glob-secret-1/ping", status: 501 },
				{ at_ms: 0, method: "POST", path: "/health", status: 200, injected_error: false },
			],
		};
		const client = runClient({ getMockServerActivity: vi.fn().mockResolvedValue(activity) });
		const withheld = await read("get_mock_activity", client, undefined, { mockId: "mock_1" });
		for (const leak of RUN_LEAKS) expect(withheld.text, leak).not.toContain(leak);
		expect(withheld.body.data).toEqual([
			{ ...activity.data[0], path: "/db/<redacted>" },
			{ ...activity.data[1], path: "/x?token=<redacted>" },
			{ ...activity.data[2], path: "/db/<redacted>/ping" },
			activity.data[3],
		]);
		const revealed = await read("get_mock_activity", client, REVEAL, { mockId: "mock_1" });
		expect(revealed.body).toMatchObject(activity);
	});

	test("a failed secret lookup fails the read closed, naming the lookup and returning nothing", async () => {
		const client = runClient({
			getGlobals: vi.fn().mockRejectedValue(new Error("engine hiccup")),
			getRunReport: vi.fn().mockResolvedValue(RUN_REPORT),
		});
		const res = await dispatchTool("get_run_report", { runId: "run_1" }, ctxWith(client));
		expect(res.isError).toBe(true);
		const text = firstText(res);
		expect(text).toMatch(/masking .* could not complete, because the globals lookup/);
		expect(text).toContain("engine hiccup");
		// None of the report, masked or not: the other reads answered, but a
		// partly masked record is the leak this refuses.
		expect(text).not.toContain("api.example.com");
		for (const leak of RUN_LEAKS) expect(text, leak).not.toContain(leak);
		expect(res.content).toHaveLength(1);

		const revealed = await read("get_run_report", client, REVEAL, { runId: "run_1" });
		expect(revealed.body).toEqual(RUN_REPORT);
	});

	/*
	 * An engine refusal reaches the agent in the tool's error text. The engine
	 * words its refusals to quote no resolved value, and this server does not
	 * rely on that: the text is masked as a run's output is, or answered whole as
	 * the masking error. Mutation check: drop `maskEngineText` from
	 * `dispatchTool`, and the first two cases leak.
	 */
	describe("an engine refusal's text", () => {
		const secretRefusal = (status: number) =>
			new EngineRequestError(
				`Engine responded ${status}`,
				status,
				engineErrorBody("invalid_header_name", `header 'X ${RUN_SECRET}' is not a name`)
			);
		const refusedClient = (overrides: Partial<Record<keyof EngineClient, unknown>> = {}) =>
			runClient({
				getRunReport: vi.fn().mockRejectedValue(secretRefusal(400)),
				restoreTrashEntry: vi.fn().mockRejectedValue(secretRefusal(404)),
				...overrides,
			});
		const calls: Array<[string, Record<string, unknown>, Partial<McpSafetyConfig>]> = [
			["get_run_report", { runId: "run_1" }, {}],
			["restore_trash_entry", { entryId: "t1" }, { allowWrites: true }],
		];

		test.each(calls)(
			"%s is masked, keeping its class and its status",
			async (tool, args, safety) => {
				const res = await dispatchTool(tool, args, ctxWith(refusedClient(), safety));

				expect(res.isError).toBe(true);
				const text = firstText(res);
				for (const leak of RUN_SECRET_CORES) expect(text, leak).not.toContain(leak);
				expect(text).toContain("<redacted>");
				expect(text).toContain("is not a name");
				const { error } = res.structuredContent as {
					error: { class: string; advice: string };
				};
				expect(error.advice).toBe(text);
				expect(error.class).toBe(tool === "get_run_report" ? "input" : "not_found");
			}
		);

		test.each(calls)(
			"%s arrives untouched when the user chose to reveal",
			async (tool, args, safety) => {
				const client = refusedClient();
				const res = await dispatchTool(
					tool,
					args,
					ctxWith(client, { ...safety, revealSecretsToAgents: true })
				);

				expect(firstText(res)).toContain("p@ss");
				expect(client.getGlobals).not.toHaveBeenCalled();
			}
		);

		test.each(calls)(
			"%s fails closed when a secret lookup fails",
			async (tool, args, safety) => {
				const client = refusedClient({
					getGlobals: vi.fn().mockRejectedValue(new Error("engine hiccup")),
				});
				const res = await dispatchTool(tool, args, ctxWith(client, safety));

				const text = firstText(res);
				expect(text).toMatch(/masking .* could not complete, because the globals lookup/);
				expect(text).not.toContain("is not a name");
				for (const leak of RUN_SECRET_CORES) expect(text, leak).not.toContain(leak);
			}
		);

		test("an error holding no engine text needs no secret lookup", async () => {
			const client = refusedClient({ getGlobals: vi.fn().mockRejectedValue(new Error("x")) });
			const res = await dispatchTool("get_run_report", {}, ctxWith(client));

			expect(firstText(res)).toBe('"runId" is required.');
			expect(client.getGlobals).not.toHaveBeenCalled();
		});
	});

	/*
	 * With the engine down the masking lookup is the first thing to fail, but the
	 * outage is the news: a Reveal secrets setting must never read as its remedy
	 * (#2780).
	 */
	describe("a failed secret lookup is worded by its cause", () => {
		const failWith = (cause: unknown) =>
			dispatchTool(
				"list_runs",
				{},
				ctxWith(runClient({ getGlobals: vi.fn().mockRejectedValue(cause) }))
			);

		test("an engine that is down leads with the outage, not the setting", async () => {
			const res = await failWith(new TypeError("fetch failed"));
			const text = firstText(res);
			expect(text.startsWith("Could not reach the Vayu engine")).toBe(true);
			expect(text).toContain("withheld whole");
			expect(text).not.toMatch(/Reveal secrets/i);
			expect(res.structuredContent).toMatchObject({
				error: { class: "unreachable", retryable: true },
			});
		});

		test("an engine that answered 5xx leads with its answer and stays transient", async () => {
			const res = await failWith(
				new EngineRequestError("Engine responded 500 for GET /globals", 500, "boom")
			);
			const text = firstText(res);
			expect(text.startsWith("Engine error (500)")).toBe(true);
			expect(text).toContain("withheld whole");
			expect(text).not.toMatch(/Reveal secrets/i);
			expect(res.structuredContent).toMatchObject({ error: { class: "transient" } });
		});

		test.each([
			["a cause that says nothing about the engine", new Error("engine hiccup")],
			["an engine refusal of the lookup itself", new EngineRequestError("403", 403, "no")],
		])("%s keeps the masking message", async (_, cause) => {
			const res = await failWith(cause);
			const text = firstText(res);
			expect(text.startsWith("Nothing is returned: masking this result's secrets")).toBe(
				true
			);
			expect(text).not.toContain("Unexpected error");
			expect(res.structuredContent).toMatchObject({ error: { class: "transient" } });
		});
	});

	test.each([
		["list_runs", {}],
		["get_run", { runId: "run_1" }],
		["get_run_samples", { runId: "run_1" }],
		["get_inbox_captures", { inboxId: "inbox_1" }],
		["get_mock_activity", { mockId: "mock_1" }],
		["run_request", { url: "https://api.example.com/v1" }],
	])("%s fails closed on a failed secret lookup too", async (tool, args) => {
		const client = runClient({
			listAllRequests: vi.fn().mockRejectedValue(new Error("engine hiccup")),
			executeRequest: vi.fn().mockResolvedValue(EXECUTE_ANSWER),
		});
		const res = await dispatchTool(tool, args, ctxWith(client, ALLOW_API));
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/the requests lookup .*failed \(engine hiccup\)/);
	});

	test("get_run_report masks a stored auth's literal key the engine wrote into the URL", async () => {
		const STORED_KEY = "stored-query-key-77";
		const report = {
			results: [
				{
					id: 1,
					trace: {
						request: {
							url: `https://api.example.com/v1?api_key=${STORED_KEY}`,
							rawRequest: `GET /v1?api_key=${STORED_KEY} HTTP/1.1\r\nHost: api.example.com\r\n\r\n`,
						},
					},
				},
			],
		};
		const client = runClient({
			listAllRequests: vi.fn().mockResolvedValue([
				{
					id: "r9",
					auth: { mode: "apikey", key: "api_key", value: STORED_KEY, in: "query" },
				},
			]),
			getRunReport: vi.fn().mockResolvedValue(report),
		});
		const withheld = await read("get_run_report", client, undefined, { runId: "run_1" });
		expect(withheld.text).not.toContain(STORED_KEY);
		expect(withheld.body.results[0].trace.request).toEqual({
			url: "https://api.example.com/v1?api_key=<redacted>",
			rawRequest: "GET /v1?api_key=<redacted> HTTP/1.1\r\nHost: api.example.com\r\n\r\n",
		});
		const revealed = await read("get_run_report", client, REVEAL, { runId: "run_1" });
		expect(revealed.body).toEqual(report);
	});

	test("get_run_report masks the query value and headers the trace says auth wrote (#1835)", async () => {
		const TOKEN = "oauth-token-from-the-store-88";
		const SESSION = "session-header-value-99";
		const request = {
			authQueryParam: "access_token",
			authHeaders: ["X-Session"],
			url: `https://api.example.com/v1?page=2&access_token=${TOKEN}`,
			headers: { "X-Session": SESSION },
			sentHeaders: { "X-Session": SESSION },
			rawRequest:
				`GET /v1?page=2&access_token=${TOKEN} HTTP/1.1\r\nHost: api.example.com\r\n` +
				`X-Session: ${SESSION}\r\n\r\n`,
		};
		const report = { results: [{ id: 1, trace: { request } }] };
		const client = runClient({ getRunReport: vi.fn().mockResolvedValue(report) });
		const withheld = await read("get_run_report", client, undefined, { runId: "run_1" });
		expect(withheld.text).not.toContain(TOKEN);
		expect(withheld.text).not.toContain(SESSION);
		expect(withheld.body.results[0].trace.request).toEqual({
			authQueryParam: "access_token",
			authHeaders: ["X-Session"],
			url: "https://api.example.com/v1?page=2&access_token=<redacted>",
			headers: { "X-Session": "<redacted>" },
			sentHeaders: { "X-Session": "<redacted>" },
			rawRequest:
				"GET /v1?page=2&access_token=<redacted> HTTP/1.1\r\nHost: api.example.com\r\n" +
				"X-Session: <redacted>\r\n\r\n",
		});
		const revealed = await read("get_run_report", client, REVEAL, { runId: "run_1" });
		expect(revealed.body).toEqual(report);
	});

	/** Three saved requests: one that runs and fails a test, one off the allowlist, one that errors. */
	const smokeClient = () =>
		runClient({
			listRequests: vi.fn().mockResolvedValue([
				{ id: "r_ok", name: "Runs" },
				{ id: "r_off", name: "Off the list" },
				{ id: "r_err", name: "Errors" },
			]),
			composeRequest: vi.fn().mockImplementation((body: { requestId?: string }) =>
				Promise.resolve(
					body.requestId === "r_off"
						? { method: "GET", url: "https://elsewhere.test/?k=glob-secret-1" }
						: {
								method: "GET",
								url: `https://api.example.com/v1?key=${QUERY_FORM}&id=${body.requestId}`,
							}
				)
			),
			executeRequest: vi.fn().mockImplementation((payload: { url: string }) =>
				payload.url.endsWith("r_err")
					? Promise.reject(new Error(`connect failed for ${payload.url}`))
					: Promise.resolve({
							status: 200,
							testResults: [
								{ name: "token echoed", passed: false, error: "got col-secret-9" },
							],
						})
			),
		});

	test("run_collection_smoke masks each row's URL, test lines and error unless revealed", async () => {
		const client = smokeClient();
		const args = { collectionId: "c1" };
		const withheld = await read("run_collection_smoke", client, ALLOW_API, args);
		expectRunOutputWithheld(withheld.text);
		expect(withheld.body.results).toEqual([
			{
				name: "Runs",
				method: "GET",
				url: "https://api.example.com/v1?key=<redacted>&id=r_ok",
				ok: false,
				statusCode: 200,
				tests: { total: 1, failed: 1, failures: ["token echoed: got <redacted>"] },
			},
			{
				name: "Off the list",
				method: "GET",
				url: "https://elsewhere.test/?k=<redacted>",
				ok: false,
				skipped: true,
				reason: expect.stringContaining("elsewhere.test"),
			},
			{
				name: "Errors",
				method: "GET",
				url: "https://api.example.com/v1?key=<redacted>&id=r_err",
				ok: false,
				error: "connect failed for https://api.example.com/v1?key=<redacted>&id=r_err",
			},
		]);

		const revealed = await read(
			"run_collection_smoke",
			client,
			{ ...ALLOW_API, ...REVEAL },
			args
		);
		expect(revealed.text).toContain(QUERY_FORM);
		expect(revealed.body.results[1].url).toBe("https://elsewhere.test/?k=glob-secret-1");
		expect(revealed.body.results[2].error).toContain(QUERY_FORM);
	});

	test("run_collection_smoke masks a secret in the engine's own error message (#3552)", async () => {
		const client = runClient({
			listRequests: vi.fn().mockResolvedValue([{ id: "r_ok", name: "Times out" }]),
			composeRequest: vi.fn().mockResolvedValue({
				method: "GET",
				url: `https://api.example.com/v1?key=${QUERY_FORM}`,
			}),
			executeRequest: vi.fn().mockImplementation((payload: { url: string }) =>
				Promise.resolve({
					status: 0,
					errorCode: "TIMEOUT",
					errorMessage: `no answer from ${payload.url}`,
				})
			),
		});
		const withheld = await read("run_collection_smoke", client, ALLOW_API, {
			collectionId: "c1",
		});
		expect(withheld.body.results[0].error).toBe(
			"TIMEOUT: no answer from https://api.example.com/v1?key=<redacted>"
		);
		const revealed = await read(
			"run_collection_smoke",
			client,
			{ ...ALLOW_API, ...REVEAL },
			{ collectionId: "c1" }
		);
		expect(revealed.body.results[0].error).toContain(QUERY_FORM);
	});

	test("run_collection_smoke reads no secret to return its matrix with reveal on", async () => {
		const client = smokeClient();
		await read(
			"run_collection_smoke",
			client,
			{ ...ALLOW_API, ...REVEAL },
			{ collectionId: "c1" }
		);
		expect(client.getGlobals).not.toHaveBeenCalled();
		expect(client.listAllRequests).not.toHaveBeenCalled();
	});

	test("run_collection_smoke withholds a stored URL's credentials on a request that fails to compose", async () => {
		const stored = "https://u:p4ssw0rd@api.example.com/x?api_key=S3CRET&page=2&tenant=T3NANT";
		const client = runClient({
			listRequests: vi.fn().mockResolvedValue([
				{
					id: "r_bad",
					name: "Unresolvable",
					method: "GET",
					url: stored,
					auth: { mode: "apikey", key: "tenant", value: "x", in: "query" },
				},
			]),
			composeRequest: vi
				.fn()
				.mockRejectedValue(new Error("variable {{missing}} is undefined")),
		});
		const args = { collectionId: "c1" };
		const withheld = await read("run_collection_smoke", client, ALLOW_API, args);
		for (const leak of ["p4ssw0rd", "S3CRET", "T3NANT"])
			expect(withheld.text).not.toContain(leak);
		expect(withheld.body.results[0]).toMatchObject({
			ok: false,
			url: "https://u@api.example.com/x?api_key=&page=2&tenant=",
		});

		const revealed = await read(
			"run_collection_smoke",
			client,
			{ ...ALLOW_API, ...REVEAL },
			args
		);
		expect(revealed.body.results[0].url).toBe(stored);
	});

	test("run_collection_smoke withholds a literal URL credential on every composed row kind", async () => {
		const typed = "https://u:S3cret@api.example.com/x?api_key=LIT&tenant=T3NANT";
		const client = runClient({
			listRequests: vi.fn().mockResolvedValue([
				{ id: "r_ok", name: "Runs" },
				{ id: "r_off", name: "Off the list" },
				{ id: "r_err", name: "Errors" },
			]),
			composeRequest: vi.fn().mockImplementation((body: { requestId?: string }) =>
				Promise.resolve({
					method: "GET",
					url: {
						r_ok: typed,
						r_off: "https://elsewhere.test/x?api_key=LIT",
						r_err: `${typed}&id=err`,
					}[body.requestId ?? ""],
					// An inherited API-key auth the stored row does not carry.
					auth: { mode: "apikey", key: "tenant", value: "x", in: "query" },
				})
			),
			executeRequest: vi
				.fn()
				.mockImplementation((payload: { url: string }) =>
					payload.url.endsWith("id=err")
						? Promise.reject(new Error("connect failed"))
						: Promise.resolve({ status: 200 })
				),
		});
		const args = { collectionId: "c1" };
		const withheld = await read("run_collection_smoke", client, ALLOW_API, args);
		for (const leak of ["S3cret", "LIT", "T3NANT"]) expect(withheld.text).not.toContain(leak);
		expect(withheld.body.results.map((row: { url: string }) => row.url)).toEqual([
			"https://u@api.example.com/x?api_key=&tenant=",
			"https://elsewhere.test/x?api_key=",
			"https://u@api.example.com/x?api_key=&tenant=&id=err",
		]);
		expect(
			withheld.body.results.map((row: Record<string, unknown>) => row.skipped ?? false)
		).toEqual([false, true, false]);
		expect(withheld.body.results[2].error).toBe("connect failed");
		// The send and the allowlist read the real URL, not the projection.
		expect(client.executeRequest).toHaveBeenCalledTimes(2);
		expect(client.executeRequest).toHaveBeenCalledWith(
			expect.objectContaining({ url: typed }),
			undefined
		);

		const revealed = await read(
			"run_collection_smoke",
			client,
			{ ...ALLOW_API, ...REVEAL },
			args
		);
		expect(revealed.body.results.map((row: { url: string }) => row.url)).toEqual([
			typed,
			"https://elsewhere.test/x?api_key=LIT",
			`${typed}&id=err`,
		]);
	});

	/** A composed load target carrying a secret in its query, a header and its auth block. */
	const LOAD_TARGET = {
		method: "GET",
		url: `https://api.example.com/v1?key=${QUERY_FORM}`,
		headers: { Authorization: "Bearer typed-bearer-token", "X-Echo": "glob-secret-1" },
		auth: { mode: "bearer", token: "typed-bearer-token" },
	};

	const planLoadRun = (client: EngineClient, safety: Partial<McpSafetyConfig> = {}) => {
		const ctx = ctxWith(client, { ...ALLOW_API, ...safety });
		return dispatchTool("start_load_run", { requestId: "req_1", duration: "10s" }, ctx);
	};

	test("start_load_run's preview shows the planned run masked, its auth withheld", async () => {
		const client = runClient({ composeRequest: vi.fn().mockResolvedValue(LOAD_TARGET) });
		const preview = firstText(await planLoadRun(client));
		expect(preview).toMatch(/AWAITING CONFIRMATION/);
		expectRunOutputWithheld(preview);
		const planned = JSON.parse(
			preview.slice(preview.indexOf("{"), preview.lastIndexOf("}") + 1)
		);
		expect(planned).toMatchObject({
			url: "https://api.example.com/v1?key=<redacted>",
			headers: { Authorization: "<redacted>", "X-Echo": "<redacted>" },
			auth: { mode: "bearer", tokenWithheld: true },
		});
		expect(planned.auth).not.toHaveProperty("token");
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("start_load_run's confirmation question names the masked target", async () => {
		const client = runClient({ composeRequest: vi.fn().mockResolvedValue(LOAD_TARGET) });
		const asked = await dispatchTool(
			"start_load_run",
			{ requestId: "req_1", duration: "10s" },
			ctxAsking(client, ALLOW_API)
		);
		const message = askedQuestion(asked);
		expect(message).toContain("https://api.example.com/v1?key=<redacted>");
		expect(message).not.toContain("p@ss");
	});

	test("start_load_run's preview is the planned run as composed with reveal on, with no secret read", async () => {
		const client = runClient({ composeRequest: vi.fn().mockResolvedValue(LOAD_TARGET) });
		const preview = firstText(await planLoadRun(client, REVEAL));
		expect(preview).toContain(QUERY_FORM);
		expect(preview).toContain('"token":"typed-bearer-token"');
		expect(client.getGlobals).not.toHaveBeenCalled();
		expect(client.listAllRequests).not.toHaveBeenCalled();
	});

	test("compare_runs forwards no recorded string, so there is nothing for it to mask", async () => {
		const client = runClient({ getRunReport: vi.fn().mockResolvedValue(RUN_REPORT) });
		const res = await dispatchTool(
			"compare_runs",
			{ baseRunId: "run_0", targetRunId: "run_1" },
			ctxWith(client, REVEAL)
		);
		expect(res.isError).toBeFalsy();
		for (const leak of RUN_LEAKS) expect(JSON.stringify(res), leak).not.toContain(leak);
	});

	describe("export_run_report", () => {
		const exportOf = (text: string) =>
			runClient({
				exportRunReport: vi.fn().mockResolvedValue({ text, fileName: "r.run.json" }),
			});
		const exported = (client: EngineClient, safety?: Partial<McpSafetyConfig>) =>
			dispatchTool("export_run_report", { runId: "run_1" }, ctxWith(client, safety));

		test("masks a secret typed into a run comment unless revealed", async () => {
			const raw = `Rolled out with ${RUN_SECRET} as the password`;
			const asJson = JSON.stringify({ comment: raw });
			for (const text of [raw, asJson]) {
				const withheld = firstText(await exported(exportOf(text)));
				expect(withheld).not.toContain("w/rd");
				expect(withheld).toContain("<redacted> as the password");

				const revealed = firstText(await exported(exportOf(text), REVEAL));
				expect(revealed).toBe(text);
			}
		});

		test("reads no secret scope when reveal is on", async () => {
			const client = exportOf("plain");
			await exported(client, REVEAL);
			expect(client.getGlobals).not.toHaveBeenCalled();
		});

		test("fails whole when a masking read fails, rather than export unmasked", async () => {
			const client = runClient({
				exportRunReport: vi.fn().mockResolvedValue({ text: RUN_SECRET }),
				listEnvironments: vi.fn().mockRejectedValue(new Error("engine unreachable")),
			});
			const res = await exported(client);
			expect(res.isError).toBe(true);
			expect(firstText(res)).not.toContain("w/rd");
		});
	});

	const SPEC_DIFF = {
		identical: false,
		added: [],
		removed: [],
		unchanged: 0,
		unmapped: 0,
		changed: [
			{
				requestId: "req_1",
				name: "Me",
				fields: [
					{
						field: "headers",
						current: "2: Authorization=Bearer typed-bearer-token, Accept=json",
						next: "1: Accept=json",
						userTouched: false,
					},
					{ field: "url", current: "{{baseUrl}}/me", next: "{{baseUrl}}/v2/me" },
				],
			},
			{
				requestId: "req_2",
				name: "Referenced",
				fields: [
					{
						field: "headers",
						current: "1: Authorization={{token}}",
						next: "0: none",
						userTouched: true,
					},
				],
			},
		],
	};

	test("diff_spec withholds a stored header line that names a credential unless revealed", async () => {
		const client = fakeClient({ diffSpec: vi.fn().mockResolvedValue(SPEC_DIFF) });
		const args = { collectionId: "c1", content: "{}" };
		const withheld = await read("diff_spec", client, undefined, args);
		expect(withheld.text).not.toContain("typed-bearer-token");
		expect(withheld.body.changed[0].fields).toEqual([
			{ field: "headers", next: "1: Accept=json", userTouched: false, currentWithheld: true },
			{
				field: "url",
				current: "{{baseUrl}}/me",
				next: "{{baseUrl}}/v2/me",
				userTouched: false,
			},
		]);
		// A pure reference names where the secret lives without being it.
		expect(withheld.body.changed[1].fields[0].current).toBe("1: Authorization={{token}}");
		const revealed = await read("diff_spec", client, REVEAL, args);
		expect(revealed.body.changed[0].fields[0].current).toBe(
			"2: Authorization=Bearer typed-bearer-token, Accept=json"
		);
	});

	test("diff_spec withholds a stored URL and params line that could hold a credential unless revealed", async () => {
		const diff = {
			...SPEC_DIFF,
			changed: [
				{
					requestId: "req_1",
					name: "Credentialed",
					fields: [
						{
							field: "url",
							current: "https://u:p4ssw0rd@h/x?api_key=S3CRET",
							next: "{{baseUrl}}/x",
						},
						{ field: "params", current: "2: page=2, token=T0KEN", next: "1: page=2" },
					],
				},
				{
					requestId: "req_2",
					name: "Cut in the userinfo",
					fields: [
						{
							field: "url",
							current: "https://admin:hunt\u2026",
							next: "{{baseUrl}}/y",
						},
					],
				},
				{
					requestId: "req_3",
					name: "Benign",
					fields: [
						{
							field: "url",
							current: "{{baseUrl}}/z?page=2",
							next: "{{baseUrl}}/z?page=3",
						},
						{ field: "params", current: "1: page=2", next: "1: page=3" },
					],
				},
			],
		};
		const client = fakeClient({ diffSpec: vi.fn().mockResolvedValue(diff) });
		const args = { collectionId: "c1", content: "{}" };
		const withheld = await read("diff_spec", client, undefined, args);
		for (const leak of ["p4ssw0rd", "S3CRET", "T0KEN", "hunt"]) {
			expect(withheld.text).not.toContain(leak);
		}
		const [credentialed, cut, benign] = withheld.body.changed;
		expect(credentialed.fields).toEqual([
			{ field: "url", next: "{{baseUrl}}/x", userTouched: false, currentWithheld: true },
			{ field: "params", next: "1: page=2", userTouched: false, currentWithheld: true },
		]);
		expect(cut.fields).toEqual([
			{ field: "url", next: "{{baseUrl}}/y", userTouched: false, currentWithheld: true },
		]);
		expect(benign.fields).toEqual([
			{
				field: "url",
				current: "{{baseUrl}}/z?page=2",
				next: "{{baseUrl}}/z?page=3",
				userTouched: false,
			},
			{ field: "params", current: "1: page=2", next: "1: page=3", userTouched: false },
		]);

		const revealed = await read("diff_spec", client, REVEAL, args);
		expect(revealed.body.changed[0].fields[0].current).toBe(
			"https://u:p4ssw0rd@h/x?api_key=S3CRET"
		);
		expect(revealed.body.changed[0].fields[1].current).toBe("2: page=2, token=T0KEN");
		expect(revealed.body.changed[1].fields[0].current).toBe("https://admin:hunt\u2026");
	});

	describe("diff_spec reads the stored auth for a custom API-key query name", () => {
		const TENANT_DIFF = {
			...SPEC_DIFF,
			changed: [
				{
					requestId: "req_url",
					name: "Key in the url",
					fields: [
						{
							field: "url",
							current: "https://h/x?tenant=ACME-URL-SECRET&page=2",
							next: "{{baseUrl}}/x",
						},
					],
				},
				{
					requestId: "req_params",
					name: "Key in the params",
					fields: [
						{
							field: "params",
							current: "2: page=2, tenant=ACME-ROW-SECRET",
							next: "1: page=2",
						},
						{ field: "headers", current: "1: Accept=json", next: "0: none" },
					],
				},
				{
					requestId: "req_plain",
					name: "No key",
					fields: [
						{ field: "params", current: "1: tenant=acme", next: "1: tenant=beta" },
					],
				},
			],
		};
		const AUTH_BY_ID: Record<string, unknown> = {
			req_url: { mode: "apikey", in: "query", key: "tenant", value: "ACME-URL-SECRET" },
			req_params: { mode: "apikey", in: "query", key: "Tenant", value: "ACME-ROW-SECRET" },
			req_plain: { mode: "none" },
		};
		const clientWith = (getRequest: unknown) =>
			fakeClient({ diffSpec: vi.fn().mockResolvedValue(TENANT_DIFF), getRequest });
		const args = { collectionId: "c1", content: "{}" };

		test("withholds the key's value from a url and a params line unless revealed", async () => {
			const getRequest = vi.fn(async (id: string) => ({ id, auth: AUTH_BY_ID[id] }));
			const client = clientWith(getRequest);
			const withheld = await read("diff_spec", client, undefined, args);
			for (const leak of ["ACME-URL-SECRET", "ACME-ROW-SECRET"]) {
				expect(withheld.text).not.toContain(leak);
			}
			const [url, params, plain] = withheld.body.changed;
			expect(url.fields[0]).toMatchObject({ field: "url", currentWithheld: true });
			expect(url.fields[0]).not.toHaveProperty("current");
			expect(params.fields[0]).toMatchObject({ field: "params", currentWithheld: true });
			expect(params.fields[1].current).toBe("1: Accept=json");
			// `tenant` is only a credential under a request that names it as its key.
			expect(plain.fields[0].current).toBe("1: tenant=acme");
			expect(getRequest.mock.calls.map(([id]) => id).sort()).toEqual([
				"req_params",
				"req_plain",
				"req_url",
			]);
		});

		test("reads nothing and returns the lines as written with reveal on", async () => {
			const getRequest = vi.fn(async (id: string) => ({ id, auth: AUTH_BY_ID[id] }));
			const revealed = await read("diff_spec", clientWith(getRequest), REVEAL, args);
			expect(getRequest).not.toHaveBeenCalled();
			expect(revealed.body.changed[0].fields[0].current).toBe(
				"https://h/x?tenant=ACME-URL-SECRET&page=2"
			);
			expect(revealed.body.changed[1].fields[0].current).toBe(
				"2: page=2, tenant=ACME-ROW-SECRET"
			);
		});

		test("withholds a url and params line it could not read the auth for", async () => {
			const getRequest = vi.fn(async (id: string) => {
				if (id === "req_plain") return { id, auth: AUTH_BY_ID[id] };
				throw new Error("engine unreachable");
			});
			const withheld = await read("diff_spec", clientWith(getRequest), undefined, args);
			for (const leak of ["ACME-URL-SECRET", "ACME-ROW-SECRET"]) {
				expect(withheld.text).not.toContain(leak);
			}
			const [url, params, plain] = withheld.body.changed;
			expect(url.fields[0].currentWithheld).toBe(true);
			expect(params.fields[0].currentWithheld).toBe(true);
			expect(params.fields[1].currentWithheld).toBe(true);
			expect(plain.fields[0].current).toBe("1: tenant=acme");
		});

		test("withholds when the lookup answers with something that is not a request", async () => {
			const withheld = await read(
				"diff_spec",
				clientWith(vi.fn().mockResolvedValue(null)),
				undefined,
				args
			);
			expect(withheld.text).not.toContain("ACME-URL-SECRET");
			expect(withheld.body.changed[0].fields[0].currentWithheld).toBe(true);
		});
	});

	describe("diff_spec reads the stored auth for a custom API-key header name", () => {
		const HEADER_DIFF = {
			...SPEC_DIFF,
			changed: [
				{
					requestId: "req_key",
					name: "Key in a header",
					fields: [
						{
							field: "headers",
							current: "2: Accept=json, X-Tenant=ACME-HEADER-SECRET",
							next: "1: Accept=json",
						},
					],
				},
				{
					requestId: "req_plain",
					name: "No key",
					fields: [
						{
							field: "headers",
							current: "2: Accept=json, X-Tenant=acme",
							next: "1: Accept=json",
						},
					],
				},
			],
		};
		const AUTH_BY_ID: Record<string, unknown> = {
			req_key: { mode: "apikey", in: "header", key: "X-Tenant", value: "ACME-HEADER-SECRET" },
			req_plain: { mode: "none" },
		};
		const clientWith = (getRequest: unknown) =>
			fakeClient({ diffSpec: vi.fn().mockResolvedValue(HEADER_DIFF), getRequest });
		const args = { collectionId: "c1", content: "{}" };

		test("withholds the key's row from a headers line unless revealed", async () => {
			const getRequest = vi.fn(async (id: string) => ({ id, auth: AUTH_BY_ID[id] }));
			const withheld = await read("diff_spec", clientWith(getRequest), undefined, args);
			expect(withheld.text).not.toContain("ACME-HEADER-SECRET");
			const [key, plain] = withheld.body.changed;
			expect(key.fields[0]).toMatchObject({ field: "headers", currentWithheld: true });
			expect(key.fields[0]).not.toHaveProperty("current");
			// `X-Tenant` is only a credential under a request that names it as its key.
			expect(plain.fields[0].current).toBe("2: Accept=json, X-Tenant=acme");

			getRequest.mockClear();
			const revealed = await read("diff_spec", clientWith(getRequest), REVEAL, args);
			expect(getRequest).not.toHaveBeenCalled();
			expect(revealed.body.changed[0].fields[0].current).toBe(
				"2: Accept=json, X-Tenant=ACME-HEADER-SECRET"
			);
		});

		test("withholds a headers line it could not read the auth for", async () => {
			const getRequest = vi.fn(async (id: string) => {
				if (id === "req_plain") return { id, auth: AUTH_BY_ID[id] };
				throw new Error("engine unreachable");
			});
			const withheld = await read("diff_spec", clientWith(getRequest), undefined, args);
			expect(withheld.text).not.toContain("ACME-HEADER-SECRET");
			const [key, plain] = withheld.body.changed;
			expect(key.fields[0].currentWithheld).toBe(true);
			expect(plain.fields[0].current).toBe("2: Accept=json, X-Tenant=acme");
		});
	});

	test.each([
		"run_request",
		"get_run",
		"get_run_report",
		"export_run_report",
		"get_run_samples",
		"list_runs",
		"set_run_baseline",
		"get_inbox_captures",
	])("%s points at what it withholds from run output, only while reveal is off", (name) => {
		// The rules themselves are the server instructions' (server-host.test.ts).
		const tool = TOOLS.find((t) => t.name === name);
		const pointer = withheldPointer({ revealSecretsToAgents: false }, "recorded");
		expect(pointer).toContain(REDACTED_MARKER);
		expect(descriptionOf(tool)).toContain(pointer);
		expect(descriptionOf(tool, { revealSecretsToAgents: true })).not.toContain(REDACTED_MARKER);
	});

	test("get_mock_activity points at what it withholds, only while reveal is off", () => {
		const tool = TOOLS.find((t) => t.name === "get_mock_activity");
		expect(descriptionOf(tool)).toContain(
			withheldPointer({ revealSecretsToAgents: false }, "recorded")
		);
		expect(descriptionOf(tool, { revealSecretsToAgents: true })).not.toContain(REDACTED_MARKER);
	});
});
