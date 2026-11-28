/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { dispatchTool, ENGINE_DEFAULT_HEADERS_SENTENCE, TOOLS } from "../tools.js";
import { argumentsSchema } from "./kit.js";
import type { EngineClient } from "../engine-client.js";
import { descriptionOf, fakeClient, ctxWith, firstText } from "../tools.testkit.js";

describe("dispatchTool", () => {
	test("run_request is blocked by the empty default allowlist", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"run_request",
			{ url: "https://api.example.com/x" },
			ctxWith(client)
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/allowlist is empty/i);
		expect(client.executeRequest).not.toHaveBeenCalled();
	});

	test("run_request proceeds for an allowlisted host and builds the payload", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"run_request",
			{
				url: "https://api.example.com/users",
				method: "POST",
				body: '{"a":1}',
				bodyType: "json",
			},
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		expect(client.executeRequest).toHaveBeenCalledTimes(1);
		const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload).toMatchObject({
			method: "POST",
			url: "https://api.example.com/users",
			// Body is emitted as { mode, content } - the shape the engine reads.
			body: { mode: "json", content: '{"a":1}' },
		});
	});

	/**
	 * `stream: true` (issue #575). `tools/call` is request/response, so an agent
	 * is never handed a stream - it is handed what the stream produced inside
	 * bounds it named, with the bound it stopped at stated beside the payload.
	 */
	describe("run_request with stream: true", () => {
		const allow = { allowlist: ["api.example.com"] };
		const started = { runId: "run_s", eventsUrl: "/runs/run_s/events", status: "running" };

		function streamingClient(consumed: Record<string, unknown>) {
			return fakeClient({
				executeRequest: vi.fn().mockResolvedValue(started),
				consumeStreamEvents: vi.fn().mockResolvedValue(consumed),
			});
		}

		test("the flag is sent explicitly on every call, streaming or not", async () => {
			const off = fakeClient();
			await dispatchTool(
				"run_request",
				{ url: "https://api.example.com/x" },
				ctxWith(off, allow)
			);
			const offPayload = (off.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
			// Never elided: the two answers have different shapes, so a caller
			// that let a default decide would not know which one to parse.
			expect(offPayload).toMatchObject({ stream: false });

			const on = streamingClient({ events: [], completed: true, capReached: false });
			await dispatchTool(
				"run_request",
				{ url: "https://api.example.com/events", stream: true },
				ctxWith(on, allow)
			);
			const onPayload = (on.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(onPayload).toMatchObject({ stream: true });
		});

		test("returns the events with the bounds it read them under", async () => {
			const client = streamingClient({
				events: [{ event: "tick", data: "1" }],
				completed: true,
				capReached: false,
				endReason: "completed",
				totalEvents: 1,
			});
			const res = await dispatchTool(
				"run_request",
				{ url: "https://api.example.com/events", stream: true },
				ctxWith(client, allow)
			);
			expect(res.isError).toBeFalsy();
			expect(res.structuredContent).toMatchObject({
				runId: "run_s",
				completed: true,
				capReached: false,
				budgetExhausted: false,
				endReason: "completed",
				totalEvents: 1,
				eventCount: 1,
			});
			expect(client.consumeStreamEvents).toHaveBeenCalledWith("run_s", 50, 5_000, undefined);
		});

		/*
		 * #3996: the engine marks an in-band error event `isError`; this tool counts the
		 * mark and never judges an event itself, so `events: false` cannot hide the one row
		 * that says the reply went wrong.
		 */
		describe("an event the engine flagged as an error", () => {
			const marked = { event: "message", data: '{"error":"x"}', isError: true };
			const plain = { event: "message", data: "hello" };
			const unmarkedNamedError = { event: "error", data: "no mark" };
			const read = (args: Record<string, unknown> = {}) =>
				dispatchTool(
					"run_request",
					{ url: "https://api.example.com/events", stream: true, ...args },
					ctxWith(
						streamingClient({
							events: [plain, marked, unmarkedNamedError],
							completed: true,
							capReached: false,
						}),
						allow
					)
				);

			test("is counted, and stays in the rows", async () => {
				const out = (await read()).structuredContent as Record<string, unknown>;
				expect(out).toMatchObject({ eventCount: 3, errorEventCount: 1 });
				expect(out.events).toEqual([plain, marked, unmarkedNamedError]);
				expect(out).not.toHaveProperty("errorEvents");
			});

			// Mutation check: drop `errorEvents` from the `events: false` result and this fails.
			test("with events: false, the rows go and the flagged one comes back", async () => {
				const out = (await read({ events: false })).structuredContent as Record<
					string,
					unknown
				>;
				expect(out).toMatchObject({ eventCount: 3, errorEventCount: 1 });
				expect(out).not.toHaveProperty("events");
				expect(out.errorEvents).toEqual([marked]);
			});

			test("a stream with none says 0, and an empty list when rowless", async () => {
				const client = streamingClient({
					events: [plain],
					completed: true,
					capReached: false,
				});
				const rowless = await dispatchTool(
					"run_request",
					{ url: "https://api.example.com/events", stream: true, events: false },
					ctxWith(client, allow)
				);
				expect(rowless.structuredContent).toMatchObject({
					errorEventCount: 0,
					errorEvents: [],
				});
			});
		});

		test("a capped read says so rather than reading as the whole stream", async () => {
			const client = streamingClient({
				events: [{ event: "tick" }, { event: "tick" }],
				completed: false,
				capReached: true,
			});
			const res = await dispatchTool(
				"run_request",
				{ url: "https://api.example.com/events", stream: true, maxStreamEvents: 2 },
				ctxWith(client, allow)
			);
			// The three stopping conditions are separate because the follow-up
			// differs; collapsing them into "partial" would lose that.
			expect(res.structuredContent).toMatchObject({
				completed: false,
				capReached: true,
				budgetExhausted: false,
				maxStreamEvents: 2,
			});
			expect(firstText(res)).toMatch(/still streaming/i);
		});

		test("a read that ran out its budget is neither complete nor capped", async () => {
			const client = streamingClient({ events: [], completed: false, capReached: false });
			const res = await dispatchTool(
				"run_request",
				{ url: "https://api.example.com/events", stream: true, streamBudgetMs: 200 },
				ctxWith(client, allow)
			);
			expect(res.structuredContent).toMatchObject({
				budgetExhausted: true,
				streamBudgetMs: 200,
			});
		});

		test("a budget beyond the ceiling is refused before anything is sent", async () => {
			const client = streamingClient({ events: [], completed: true, capReached: false });
			const res = await dispatchTool(
				"run_request",
				{ url: "https://api.example.com/events", stream: true, streamBudgetMs: 600_000 },
				ctxWith(client, allow)
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/60000 or less/);
			expect(client.executeRequest).not.toHaveBeenCalled();
		});

		test("the allowlist still gates the resolved URL", async () => {
			const client = streamingClient({ events: [], completed: true, capReached: false });
			const res = await dispatchTool(
				"run_request",
				{ url: "https://elsewhere.test/events", stream: true },
				ctxWith(client, allow)
			);
			expect(res.isError).toBe(true);
			expect(client.executeRequest).not.toHaveBeenCalled();
			expect(client.consumeStreamEvents).not.toHaveBeenCalled();
		});

		test("an answer with no runId is handed back rather than followed", async () => {
			const client = fakeClient({
				executeRequest: vi.fn().mockResolvedValue({ statusCode: 200 }),
			});
			const res = await dispatchTool(
				"run_request",
				{ url: "https://api.example.com/events", stream: true },
				ctxWith(client, allow)
			);
			expect(res.isError).toBeFalsy();
			expect(client.consumeStreamEvents).not.toHaveBeenCalled();
		});

		/*
		 * #3773: a saved request that declares a stream text path comes back from
		 * a by-id compose with it beside `stream: true`, and the engine puts each
		 * event's `text` on the relay.
		 */
		describe("a declared stream text path", () => {
			const PATH = "$.choices[0].delta.content";
			const savedStream = (consumed: Record<string, unknown>, composed = {}) =>
				fakeClient({
					composeRequest: vi.fn().mockResolvedValue({
						method: "POST",
						url: "https://api.example.com/chat",
						stream: true,
						streamTextPath: PATH,
						streamFirstContentMarker: "content_block_delta",
						...composed,
					}),
					executeRequest: vi.fn().mockResolvedValue(started),
					consumeStreamEvents: vi.fn().mockResolvedValue(consumed),
				});
			const run = (client: EngineClient, extra: Record<string, unknown> = {}) =>
				dispatchTool(
					"run_request",
					{ requestId: "req_1", ...extra },
					ctxWith(client, allow)
				);
			const tokens = (count: number) =>
				Array.from({ length: count }, (_, i) => ({
					event: "message",
					data: JSON.stringify({
						id: "chatcmpl-1",
						object: "chat.completion.chunk",
						choices: [{ index: 0, delta: { content: `t${i} ` } }],
					}),
					receivedAt: 1_755_000_000_000 + i,
					// A role-only chunk and `[DONE]` carry no `text`.
					...(i % 10 === 9 ? {} : { text: `t${i} ` }),
				}));

			test("returns the joined text beside the rows, in order, skipping events with none", async () => {
				const events = tokens(12);
				const client = savedStream({ events, completed: true, capReached: false });
				const res = await run(client);
				expect(res.isError).toBeFalsy();
				const expected = events.map((e) => ("text" in e ? e.text : "")).join("");
				expect(res.structuredContent).toMatchObject({ text: expected, eventCount: 12 });
				expect((res.structuredContent as { events: unknown[] }).events).toHaveLength(12);
				expect(executedPayload(client)).toMatchObject({
					stream: true,
					streamTextPath: PATH,
				});
			});

			// Mutation check: drop the `events !== false` guard in runStreamingRequest
			// and the rows come back; drop the text and the reply is gone.
			test("events: false returns the text without the rows, under 1 KB for a 40-token reply", async () => {
				const events = tokens(40);
				const client = savedStream({
					events,
					completed: true,
					capReached: false,
					endReason: "completed",
					totalEvents: 40,
				});
				const res = await run(client, { events: false });
				expect(res.isError).toBeFalsy();
				const out = res.structuredContent as Record<string, unknown>;
				expect(out).not.toHaveProperty("events");
				expect(out.text).toBe(events.map((e) => ("text" in e ? e.text : "")).join(""));
				expect(out).toMatchObject({ eventCount: 40, totalEvents: 40, completed: true });
				expect(firstText(res).length).toBeLessThan(1024);
			});

			// Mutation check: emit `text` unconditionally and this fails.
			test("a request with no path has no `text` key at all, not an empty one", async () => {
				const client = savedStream(
					{ events: [{ event: "tick", data: "1" }], completed: true, capReached: false },
					{ streamTextPath: undefined }
				);
				const res = await run(client);
				expect(res.structuredContent).not.toHaveProperty("text");
				expect(res.structuredContent).toHaveProperty("events");
				const rowless = await run(client, { events: false });
				expect(rowless.structuredContent).not.toHaveProperty("text");
				expect(rowless.structuredContent).not.toHaveProperty("events");
				expect(rowless.structuredContent).toMatchObject({ eventCount: 1 });
			});

			test("a declared path that read nothing yet is an empty reply", async () => {
				const client = savedStream({ events: [], completed: false, capReached: false });
				const res = await run(client);
				expect(res.structuredContent).toMatchObject({ text: "", budgetExhausted: true });
			});

			test("a capped read carries the reply read so far, and says it was capped", async () => {
				const client = savedStream({
					events: tokens(3),
					completed: false,
					capReached: true,
				});
				const res = await run(client, { events: false, maxStreamEvents: 3 });
				expect(res.structuredContent).toMatchObject({
					text: "t0 t1 t2 ",
					capReached: true,
					completed: false,
				});
			});

			// Mutation check: set `payload.stream` directly in run_request and the
			// path rides a buffered send, which the engine answers with a 400.
			test("an explicit stream: false drops the path the compose carried", async () => {
				const client = savedStream({ events: [], completed: true, capReached: false });
				const res = await run(client, { stream: false });
				expect(res.isError).toBeFalsy();
				const sent = executedPayload(client);
				expect(sent).toMatchObject({ stream: false });
				expect(sent).not.toHaveProperty("streamTextPath");
				expect(sent).not.toHaveProperty("streamFirstContentMarker");
				expect(client.consumeStreamEvents).not.toHaveBeenCalled();
			});

			/*
			 * #3818: an ad-hoc send has no stored path to carry, so the call states
			 * one. The default fake composes as the engine does for an inline request,
			 * copying its keys onto the payload.
			 */
			describe("stated on an ad-hoc send", () => {
				const adHoc = (extra: Record<string, unknown>) => {
					const events = tokens(12);
					const read = { events, completed: true, capReached: false };
					const client = fakeClient({
						executeRequest: vi.fn().mockResolvedValue(started),
						consumeStreamEvents: vi.fn().mockResolvedValue(read),
					});
					return {
						client,
						events,
						result: dispatchTool(
							"run_request",
							{ url: "https://api.example.com/chat", method: "POST", ...extra },
							ctxWith(client, allow)
						),
					};
				};
				const joined = (events: Array<Record<string, unknown>>) =>
					events.map((e) => ("text" in e ? e.text : "")).join("");

				// Mutation check: drop the `streamTextPath` line from the ad-hoc branch
				// of `composeTarget` and neither the payload nor `text` carries it.
				test("a streamed send with a path returns `text`, and `events: false` drops the rows", async () => {
					const full = adHoc({ stream: true, streamTextPath: PATH });
					const res = await full.result;
					expect(res.isError).toBeFalsy();
					expect(res.structuredContent).toMatchObject({
						text: joined(full.events),
						eventCount: 12,
					});
					expect((res.structuredContent as { events: unknown[] }).events).toHaveLength(
						12
					);
					expect(executedPayload(full.client)).toMatchObject({
						stream: true,
						streamTextPath: PATH,
					});

					const rowless = adHoc({ stream: true, streamTextPath: PATH, events: false });
					const out = (await rowless.result).structuredContent as Record<string, unknown>;
					expect(out).not.toHaveProperty("events");
					expect(out).toMatchObject({ text: joined(rowless.events), eventCount: 12 });
				});

				// Mutation check: take the `delete payload.streamTextPath` out of
				// `setStreamFlag` and the buffered payload keeps the path.
				test.each([
					["stream: false", { stream: false }],
					["no stream argument", {}],
				])(
					"the path is dropped from a send that does not stream (%s)",
					async (_, extra) => {
						const sent = adHoc({ ...extra, streamTextPath: PATH });
						const res = await sent.result;
						expect(res.isError).toBeFalsy();
						const payload = executedPayload(sent.client);
						expect(payload).toMatchObject({ stream: false });
						expect(payload).not.toHaveProperty("streamTextPath");
						expect(sent.client.consumeStreamEvents).not.toHaveBeenCalled();
					}
				);

				test("a streamed send with no path has no `text`, and none is sent", async () => {
					const sent = adHoc({ stream: true });
					const res = await sent.result;
					expect(res.structuredContent).not.toHaveProperty("text");
					expect(res.structuredContent).toHaveProperty("events");
					expect(executedPayload(sent.client)).not.toHaveProperty("streamTextPath");
				});

				test("the schema takes a string and refuses null and numbers", () => {
					const schema = TOOLS.find((t) => t.name === "run_request")!.inputSchema
						.streamTextPath;
					expect(schema.safeParse(PATH).success).toBe(true);
					expect(schema.safeParse(undefined).success).toBe(true);
					expect(schema.safeParse(null).success).toBe(false);
					expect(schema.safeParse(7).success).toBe(false);
				});
			});

			test("`events` is declared on run_request alone and is boolean", () => {
				const schema = TOOLS.find((t) => t.name === "run_request")!.inputSchema.events;
				expect(schema.safeParse(false).success).toBe(true);
				expect(schema.safeParse("no").success).toBe(false);
				expect(schema.description).toMatch(/streamTextPath/);
			});

			const executedPayload = (client: EngineClient) =>
				(client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
					string,
					unknown
				>;
		});

		test("the tool description names its bounds before the payload", () => {
			const schema = TOOLS.find((t) => t.name === "run_request")!.inputSchema as Record<
				string,
				{ description?: string }
			>;
			// The `aaba1d8` discipline: a caveat an agent reads after believing
			// the data is a caveat that arrived too late.
			expect(schema.stream.description).toMatch(/BOUNDED/);
			expect(schema.stream.description).toMatch(/streamBudgetMs/);
			expect(schema.stream.description).toMatch(/maxStreamEvents/);
		});
	});

	/**
	 * Both these tools have offered `form-data` / `x-www-form-urlencoded` in
	 * their `bodyType` description since they existed, while emitting
	 * `{ mode, content }` - a shape the engine reads no fields out of, so the
	 * request went out with an empty body (issue #381) and now is refused
	 * outright. The string is split into the `fields` rows every other producer
	 * builds, which is what makes the advertised mode real.
	 */
	test.each(["form-data", "x-www-form-urlencoded"])(
		"run_request sends a %s body as fields",
		async (bodyType) => {
			const client = fakeClient();
			const res = await dispatchTool(
				"run_request",
				{
					url: "https://api.example.com/users",
					method: "POST",
					body: "name=ada+lovelace&role=engineer",
					bodyType,
				},
				ctxWith(client, { allowlist: ["api.example.com"] })
			);
			expect(res.isError).toBeFalsy();
			const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(payload.body).toEqual({
				mode: bodyType,
				fields: [
					{ key: "name", value: "ada lovelace", enabled: true },
					{ key: "role", value: "engineer", enabled: true },
				],
			});
		}
	);

	/**
	 * The owner scenario behind #417: a bare GraphQL document handed to
	 * `run_request`. The envelope is the *engine's* to apply
	 * (`http/graphql_body.cpp`, pinned end to end by
	 * `graphql_body_test.cpp::ABareDocumentIsEnvelopedOnTheWire`), so what this
	 * layer owes is the document unchanged under `mode: "graphql"` - the one
	 * hop the engine test cannot see. Mutation check: envelope it here, or let
	 * `graphql` fall into `FORM_BODY_MODES` and arrive as `fields`, and the
	 * body assertion reddens.
	 */
	/**
	 * The xml mode has no envelope and no completer anywhere in the stack - the
	 * engine sends `body.content` byte for byte - so what this layer owes is the
	 * document unchanged under `mode: "xml"`. Mutation check: let `xml` fall into
	 * `FORM_BODY_MODES` and it arrives split into `fields`, which is issue #381's
	 * empty-body failure wearing a new mode.
	 */
	/**
	 * A data row rides *beside* the composed payload, not through composition
	 * (issue #601).
	 *
	 * `{{data.*}}` survives `/compose` by design - that is what lets the engine
	 * bind it per iteration - so the row has to reach `/execute` as its own
	 * field. Mutation check: pass `data` into the `/compose` body instead and
	 * the assertion on the execute payload goes red, which is the shape of the
	 * bug (the tokens would reach the wire written as they stand).
	 */
	test("run_request passes a data row to /execute, not to /compose", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"run_request",
			{
				url: "https://api.example.com/users/{{data.id}}",
				data: { id: "7", email: "ada@example.test" },
			},
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();

		const composeBody = (client.composeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(composeBody.request.data).toBeUndefined();
		expect(composeBody.data).toBeUndefined();

		const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.data).toEqual({ id: "7", email: "ada@example.test" });
		// The token is still written when the engine gets it - binding it is the
		// engine's, and composition deliberately leaves it alone.
		expect(payload.url).toBe("https://api.example.com/users/{{data.id}}");
	});

	test("run_request omits data entirely when no row was named", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"run_request",
			{ url: "https://api.example.com/users" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		// Absent, not an empty object: an empty row is a row, and the engine
		// reads it as one - `pm.iterationData` would become a scope answering
		// undefined per key rather than being undefined itself.
		expect("data" in payload).toBe(false);
	});

	test("run_request sends an xml document to the engine as written", async () => {
		const envelope = "<soap:Envelope><soap:Body><Ping/></soap:Body></soap:Envelope>";
		const client = fakeClient();
		const res = await dispatchTool(
			"run_request",
			{
				url: "https://api.example.com/soap",
				method: "POST",
				body: envelope,
				bodyType: "xml",
			},
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.body).toEqual({ mode: "xml", content: envelope });
	});

	test("run_request sends a bare graphql document to the engine as stored", async () => {
		const query = "query Hero { hero { name } }";
		const client = fakeClient();
		const res = await dispatchTool(
			"run_request",
			{
				url: "https://api.example.com/graphql",
				method: "POST",
				body: query,
				bodyType: "graphql",
			},
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.body).toEqual({ mode: "graphql", content: query });
		// Named separately from the toEqual above: the failure this guards
		// against is a well-meant `{"query": ...}` wrap here, which would leave
		// the engine wrapping it a second time.
		expect(payload.body.content).not.toContain('"query"');
		expect(firstText(res)).toContain("200");
	});

	/**
	 * Every tool that accepts a `bodyType` states the GraphQL GET transport
	 * rule, and the list is *discovered* rather than spelled out: #1228 wrote
	 * the sentence into three descriptions by name and `start_load_run` - which
	 * offers `graphql` like the rest and is exactly where the rule bites, since
	 * a run left on the default GET sends no body at all - kept a description
	 * that never mentioned a method (#1277). The rule is asserted against every
	 * `bodyType` the schema actually offers rather than a list written here, so
	 * a fifth such tool is checked the moment it exists; the four names are the
	 * separate guard that the scan found the set it thinks it found, and a new
	 * tool joining that list is the deliberate moment to read the rule again.
	 */
	describe("the GraphQL GET transport rule", () => {
		const bodyTypeDescriptions = () =>
			TOOLS.flatMap((tool) => {
				const schema = tool.inputSchema as Record<string, { description?: string }>;
				const description = schema?.bodyType?.description;
				return description ? [[tool.name, description] as const] : [];
			});

		test("is stated by every tool that accepts a bodyType", () => {
			const found = bodyTypeDescriptions();
			// The scan is worthless if it scanned nothing - the failure mode a
			// source-shaped guard hides behind (see CLAUDE.md).
			expect(found.map(([name]) => name).sort()).toEqual([
				"create_request",
				"run_request",
				"start_load_run",
				"update_request",
			]);
			for (const [name, description] of found) {
				// The three facts an agent needs to pick a method: that graphql
				// is on offer, which verb carries the document in the URL and
				// what it becomes there, and which verb a mutation needs. The
				// wording differs per tool; these are the facts, not a copy.
				expect(description, `${name} names graphql`).toContain("graphql");
				expect(description, `${name} names GET`).toMatch(/\bGET\b/);
				expect(description, `${name} names the query parameters`).toContain(
					"query parameters"
				);
				expect(description, `${name} names POST`).toMatch(/\bPOST\b/);
			}
		});
	});

	test("run_request folds an ad-hoc pre/post script into elements, never as a raw field", async () => {
		// Parsed through the tool's own inputSchema first, because that is the
		// only thing standing between the agent and the engine: `registerTool`
		// hands the SDK this shape, which refuses a key it does not declare.
		// dispatchTool alone does not validate, so asserting on it would pass
		// with the field removed and prove nothing.
		//
		// The raw fields must never reach `/execute`: issue #1514 refuses
		// `preRequestScript` / `postRequestScript` there outright, so a
		// forwarded string would 400 rather than sign the request.
		const tool = TOOLS.find((t) => t.name === "run_request");
		const args = argumentsSchema(tool!.inputSchema as Record<string, z.ZodType>).parse({
			url: "https://api.example.com/users",
			preRequestScript: "pm.request.headers['X-Signature'] = 'abc';",
			postRequestScript: "pm.test('ok', function () {});",
		});

		const client = fakeClient();
		const res = await dispatchTool(
			"run_request",
			args,
			ctxWith(client, { allowlist: ["api.example.com"], revealSecretsToAgents: true })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		// Both ride as `elements` now (issue #1514): `/compose` copies an inline
		// request's keys onto the payload verbatim, so sending the retired names
		// would reach `/execute` and come back a 400. Ids are stated because
		// nothing assigns one on this path and per-element outcomes key off it.
		expect(payload.elements).toEqual([
			{
				id: "mcp-script-pre",
				kind: "script.pre",
				enabled: true,
				config: { script: "pm.request.headers['X-Signature'] = 'abc';" },
			},
			{
				id: "mcp-script-post",
				kind: "script.post",
				enabled: true,
				config: { script: "pm.test('ok', function () {});" },
			},
		]);
		expect(payload.preRequestScript).toBeUndefined();
		expect(payload.postRequestScript).toBeUndefined();
	});

	test("run_request appends an ad-hoc `elements` argument alongside its own scripts", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"run_request",
			{
				url: "https://api.example.com/users",
				postRequestScript: "pm.test('ok', function () {});",
				elements: [{ kind: "assert.duration", config: { maxMs: 500 } }],
			},
			ctxWith(client, { allowlist: ["api.example.com"], revealSecretsToAgents: true })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock
			.calls[0][0] as Record<string, unknown>;
		// The ad-hoc `elements` argument (issue #1517) joins the script, never
		// replacing it - there is no stored chain for this tool to lose either
		// way (composition here is always inline).
		expect(payload.elements).toEqual([
			{
				id: "mcp-script-post",
				kind: "script.post",
				enabled: true,
				config: { script: "pm.test('ok', function () {});" },
			},
			{ kind: "assert.duration", config: { maxMs: 500 } },
		]);
	});

	test("no execute tool asks the engine for pm.sendRequest, and an agent cannot ask for it", async () => {
		// The allowlist is checked here, before the engine is called, so a
		// request issued from inside a script could never be checked (issue
		// #302). The engine therefore denies script-issued requests unless the
		// payload says otherwise - and this layer must never say otherwise.
		//
		// Both halves matter. The first is that nothing here sets the field.
		// The second is that an agent cannot set it either: the inputSchema does
		// not declare `allowScriptRequests`, so the call is refused naming it
		// (#3556) before any handler runs. Asserting only the first would stay
		// green if the schema ever came to accept the key.
		const tool = TOOLS.find((t) => t.name === "run_request");
		const schema = argumentsSchema(tool!.inputSchema as Record<string, z.ZodType>);
		const args = {
			url: "https://api.example.com/users",
			preRequestScript: "pm.sendRequest('https://evil.example.com', function () {});",
		};
		const asked = schema.safeParse({ ...args, allowScriptRequests: true });
		expect(asked.success).toBe(false);
		expect(asked.error?.issues.map((issue) => issue.message)).toEqual([
			'Unrecognized key: "allowScriptRequests"',
		]);

		const client = fakeClient();
		const res = await dispatchTool(
			"run_request",
			schema.parse(args),
			ctxWith(client, { allowlist: ["api.example.com"], revealSecretsToAgents: true })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload).not.toHaveProperty("allowScriptRequests");
	});

	test("run_request keeps the engine's parsed body: it never sends includeParsedBody (issue #2544)", async () => {
		// The renderer declines the parsed copy because its pane reads `bodyRaw`;
		// this tool's result exposes `body`, so the engine's default (true) is the
		// behaviour it needs. An agent cannot decline it either: the field is not
		// in the schema, so the call is refused naming it (#3556).
		const tool = TOOLS.find((t) => t.name === "run_request");
		const schema = argumentsSchema(tool!.inputSchema as Record<string, z.ZodType>);
		const args = { url: "https://api.example.com/users" };
		const declined = schema.safeParse({ ...args, includeParsedBody: false });
		expect(declined.success).toBe(false);
		expect(declined.error?.issues.map((issue) => issue.message)).toEqual([
			'Unrecognized key: "includeParsedBody"',
		]);

		const client = fakeClient();
		const res = await dispatchTool(
			"run_request",
			schema.parse(args),
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload).not.toHaveProperty("includeParsedBody");
	});
});

