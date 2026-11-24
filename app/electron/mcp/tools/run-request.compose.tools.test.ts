/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { dispatchTool, TOOLS } from "../tools.js";
import type { EngineClient } from "../engine-client.js";
import { REVEAL_SETTING_TOKEN, resolveRemedyTokens } from "../remedy.js";
import {
	descriptionOf,
	listingEnv1,
	fakeClient,
	ctxWith,
	firstText,
	parseArgs,
	savedRequestClient,
} from "../tools.testkit.js";

describe("dispatchTool", () => {
	test.each(["run_request", "start_load_run"])(
		"%s rejects both names for one script rather than picking one",
		async (name) => {
			// Two different scripts under two names for one slot: whichever is
			// dropped, the agent is told the run validated something it did not.
			const client = fakeClient();
			const res = await dispatchTool(
				name,
				parseArgs(name, {
					url: "https://api.example.com",
					...(name === "start_load_run" ? { confirmed: true } : {}),
					postRequestScript: "pm.test('a', () => {});",
					tests: "pm.test('b', () => {});",
				}),
				ctxWith(client, { allowlist: ["api.example.com"], revealSecretsToAgents: true })
			);

			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/not both/i);
			expect(client.startRun).not.toHaveBeenCalled();
			expect(client.executeRequest).not.toHaveBeenCalled();
		}
	);

	/*
	 * #1834: with Reveal secrets to agents off, an agent-written script is
	 * refused before anything is composed or sent, because a script reads every
	 * variable the request resolves against, secret ones included.
	 */
	describe("agent-supplied scripts while Reveal secrets to agents is off", () => {
		const target = { url: "https://api.example.com/users", confirmed: true };
		const OFF = { allowlist: ["api.example.com"] };
		const ON = { allowlist: ["api.example.com"], revealSecretsToAgents: true };
		const script = (kind: string, text = "pm.environment.get('token');") => ({
			kind,
			config: { script: text },
		});

		const expectRefusedUntouched = (
			res: { isError?: boolean; content: Array<{ text: string }> },
			client: EngineClient,
			named: string
		) => {
			expect(res.isError).toBe(true);
			expect(firstText(res)).toContain(named);
			expect(firstText(res)).toContain("Reveal secrets to agents");
			expect(client.composeRequest).not.toHaveBeenCalled();
			expect(client.executeRequest).not.toHaveBeenCalled();
			expect(client.startRun).not.toHaveBeenCalled();
		};

		test.each([
			["preRequestScript", { preRequestScript: "pm.request.headers.add('a', 'b')" }],
			["postRequestScript", { postRequestScript: "pm.test('ok', () => {})" }],
			["tests", { tests: "pm.test('ok', () => {})" }],
			["elements", { elements: [script("script.pre")] }],
			["elements", { elements: [script("script.post")] }],
			["elements", { elements: [script("script.setup")] }],
			["elements", { elements: [script("script.teardown")] }],
			["elements", { elements: [script("SCRIPT.Pre")] }],
			["elements", { elements: [script("  script.post ")] }],
			[
				"elements",
				{
					elements: [
						{ kind: "assert.duration", config: { maxMs: 5 } },
						script("script.pre"),
					],
				},
			],
			["elements", { elements: [{ ...script("script.pre"), enabled: false }] }],
		])("run_request refuses %s", async (named, extra) => {
			const client = fakeClient();
			const res = await dispatchTool(
				"run_request",
				{ ...target, ...extra },
				ctxWith(client, OFF)
			);
			expectRefusedUntouched(res, client, `"${named}"`);
		});

		test("run_request names every offending argument", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"run_request",
				{
					...target,
					preRequestScript: "a();",
					postRequestScript: "b();",
					elements: [script("script.post")],
				},
				ctxWith(client, OFF)
			);
			expectRefusedUntouched(
				res,
				client,
				'"preRequestScript", "postRequestScript", "elements"'
			);
		});

		test.each([
			["postRequestScript", { postRequestScript: "pm.test('ok', () => {})" }],
			["tests", { tests: "pm.test('ok', () => {})" }],
		])("start_load_run refuses %s", async (named, extra) => {
			const client = fakeClient();
			const res = await dispatchTool(
				"start_load_run",
				{ ...target, ...extra },
				ctxWith(client, OFF)
			);
			expectRefusedUntouched(res, client, `"${named}"`);
		});

		test("start_load_run refuses a script override of a saved request, too", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"start_load_run",
				{
					requestId: "req_1",
					postRequestScript: "pm.test('ok', () => {})",
					confirmed: true,
				},
				ctxWith(client, OFF)
			);
			expectRefusedUntouched(res, client, '"postRequestScript"');
		});

		test.each([
			["run_request", { preRequestScript: "a();", postRequestScript: "b();" }],
			["start_load_run", { postRequestScript: "b();" }],
		])("%s sends the same scripts once reveal is on", async (name, scripts) => {
			const client = fakeClient();
			const res = await dispatchTool(name, { ...target, ...scripts }, ctxWith(client, ON));
			expect(res.isError).toBeFalsy();
			expect(client.composeRequest).toHaveBeenCalled();
		});

		test("run_request passes extractors, assertions and timers with reveal off", async () => {
			const client = fakeClient();
			const elements = [
				{ kind: "extract.jsonpath", config: { path: "$.id", variable: "id" } },
				{ kind: "assert.duration", config: { maxMs: 500 } },
				{ kind: "timer.think", config: { ms: 10 } },
			];
			const res = await dispatchTool(
				"run_request",
				{ ...target, elements },
				ctxWith(client, OFF)
			);
			expect(res.isError).toBeFalsy();
			const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(payload.elements).toEqual(elements);
		});

		test.each([
			["empty", ""],
			["whitespace-only", " \t\r\n "],
		])("a %s script is inert in the engine and is not refused", async (_label, blank) => {
			const client = fakeClient();
			const res = await dispatchTool(
				"run_request",
				{
					...target,
					preRequestScript: blank,
					postRequestScript: blank,
					elements: [script("script.setup", blank), { kind: "script.teardown" }],
				},
				ctxWith(client, OFF)
			);
			expect(res.isError).toBeFalsy();
			expect(client.executeRequest).toHaveBeenCalled();
		});

		test("run_request with a url and a requestId link sends with reveal off", async () => {
			// With a `url` the send is ad hoc: `requestId` links History and composes
			// nothing stored, so no stored script rides it.
			const client = fakeClient();
			const res = await dispatchTool(
				"run_request",
				{ ...target, requestId: "req_1" },
				ctxWith(client, OFF)
			);
			expect(res.isError).toBeFalsy();
			const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(payload.requestId).toBe("req_1");
		});

		test("start_load_run of a saved request that stores scripts still runs with reveal off", async () => {
			const client = savedRequestClient();
			const res = await dispatchTool(
				"start_load_run",
				{ requestId: "req_1", duration: "30s", confirmed: true },
				ctxWith(client, OFF)
			);
			expect(res.isError).toBeFalsy();
			expect(client.startRun).toHaveBeenCalled();
		});

		test("the descriptions say what is refused and where the setting lives", () => {
			for (const name of ["run_request", "start_load_run"]) {
				const description = descriptionOf(TOOLS.find((t) => t.name === name));
				expect(description).toContain(REVEAL_SETTING_TOKEN);
				expect(resolveRemedyTokens(description, "app")).toContain(
					"Reveal secrets to agents"
				);
				expect(description).toMatch(/script you supply here .* is refused/);
			}
		});
	});

	/*
	 * #2435: `run_request` with a `requestId` and no `url` sends the saved
	 * request as the app's Send does; with a `url` it is ad hoc and `requestId`
	 * only links the run.
	 */
	describe("run_request by saved request id", () => {
		const OFF = { allowlist: ["api.example.com"] };
		const composeBody = (client: EngineClient) =>
			(client.composeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
				string,
				unknown
			>;
		const executed = (client: EngineClient) =>
			(client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
				string,
				unknown
			>;

		test("composes the stored row and executes what comes back, stored auth included", async () => {
			const auth = { mode: "bearer", token: "{{apiToken}}" };
			const client = savedRequestClient({ auth });
			const res = await dispatchTool(
				"run_request",
				{ requestId: "req_1", environmentId: "env_1" },
				ctxWith(client, OFF)
			);
			expect(res.isError).toBeFalsy();
			expect(composeBody(client)).toMatchObject({
				requestId: "req_1",
				environmentId: "env_1",
			});
			// Nothing inline: the stored row defines the request.
			expect(composeBody(client).request).toBeUndefined();
			expect(executed(client)).toMatchObject({
				url: "https://api.example.com/users",
				method: "POST",
				headers: { "X-Api": "v1" },
				auth,
				requestId: "req_1",
			});
			expect(executed(client).elements).toHaveLength(3);
		});

		test("inline fields lay over the stored request without a url", async () => {
			const client = savedRequestClient();
			const res = await dispatchTool(
				"run_request",
				{ requestId: "req_1", headers: { "X-Extra": "1" }, method: "put" },
				ctxWith(client, OFF)
			);
			expect(res.isError).toBeFalsy();
			expect(composeBody(client).request).toEqual({
				method: "PUT",
				headers: { "X-Extra": "1" },
			});
			// Not the ad-hoc default: a stored POST must not become a GET.
			const bare = savedRequestClient();
			await dispatchTool("run_request", { requestId: "req_1" }, ctxWith(bare, OFF));
			expect(executed(bare).method).toBe("POST");
		});

		test("headers given as ordered lines reach compose as the lines, a repeat kept (#2466)", async () => {
			// Mutation check: read only the map form and the lines are dropped, so
			// compose answers the stored headers.
			const client = savedRequestClient();
			const lines = [
				{ name: "X-Dup", value: "one" },
				{ name: "x-dup", value: "two" },
				{ name: "X-Dup", value: "three" },
			];
			const res = await dispatchTool(
				"run_request",
				{ requestId: "req_1", headers: lines },
				ctxWith(client, OFF)
			);
			expect(res.isError).toBeFalsy();
			expect(composeBody(client).request).toEqual({ headers: lines });
		});

		test("a header line that names nothing is refused by position, not forwarded", async () => {
			const client = savedRequestClient();
			const res = await dispatchTool(
				"run_request",
				{ url: "https://api.example.com/x", headers: [{ name: "A", value: "1" }, 7] },
				ctxWith(client, OFF)
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toContain("headers[1]");
			expect(client.composeRequest).not.toHaveBeenCalled();
		});

		test("an empty url names no target, so the saved request is sent", async () => {
			const client = savedRequestClient();
			const res = await dispatchTool(
				"run_request",
				{ requestId: "req_1", url: "" },
				ctxWith(client, OFF)
			);
			expect(res.isError).toBeFalsy();
			expect(composeBody(client).requestId).toBe("req_1");
			expect(composeBody(client).request).toBeUndefined();
		});

		test("ad-hoc scripts and elements follow the stored ones instead of replacing them", async () => {
			const client = savedRequestClient();
			const extractor = {
				kind: "extract.jsonpath",
				config: { path: "$.id", variable: "id" },
			};
			const res = await dispatchTool(
				"run_request",
				{
					requestId: "req_1",
					postRequestScript: "pm.test('mine', () => {})",
					elements: [extractor],
				},
				ctxWith(client, { ...OFF, revealSecretsToAgents: true })
			);
			expect(res.isError).toBeFalsy();
			// The engine replaces a whole inline `elements`, which would drop the chain's.
			expect(composeBody(client).request).toBeUndefined();
			const kinds = (executed(client).elements as Array<{ id?: string }>).map((e) => e.id);
			expect(kinds).toEqual(["el_chain", "el_sig", "el_own", "mcp-script-post", undefined]);
			expect((executed(client).elements as unknown[])[4]).toEqual(extractor);
		});

		test("an ad-hoc preRequestScript is composed with the stored list, so a name it sets waits for it (#2521)", async () => {
			// Mutation check: append the ad-hoc elements to the by-id composition
			// instead of composing again, and the engine never sees the script:
			// `{{token}}` goes out as the stored value it resolved before the
			// script could set it.
			const own = {
				id: "el_own",
				kind: "script.post",
				enabled: true,
				config: { script: "pm.test('own', function () {});" },
			};
			type Element = { id?: string; kind?: string };
			// The engine's rule in miniature: a `script.pre` among the composed
			// elements leaves `{{token}}` written and names it; without one the
			// stored value is resolved in.
			const composeRequest = vi
				.fn()
				.mockImplementation(({ request }: { request?: { elements?: Element[] } }) => {
					const elements = request?.elements ?? [own];
					const scripted = elements.some((el) => el.kind === "script.pre");
					return Promise.resolve({
						method: "GET",
						url: "https://api.example.com/users",
						headers: [
							{
								name: "Authorization",
								value: scripted ? "Bearer {{token}}" : "Bearer stored",
							},
						],
						elements,
						requestId: "req_1",
						...(scripted ? { deferredVariables: ["token"] } : {}),
					});
				});
			const client = fakeClient({ listEnvironments: listingEnv1(), composeRequest });
			const res = await dispatchTool(
				"run_request",
				{
					requestId: "req_1",
					environmentId: "env_1",
					preRequestScript: "pm.environment.set('token', 'new');",
				},
				ctxWith(client, { ...OFF, revealSecretsToAgents: true })
			);
			expect(res.isError).toBeFalsy();
			expect(composeRequest).toHaveBeenCalledTimes(2);
			const recomposed = composeRequest.mock.calls[1][0] as {
				requestId?: string;
				environmentId?: string;
				request?: { elements?: Element[] };
			};
			expect(recomposed).toMatchObject({ requestId: "req_1", environmentId: "env_1" });
			expect(recomposed.request?.elements?.map((el) => el.id)).toEqual([
				"el_own",
				"mcp-script-pre",
			]);
			expect(executed(client).headers).toEqual([
				{ name: "Authorization", value: "Bearer {{token}}" },
			]);
			expect(executed(client)).not.toHaveProperty("deferredVariables");
		});

		test("a by-id send with nothing ad hoc composes once", async () => {
			const client = savedRequestClient();
			const res = await dispatchTool(
				"run_request",
				{ requestId: "req_1" },
				ctxWith(client, OFF)
			);
			expect(res.isError).toBeFalsy();
			expect(client.composeRequest).toHaveBeenCalledTimes(1);
		});

		test("a stored literal credential runs with reveal off and is not echoed", async () => {
			const KEY = "stored-typed-key";
			const client = fakeClient({
				composeRequest: vi.fn().mockResolvedValue({
					method: "GET",
					url: "https://api.example.com/users",
					auth: { mode: "apikey", key: "X-Stored-Key", value: KEY, in: "header" },
				}),
				executeRequest: vi.fn().mockResolvedValue({
					status: 200,
					requestHeaders: { "X-Stored-Key": KEY },
				}),
			});
			const res = await dispatchTool(
				"run_request",
				{ requestId: "req_1" },
				ctxWith(client, OFF)
			);
			expect(res.isError).toBeFalsy();
			expect(firstText(res)).not.toContain(KEY);
			expect(JSON.parse(firstText(res)).requestHeaders).toEqual({
				"X-Stored-Key": "<redacted>",
			});
			expect(executed(client).auth).toMatchObject({ value: KEY });
		});

		test("a composed url off the allowlist is refused and nothing is executed", async () => {
			const client = savedRequestClient({ url: "https://evil.example.net/users" });
			const res = await dispatchTool(
				"run_request",
				{ requestId: "req_1" },
				ctxWith(client, OFF)
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toContain("evil.example.net");
			expect(client.executeRequest).not.toHaveBeenCalled();
		});

		test("a saved request that stores scripts runs with reveal off", async () => {
			const client = savedRequestClient();
			const res = await dispatchTool(
				"run_request",
				{ requestId: "req_1" },
				ctxWith(client, OFF)
			);
			expect(res.isError).toBeFalsy();
			expect(client.executeRequest).toHaveBeenCalled();
		});

		test.each([
			["preRequestScript", { preRequestScript: "pm.environment.get('t');" }],
			["elements", { elements: [{ kind: "script.post", config: { script: "pm.test()" } }] }],
		])(
			"an agent-supplied %s beside requestId is still refused with reveal off",
			async (_name, extra) => {
				const client = savedRequestClient();
				const res = await dispatchTool(
					"run_request",
					{ requestId: "req_1", ...extra },
					ctxWith(client, OFF)
				);
				expect(res.isError).toBe(true);
				expect(firstText(res)).toContain("Nothing was sent");
				expect(client.composeRequest).not.toHaveBeenCalled();
				expect(client.executeRequest).not.toHaveBeenCalled();
			}
		);

		test("verifySSL: false is refused on this branch too", async () => {
			const client = savedRequestClient();
			const res = await dispatchTool(
				"run_request",
				{ requestId: "req_1", verifySSL: false },
				ctxWith(client, OFF)
			);
			expect(res.isError).toBe(true);
			expect(client.composeRequest).not.toHaveBeenCalled();
		});

		test("an unknown id reads as no such saved request", async () => {
			const client = savedRequestClient();
			const res = await dispatchTool(
				"run_request",
				{ requestId: "nope" },
				ctxWith(client, OFF)
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toContain('No request with id "nope"');
			expect(firstText(res)).toContain("list_requests");
			expect(client.executeRequest).not.toHaveBeenCalled();
		});

		test("url with requestId stays ad hoc: the id is a link, and a caveat says so", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"run_request",
				{ requestId: "req_1", url: "https://api.example.com/other" },
				ctxWith(client, OFF)
			);
			expect(res.isError).toBeFalsy();
			expect(composeBody(client)).not.toHaveProperty("requestId");
			expect(composeBody(client).request).toMatchObject({
				url: "https://api.example.com/other",
				method: "GET",
			});
			const payload = executed(client);
			expect(payload.requestId).toBe("req_1");
			expect(payload.url).toBe("https://api.example.com/other");
			expect(payload).not.toHaveProperty("auth");
			const caveat = res.content[res.content.length - 1].text;
			expect(caveat).toMatch(/NOT applied/);
			expect(caveat).toMatch(/Omit "url"/);
		});

		test("a url alone, or a requestId alone, carries no caveat", async () => {
			for (const args of [{ url: "https://api.example.com/users" }, { requestId: "req_1" }]) {
				const res = await dispatchTool(
					"run_request",
					args,
					ctxWith(args.url ? fakeClient() : savedRequestClient(), OFF)
				);
				expect(res.isError).toBeFalsy();
				expect(res.content).toHaveLength(1);
			}
		});

		test("neither a url nor a requestId names both ways in", async () => {
			const client = savedRequestClient();
			const res = await dispatchTool("run_request", { method: "GET" }, ctxWith(client, OFF));
			expect(res.isError).toBe(true);
			expect(firstText(res)).toBe(
				'Pass "url" for an ad-hoc send, or "requestId" to send a saved request.'
			);
			expect(client.composeRequest).not.toHaveBeenCalled();
		});

		test("the description and the requestId parameter state both paths", () => {
			const tool = TOOLS.find((t) => t.name === "run_request")!;
			const idDescription = (tool.inputSchema as Record<string, z.ZodType>).requestId
				.description;
			for (const text of [descriptionOf(tool), idDescription]) {
				expect(text).toMatch(/Omit `url` and pass `requestId`|Without `url`/);
				expect(text).toMatch(/nothing else stored is applied/);
				// The linked row's collection is the scope its scripts read (#3461).
				expect(text).toMatch(/links the run in History and scopes its scripts' collection/);
			}
			expect(descriptionOf(tool)).not.toMatch(/use run_collection_smoke/);
		});

		/*
		 * #3561: a by-id send follows the saved request's Event stream setting,
		 * which the by-id compose carries; an explicit `stream` still wins.
		 */
		describe("the stored Event stream setting", () => {
			const started = { runId: "run_s", eventsUrl: "/runs/run_s/events" };
			const streamingSavedClient = () => {
				const client = savedRequestClient({ stream: true });
				(client.executeRequest as ReturnType<typeof vi.fn>).mockResolvedValue(started);
				return client;
			};

			test("streams a request stored with stream: true when the call names none", async () => {
				const client = streamingSavedClient();
				const res = await dispatchTool(
					"run_request",
					{ requestId: "req_1" },
					ctxWith(client, OFF)
				);
				expect(res.isError).toBeFalsy();
				expect(executed(client)).toMatchObject({ stream: true });
				// Parsed as the 202 it asked for, then read from the relay.
				expect(client.consumeStreamEvents).toHaveBeenCalledWith(
					"run_s",
					50,
					5_000,
					undefined
				);
				expect(res.structuredContent).toMatchObject({ runId: "run_s", completed: true });
			});

			test("an explicit stream: false buffers the same request", async () => {
				const client = savedRequestClient({ stream: true });
				const res = await dispatchTool(
					"run_request",
					{ requestId: "req_1", stream: false },
					ctxWith(client, OFF)
				);
				expect(res.isError).toBeFalsy();
				expect(executed(client)).toMatchObject({ stream: false });
				expect(client.consumeStreamEvents).not.toHaveBeenCalled();
			});

			test("an ad-hoc send streams only when asked, whatever composition answers", async () => {
				const client = fakeClient({
					composeRequest: vi.fn().mockResolvedValue({
						method: "GET",
						url: "https://api.example.com/events",
						stream: true,
					}),
				});
				const res = await dispatchTool(
					"run_request",
					{ requestId: "req_1", url: "https://api.example.com/events" },
					ctxWith(client, OFF)
				);
				expect(res.isError).toBeFalsy();
				expect(executed(client)).toMatchObject({ stream: false });
				expect(client.consumeStreamEvents).not.toHaveBeenCalled();
			});
		});
	});

	/*
	 * #1904: an extractor writes a variable, and with reveal on so may an agent's
	 * script. With write access off the engine is told to keep those values
	 * within the send; with it on the key is absent, so the engine's default
	 * (persist) applies exactly as for the app's own Send.
	 */
	describe("variables a send sets while write access is off", () => {
		const target = { url: "https://api.example.com/users" };
		const allow = ["api.example.com"];
		const extractor = {
			kind: "extract.jsonpath",
			config: { path: "$.token", variable: "token", scope: "globals" },
		};
		const executePayload = (client: EngineClient) =>
			(client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
				string,
				unknown
			>;

		test.each([
			["an extractor with reveal off", { elements: [extractor] }, {}],
			[
				"a script with reveal on",
				{ postRequestScript: "pm.environment.set('token', 'x');" },
				{ revealSecretsToAgents: true },
			],
		])(
			"a buffered run_request with %s asks the engine not to persist",
			async (_label, extra, safety) => {
				const client = fakeClient();
				const res = await dispatchTool(
					"run_request",
					{ ...target, ...extra },
					ctxWith(client, { allowlist: allow, ...safety })
				);
				expect(res.isError).toBeFalsy();
				expect(executePayload(client)).toMatchObject({
					stream: false,
					persistVariables: false,
				});
			}
		);

		test("a streaming run_request carries the same flag", async () => {
			const client = fakeClient({
				executeRequest: vi
					.fn()
					.mockResolvedValue({ runId: "run_s", eventsUrl: "/runs/run_s/events" }),
				consumeStreamEvents: vi
					.fn()
					.mockResolvedValue({ events: [], completed: true, capReached: false }),
			});
			const res = await dispatchTool(
				"run_request",
				{ ...target, stream: true, elements: [extractor] },
				ctxWith(client, { allowlist: allow })
			);
			expect(res.isError).toBeFalsy();
			expect(executePayload(client)).toMatchObject({ stream: true, persistVariables: false });
		});

		test("with write access on the key is absent and the engine's default applies", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"run_request",
				{ ...target, elements: [extractor] },
				ctxWith(client, { allowlist: allow, allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			expect(executePayload(client)).not.toHaveProperty("persistVariables");
		});

		test("start_load_run is unchanged: a load run never persists, so no flag rides it", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"start_load_run",
				{
					...target,
					confirmed: true,
					postRequestScript: "pm.environment.set('token', 'x');",
				},
				ctxWith(client, { allowlist: allow, revealSecretsToAgents: true })
			);
			expect(res.isError).toBeFalsy();
			const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(payload).not.toHaveProperty("persistVariables");
		});

		test("the description says what write access off means for a send", () => {
			const description = descriptionOf(TOOLS.find((t) => t.name === "run_request"));
			expect(description).toMatch(
				/write access off, nothing a script or extractor sets is stored/
			);
		});
	});

	test("run_request hands /compose the raw request and executes what it returns", async () => {
		// The engine resolves {{host}}; MCP must send it raw (never pre-resolved -
		// that would be a second interpolation pass) and forward the composed URL.
		const client = fakeClient({
			listEnvironments: listingEnv1(),
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "https://api.example.com/users" }),
		});
		const res = await dispatchTool(
			"run_request",
			{ url: "https://{{host}}/users", environmentId: "env_1", collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		expect(client.composeRequest).toHaveBeenCalledWith(
			{
				request: { method: "GET", url: "https://{{host}}/users" },
				collectionId: "c1",
				environmentId: "env_1",
			},
			undefined
		);
		const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.url).toBe("https://api.example.com/users");
	});

	test("run_request sends the auth block raw for the engine to resolve and apply", async () => {
		// `{{apiToken}}` and the inherit walk are engine-side; MCP forwards the
		// block untouched inside the compose body.
		const client = fakeClient({ listEnvironments: listingEnv1() });
		const res = await dispatchTool(
			"run_request",
			{
				url: "https://api.example.com/users",
				environmentId: "env_1",
				auth: { mode: "bearer", token: "{{apiToken}}" },
			},
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		const composeBody = (client.composeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(composeBody.request.auth).toEqual({ mode: "bearer", token: "{{apiToken}}" });
	});

	test("run_request off-allowlist check runs against the RESOLVED host", async () => {
		// {{host}} resolves (engine-side) to a host that is not allowlisted; the
		// gate must read the composed URL, not the raw argument. Composition
		// itself is pure - no traffic - so composing before gating is safe, but
		// execution must never happen.
		const client = fakeClient({
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "https://evil.test/x" }),
		});
		const res = await dispatchTool(
			"run_request",
			{ url: "https://{{host}}/x", environmentId: "env_1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBe(true);
		expect(client.executeRequest).not.toHaveBeenCalled();
	});

	test("run_request answers a host left as {{baseUrl}} with the gate's own remedy (#2450)", async () => {
		// Compose leaves an undefined variable's token in place. The tool must
		// hand the agent the gate's sentence, not a generic one that drops the
		// variable's name and the tool that defines it.
		const client = fakeClient({
			composeRequest: vi.fn().mockResolvedValue({ method: "GET", url: "{{baseUrl}}/x" }),
		});
		const res = await dispatchTool(
			"run_request",
			{ url: "{{baseUrl}}/x" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBe(true);
		const text = firstText(res);
		expect(text).toMatch(/^Could not determine the target host/);
		expect(text).toContain("{{baseUrl}}");
		expect(text).toContain("update_collection");
		expect(client.executeRequest).not.toHaveBeenCalled();
	});

	// The ad-hoc path has no saved request behind it, so an agent-supplied
	// httpVersion is the only way to specify the protocol at all - it is
	// forwarded when present, same treatment as the other ad-hoc string args
	// (preRequestScript, environmentId, ...).
	test("run_request forwards an agent-supplied httpVersion", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"run_request",
			{ url: "https://api.example.com/users", httpVersion: "http2" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.httpVersion).toBe("http2");
	});
});