/**
 * An agent can refuse a header the engine adds (issue #1337).
 *
 * The engine has taken `disabledDefaultHeaders` on `POST /execute` and
 * `POST /runs` since #1229; what an agent could not do was name it, because the
 * MCP SDK parses arguments through each tool's zod `inputSchema` and the tools
 * did not declare it. So every case here parses through the tool's own schema
 * first, exactly as the SDK does: handing `dispatchTool` the field directly
 * would pass with the schema entry removed and prove nothing.
 */
describe("default-header opt-outs reach the engine", () => {
	const parseArgs = (name: string, args: Record<string, unknown>) =>
		argumentsSchema(
			TOOLS.find((t) => t.name === name)!.inputSchema as Record<string, z.ZodType>
		).parse(args);

	test("run_request forwards the refused names to /execute", async () => {
		const client = fakeClient();
		const args = parseArgs("run_request", {
			url: "https://api.example.com/users",
			disabledDefaultHeaders: ["User-Agent", "Accept-Encoding"],
		});
		expect(args.disabledDefaultHeaders).toEqual(["User-Agent", "Accept-Encoding"]);

		const res = await dispatchTool(
			"run_request",
			args,
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		// The whole point of the argument: this send carries no User-Agent at
		// all, which writing one yourself cannot express.
		expect(payload.disabledDefaultHeaders).toEqual(["User-Agent", "Accept-Encoding"]);
	});

	test("run_request sends no such key when the agent names none", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"run_request",
			parseArgs("run_request", { url: "https://api.example.com/users" }),
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		// An empty list and no list say the same thing to the engine, so saying
		// it here would be this layer making a claim the agent did not.
		expect(payload).not.toHaveProperty("disabledDefaultHeaders");
	});

	test("a streaming run_request carries them too", async () => {
		// The streaming branch answers `202 {runId, eventsUrl}` and consumes the
		// events itself, so it is the one send whose payload a reader has to
		// follow into a second function - and a refusal dropped there would be a
		// stream opened with a User-Agent the agent declined.
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
			parseArgs("run_request", {
				url: "https://api.example.com/events",
				stream: true,
				disabledDefaultHeaders: ["User-Agent"],
			}),
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload).toMatchObject({ stream: true, disabledDefaultHeaders: ["User-Agent"] });
	});

	test("start_load_run forwards the refused names to /runs", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				confirmed: true,
				disabledDefaultHeaders: ["Accept-Encoding"],
			}),
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.disabledDefaultHeaders).toEqual(["Accept-Encoding"]);
	});

	test("run_request carries the whole rule and the other senders point at it", () => {
		const tool = (name: string) => TOOLS.find((t) => t.name === name);
		const description = (name: string) => descriptionOf(tool(name));
		// The one full statement, on the tool that owns the behaviour (#2441). It
		// tells the three senders apart, so the pointers need not.
		expect(description("run_request")).toContain(ENGINE_DEFAULT_HEADERS_SENTENCE);
		expect(ENGINE_DEFAULT_HEADERS_SENTENCE).toMatch(
			/run_request and start_load_run take it as an argument/
		);
		expect(ENGINE_DEFAULT_HEADERS_SENTENCE).toMatch(
			/run_collection_smoke does not: it replays each saved request exactly as stored/
		);
		for (const name of ["start_load_run", "run_collection_smoke"]) {
			expect(description(name), name).not.toContain(ENGINE_DEFAULT_HEADERS_SENTENCE);
			expect(description(name), name).toMatch(/User-Agent.*run_request states the rule/);
		}
		// What the pointer leaves out, each tool's schema still says.
		expect(tool("start_load_run")?.inputSchema).toHaveProperty("disabledDefaultHeaders");
		expect(tool("run_collection_smoke")?.inputSchema).not.toHaveProperty(
			"disabledDefaultHeaders"
		);
		expect(description("run_collection_smoke")).toMatch(
			/no `disabledDefaultHeaders` here: each saved request is replayed exactly as stored/
		);
	});
});
