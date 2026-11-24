/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { dispatchTool, MAX_EXAMPLES_BODY_BYTES, MAX_INLINE_BODY_BYTES, TOOLS } from "../tools.js";
import type { EngineClient } from "../engine-client.js";
import {
	descriptionOf,
	fakeClient,
	ctxWith,
	firstText,
	callArgs,
	schemaOf,
} from "../tools.testkit.js";

/*
 * Document CRUD parity (#759). What an agent could *write* onto a saved
 * document used to be a fraction of what the app stores: no auth, none of the
 * Settings tab, no examples at all, and a collection's variables, auth and
 * scripts unreachable. These cover the four things that closes, and the two
 * rules that keep it safe to hand an agent - a patch carries only what the
 * caller named, and where a row came from is never the caller's to claim.
 */

describe("document CRUD parity", () => {
	describe("saved examples", () => {
		test("create_request_example marks the row as user-written, whatever the caller claims", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"create_request_example",
				{
					requestId: "req_1",
					name: "200 OK",
					status: 201,
					headers: { "content-type": "application/json" },
					body: '{"ok":true}',
					contentType: "application/json",
					// The engine accepts this field; the tool must not forward it.
					origin: "import",
				},
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			const [requestId, payload] = callArgs(client.createRequestExample) as [
				string,
				Record<string, unknown>,
			];
			expect(requestId).toBe("req_1");
			expect(payload).toEqual({
				name: "200 OK",
				status: 201,
				contentType: "application/json",
				headers: [{ key: "content-type", value: "application/json", enabled: true }],
				body: '{"ok":true}',
				// Forwarding the caller's "import" would hand an agent's row to the
				// next OpenAPI sync to overwrite - the omission is the point.
				origin: "user",
			});
		});

		test("update_request_example patches only what it names, and never the origin", async () => {
			const client = fakeClient();
			await dispatchTool(
				"update_request_example",
				{ requestId: "req_1", exampleId: "exa_1", status: 500, origin: "user" },
				ctxWith(client, { allowWrites: true })
			);
			const [requestId, exampleId, payload] = callArgs(client.updateRequestExample) as [
				string,
				string,
				Record<string, unknown>,
			];
			expect(requestId).toBe("req_1");
			expect(exampleId).toBe("exa_1");
			expect(payload).toEqual({ status: 500 });
		});

		describe("headers as ordered rows (#3422)", () => {
			const setCookies = [
				{ key: "Set-Cookie", value: "a=1; Path=/" },
				{ key: "Content-Type", value: "application/json" },
				{ key: "Set-Cookie", value: "b=2; Path=/", enabled: false },
			];
			const forwarded = [
				{ key: "Set-Cookie", value: "a=1; Path=/", enabled: true },
				{ key: "Content-Type", value: "application/json", enabled: true },
				{ key: "Set-Cookie", value: "b=2; Path=/", enabled: false },
			];

			test("create_request_example forwards the rows in order, a repeated key kept and enabled defaulting to true", async () => {
				const client = fakeClient();
				await dispatchTool(
					"create_request_example",
					{ requestId: "req_1", name: "cookies", headers: setCookies },
					ctxWith(client, { allowWrites: true })
				);
				const [, payload] = callArgs(client.createRequestExample) as [
					string,
					Record<string, unknown>,
				];
				expect(payload.headers).toEqual(forwarded);
			});

			test("update_request_example replaces the list with the rows as given", async () => {
				const client = fakeClient();
				await dispatchTool(
					"update_request_example",
					{ requestId: "req_1", exampleId: "exa_1", headers: setCookies },
					ctxWith(client, { allowWrites: true, revealSecretsToAgents: true })
				);
				const [, , payload] = callArgs(client.updateRequestExample) as [
					string,
					string,
					Record<string, unknown>,
				];
				expect(payload).toEqual({ headers: forwarded });
			});

			test("the map form still becomes one enabled row per name", async () => {
				const client = fakeClient();
				await dispatchTool(
					"update_request_example",
					{ requestId: "req_1", exampleId: "exa_1", headers: { "X-A": "1", "X-B": "2" } },
					ctxWith(client, { allowWrites: true, revealSecretsToAgents: true })
				);
				const [, , payload] = callArgs(client.updateRequestExample) as [
					string,
					string,
					Record<string, unknown>,
				];
				expect(payload.headers).toEqual([
					{ key: "X-A", value: "1", enabled: true },
					{ key: "X-B", value: "2", enabled: true },
				]);
			});

			test("an empty array clears the list rather than being dropped", async () => {
				const client = fakeClient();
				await dispatchTool(
					"update_request_example",
					{ requestId: "req_1", exampleId: "exa_1", headers: [] },
					ctxWith(client, { allowWrites: true, revealSecretsToAgents: true })
				);
				expect(callArgs(client.updateRequestExample)[2]).toEqual({ headers: [] });
			});

			test.each([
				["a non-object row", ["Set-Cookie: a=1"], "row 0 must be an object"],
				["a row without a value", [{ key: "X-A" }], "row 0 needs a string"],
				["a numeric value", [{ key: "X-A", value: 1 }], "row 0 needs a string"],
				[
					"a non-boolean enabled",
					[{ key: "X-A", value: "1", enabled: "no" }],
					"row 0 has an",
				],
				["a bare string", "X-A: 1", "must be an array"],
			])(
				"a write with %s is refused before anything is sent",
				async (_label, headers, message) => {
					for (const tool of ["create_request_example", "update_request_example"]) {
						const client = fakeClient();
						const res = await dispatchTool(
							tool,
							{ requestId: "req_1", exampleId: "exa_1", name: "x", headers },
							ctxWith(client, { allowWrites: true })
						);
						expect(res.isError, tool).toBe(true);
						expect(firstText(res), tool).toContain(message);
						expect(client.createRequestExample, tool).not.toHaveBeenCalled();
						expect(client.updateRequestExample, tool).not.toHaveBeenCalled();
					}
				}
			);

			test("both tools' headers schema takes the rows or the map and refuses a malformed row", () => {
				for (const name of ["create_request_example", "update_request_example"]) {
					const schema = schemaOf(name, "headers");
					expect(schema.safeParse(setCookies).success, `${name} rows`).toBe(true);
					expect(schema.safeParse({ "X-A": "1" }).success, `${name} map`).toBe(true);
					expect(schema.safeParse(undefined).success, `${name} omitted`).toBe(true);
					// A row read withheld has no value and is valid; a row with neither a
					// value nor `valueWithheld` passes the shape and is refused by the
					// handler (the "a row without a value" case above).
					expect(
						schema.safeParse([{ key: "X-A", valueWithheld: true }]).success,
						`${name} withheld row`
					).toBe(true);
					expect(
						schema.safeParse([{ key: "X-A", value: "1", note: "x" }]).success,
						`${name} undeclared member`
					).toBe(false);
					expect(schema.safeParse(["X-A: 1"]).success, `${name} string row`).toBe(false);
					expect(
						schema.safeParse([{ key: "X-A", value: "1", enabled: "yes" }]).success,
						name
					).toBe(false);
				}
			});

			test("the example tools' descriptions name the array form for repeated headers", () => {
				for (const name of ["create_request_example", "update_request_example"]) {
					const text = descriptionOf(TOOLS.find((t) => t.name === name));
					expect(text, name).toContain("Set-Cookie");
					expect(text, name).toContain("{key, value, enabled?}");
				}
			});
		});

		describe("header rows written back as list_request_examples returned them (#3550)", () => {
			const storedHeaders = [
				{ key: "Set-Cookie", value: "a=1; Path=/", enabled: true },
				{ key: "X-Trace", value: "1", enabled: true },
				{ key: "X-Off", value: "off", enabled: false },
				{ key: "Set-Cookie", value: "b=2; Path=/", enabled: false },
			];
			const storedExample = () => ({
				id: "exa_1",
				requestId: "req_1",
				name: "cookies",
				headers: structuredClone(storedHeaders),
				updatedAt: 9,
			});
			const exampleClient = () =>
				fakeClient({
					listRequestExamples: vi
						.fn()
						.mockResolvedValue([{ id: "exa_0", headers: [] }, storedExample()]),
				});
			/** The rows the real `list_request_examples` hands an agent while reveal is off. */
			const readRows = async () => {
				const listed = await dispatchTool(
					"list_request_examples",
					{ requestId: "req_1" },
					ctxWith(exampleClient())
				);
				const { examples } = listed.structuredContent as {
					examples: Array<{ id: string; headers: Array<Record<string, unknown>> }>;
				};
				return examples.find((example) => example.id === "exa_1")!.headers;
			};
			const written = (client: EngineClient) =>
				(client.updateRequestExample as ReturnType<typeof vi.fn>).mock.calls[0];
			const update = (client: EngineClient, headers: unknown, reveal = false) =>
				dispatchTool(
					"update_request_example",
					{ requestId: "req_1", exampleId: "exa_1", headers },
					ctxWith(client, { allowWrites: true, revealSecretsToAgents: reveal })
				);

			// Mutation check: return a withheld row as given in
			// `restoreWithheldHeaderRows` and the PUT loses both Set-Cookie values.
			test("the rows as listed, one value changed, keep the withheld values, flags, repeats and order", async () => {
				const rows = await readRows();
				expect(rows[0]).toEqual({ key: "Set-Cookie", enabled: true, valueWithheld: true });
				expect(rows[3]).toEqual({ key: "Set-Cookie", enabled: false, valueWithheld: true });
				rows[1] = { ...rows[1], value: "2" };
				const client = exampleClient();
				const res = await update(client, rows);
				expect(res.isError).toBeFalsy();
				const [requestId, exampleId, payload, , ifMatch] = written(client);
				expect([requestId, exampleId]).toEqual(["req_1", "exa_1"]);
				expect(payload).toEqual({
					headers: [
						{ key: "Set-Cookie", value: "a=1; Path=/", enabled: true },
						{ key: "X-Trace", value: "2", enabled: true },
						{ key: "X-Off", value: "off", enabled: false },
						{ key: "Set-Cookie", value: "b=2; Path=/", enabled: false },
					],
				});
				expect(ifMatch).toBe('W/"9"');
				expect(res.content).toHaveLength(1);
			});

			// Mutation check: drop the `keepsStoredValue` test from the read
			// condition in `writeExampleEdits` and a reveal-on write with a
			// withheld row goes out unmerged.
			test("with reveal on, a withheld row still keeps its stored value", async () => {
				const client = exampleClient();
				const res = await update(
					client,
					[{ key: "set-cookie", valueWithheld: true }],
					true
				);
				expect(res.isError).toBeFalsy();
				expect(written(client)[2]).toEqual({
					headers: [{ key: "set-cookie", value: "a=1; Path=/", enabled: true }],
				});
			});

			// Mutation check: drop the throw for an unmatched withheld row in
			// `restoreWithheldHeaderRows` and the write goes out.
			test.each([
				["a name nothing stores", [{ key: "X-Api-Key", valueWithheld: true }], "X-Api-Key"],
				[
					"one occurrence more than is stored",
					[0, 1, 2].map(() => ({ key: "Set-Cookie", valueWithheld: true })),
					'only 2 "Set-Cookie" headers are stored',
				],
			])(
				"a withheld row matching %s is refused as input, naming it",
				async (_label, rows, named) => {
					const client = exampleClient();
					const res = await update(client, rows);
					expect(res.isError).toBe(true);
					expect(res.structuredContent).toMatchObject({ error: { class: "input" } });
					expect(firstText(res)).toContain(named);
					expect(client.updateRequestExample).not.toHaveBeenCalled();
				}
			);

			describe("rows carrying description, source and type", () => {
				const richHeaders = [
					{
						key: "Set-Cookie",
						value: "a=1; Path=/",
						enabled: true,
						description: "session",
					},
					{
						key: "Content-Type",
						value: "application/json",
						enabled: true,
						source: "body-mode",
						description: "set by the Body tab",
					},
					{ key: "X-Imported", value: "1", enabled: false, type: "any" },
				];
				const richExample = () => ({
					...storedExample(),
					headers: structuredClone(richHeaders),
				});
				const richClient = () =>
					fakeClient({ listRequestExamples: vi.fn().mockResolvedValue([richExample()]) });
				const richRead = async () => {
					const listed = await dispatchTool(
						"list_request_examples",
						{ requestId: "req_1" },
						ctxWith(richClient())
					);
					const { examples } = listed.structuredContent as {
						examples: Array<{ headers: Array<Record<string, unknown>> }>;
					};
					return examples[0].headers;
				};

				// Mutation check: drop `source: z.string().optional()` from
				// `storedHeadersInput` and the rows as listed are refused as an unrecognised key.
				test("both tools' headers schema accepts the rows exactly as listed", async () => {
					const rows = await richRead();
					expect(rows[0]).toEqual({
						key: "Set-Cookie",
						enabled: true,
						description: "session",
						valueWithheld: true,
					});
					expect(rows[1]).toEqual(richHeaders[1]);
					for (const name of ["create_request_example", "update_request_example"]) {
						expect(schemaOf(name, "headers").safeParse(rows).success, name).toBe(true);
					}
				});

				// Mutation check: build the row from `{key, value, enabled}` alone in
				// `readHeaderRow` or `restoreWithheldHeaderRows` and the PUT drops
				// `source`, `description` or `type`.
				test("the rows as listed are written back whole, source and description kept", async () => {
					const client = richClient();
					const res = await update(client, await richRead());
					expect(res.isError).toBeFalsy();
					expect(written(client)[2]).toEqual({ headers: richHeaders });
					expect(res.content).toHaveLength(1);
				});

				test("create_request_example forwards the extra members of a row it stores", async () => {
					const client = fakeClient();
					await dispatchTool(
						"create_request_example",
						{ requestId: "req_1", name: "x", headers: [richHeaders[1]] },
						ctxWith(client, { allowWrites: true })
					);
					expect(callArgs(client.createRequestExample)[1]).toMatchObject({
						headers: [richHeaders[1]],
					});
				});
			});

			// Mutation check: drop `...fields` from the body the merge returns in
			// `writeExampleEdits` and the status is lost.
			test("headers beside another field keep both, with reveal off or on", async () => {
				for (const reveal of [false, true]) {
					const client = exampleClient();
					const res = await dispatchTool(
						"update_request_example",
						{
							requestId: "req_1",
							exampleId: "exa_1",
							status: 500,
							name: "renamed",
							headers: [{ key: "Set-Cookie", valueWithheld: true }],
						},
						ctxWith(client, { allowWrites: true, revealSecretsToAgents: reveal })
					);
					expect(res.isError, `reveal ${reveal}`).toBeFalsy();
					expect(written(client)[2], `reveal ${reveal}`).toEqual({
						status: 500,
						name: "renamed",
						headers: [{ key: "Set-Cookie", value: "a=1; Path=/", enabled: true }],
					});
				}
			});

			// Mutation check: drop `...fields` from the body the reveal-on branch
			// of `writeExampleEdits` sends and the status is lost.
			test("with reveal on, headers of plain rows beside another field send both without a read", async () => {
				const client = exampleClient();
				const res = await update(client, [{ key: "X-A", value: "1" }], true);
				expect(res.isError).toBeFalsy();
				const direct = await dispatchTool(
					"update_request_example",
					{
						requestId: "req_1",
						exampleId: "exa_1",
						status: 500,
						headers: [{ key: "X-A", value: "1" }],
					},
					ctxWith(client, { allowWrites: true, revealSecretsToAgents: true })
				);
				expect(direct.isError).toBeFalsy();
				expect(client.listRequestExamples).not.toHaveBeenCalled();
				const calls = (client.updateRequestExample as ReturnType<typeof vi.fn>).mock.calls;
				expect(calls[1][2]).toEqual({
					status: 500,
					headers: [{ key: "X-A", value: "1", enabled: true }],
				});
			});

			// Mutation check: drop the `!reveal` guard on the caveat in
			// `writeExampleEdits` and the dropped second Set-Cookie row is named as unread.
			test('with reveal on, rows that drop a stored credential row carry no "cannot read" caveat', async () => {
				const client = exampleClient();
				const res = await update(
					client,
					[{ key: "Set-Cookie", valueWithheld: true }],
					true
				);
				expect(res.isError).toBeFalsy();
				expect(res.content).toHaveLength(1);
				expect(JSON.stringify(res.content)).not.toContain("cannot read");
			});

			// Mutation check: leave the caveat out of `writeExampleEdits`.
			test("a map write replaces the list and names the unread rows it dropped", async () => {
				const client = exampleClient();
				const res = await update(client, { "X-Trace": "2" });
				expect(res.isError).toBeFalsy();
				expect(written(client)[2]).toEqual({
					headers: [{ key: "X-Trace", value: "2", enabled: true }],
				});
				expect(res.content).toHaveLength(2);
				expect(res.content[1].text).toContain('stored "Set-Cookie" header,');
			});

			test("rows that keep every unread row carry no caveat", async () => {
				const client = exampleClient();
				const res = await update(client, await readRows());
				expect(res.isError).toBeFalsy();
				expect(written(client)[2].headers).toEqual(storedHeaders);
				expect(res.content).toHaveLength(1);
			});

			test("with reveal on, a plain write reads nothing and sends no version", async () => {
				const client = exampleClient();
				const res = await update(client, { "X-Trace": "2" }, true);
				expect(res.isError).toBeFalsy();
				expect(client.listRequestExamples).not.toHaveBeenCalled();
				expect(written(client)).toHaveLength(4);
				expect(res.content).toHaveLength(1);
			});

			test("a field-only edit reads nothing, whatever the reveal setting", async () => {
				const client = exampleClient();
				await dispatchTool(
					"update_request_example",
					{ requestId: "req_1", exampleId: "exa_1", status: 500 },
					ctxWith(client, { allowWrites: true })
				);
				expect(client.listRequestExamples).not.toHaveBeenCalled();
				expect(written(client)[2]).toEqual({ status: 500 });
			});

			test("a withheld row on an example the list does not hold answers not_found, not a missing header", async () => {
				const client = exampleClient();
				const res = await dispatchTool(
					"update_request_example",
					{
						requestId: "req_1",
						exampleId: "exa_gone",
						headers: [{ key: "Set-Cookie", valueWithheld: true }],
					},
					ctxWith(client, { allowWrites: true })
				);
				expect(res.isError).toBe(true);
				expect(res.structuredContent).toMatchObject({ error: { class: "not_found" } });
				expect(firstText(res)).toContain('No example with id "exa_gone"');
				expect(client.updateRequestExample).not.toHaveBeenCalled();
			});

			// Mutation check: read `create_request_example`'s headers with
			// `readHeaderRows` alone and the withheld row is sent with no value.
			test("create_request_example refuses a withheld row, naming it, since nothing is stored to keep", async () => {
				const client = fakeClient();
				const res = await dispatchTool(
					"create_request_example",
					{
						requestId: "req_1",
						name: "x",
						headers: [{ key: "Set-Cookie", valueWithheld: true }],
					},
					ctxWith(client, { allowWrites: true })
				);
				expect(res.isError).toBe(true);
				expect(res.structuredContent).toMatchObject({ error: { class: "input" } });
				expect(firstText(res)).toContain('no "Set-Cookie" header is stored');
				expect(client.createRequestExample).not.toHaveBeenCalled();
			});
		});

		test("an update naming no field is refused rather than sent", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"update_request_example",
				{ requestId: "req_1", exampleId: "exa_1" },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBe(true);
			expect(client.updateRequestExample).not.toHaveBeenCalled();
		});

		test("the example tools' schemas refuse an interim 1xx status and take the final range", () => {
			// dispatchTool runs after the SDK has validated the input, so the bound
			// is read off the schema the SDK validates with.
			for (const name of ["create_request_example", "update_request_example"]) {
				const tool = TOOLS.find((t) => t.name === name);
				expect(tool, name).toBeDefined();
				const status = tool!.inputSchema.status as z.ZodType;
				for (const interim of [100, 199]) {
					expect(status.safeParse(interim).success, `${name} ${interim}`).toBe(false);
				}
				for (const final of [200, 204, 599]) {
					expect(status.safeParse(final).success, `${name} ${final}`).toBe(true);
				}
				expect(status.safeParse(600).success, `${name} 600`).toBe(false);
			}
		});

		test("list_request_examples clips one oversized body and says so", async () => {
			const body = "x".repeat(MAX_INLINE_BODY_BYTES + 500);
			const client = fakeClient({
				listRequestExamples: vi
					.fn()
					.mockResolvedValue([
						{ id: "exa_1", name: "big", status: 200, body, bodyTruncated: false },
					]),
			});
			const res = await dispatchTool(
				"list_request_examples",
				{ requestId: "req_1" },
				ctxWith(client)
			);
			expect(res.isError).toBeFalsy();
			const parsed = JSON.parse(firstText(res)) as {
				examples: Array<Record<string, unknown>>;
				bodiesOmitted: number;
			};
			expect(parsed.examples[0]).toMatchObject({
				name: "big",
				bodyClipped: true,
				bodyBytes: body.length,
				// The engine's own flag is a different fact and is left as it was.
				bodyTruncated: false,
			});
			expect((parsed.examples[0].body as string).length).toBe(MAX_INLINE_BODY_BYTES);
			expect(parsed.bodiesOmitted).toBe(0);
		});

		test("the list has a budget: bodies past it are dropped, their rows kept", async () => {
			const body = "x".repeat(MAX_INLINE_BODY_BYTES);
			const rows = [1, 2, 3, 4].map((n) => ({
				id: `exa_${n}`,
				name: `example ${n}`,
				status: 200,
				body,
			}));
			const client = fakeClient({
				listRequestExamples: vi.fn().mockResolvedValue(rows),
			});
			const res = await dispatchTool(
				"list_request_examples",
				{ requestId: "req_1" },
				ctxWith(client)
			);
			const parsed = JSON.parse(firstText(res)) as {
				examples: Array<Record<string, unknown>>;
				bodiesOmitted: number;
				bodyBudgetBytes: number;
			};
			expect(parsed.bodyBudgetBytes).toBe(MAX_EXAMPLES_BODY_BYTES);
			expect(parsed.bodiesOmitted).toBe(1);
			// The scalars survive: a row an agent cannot read the body of is
			// still a row it has to know exists.
			expect(parsed.examples[3]).toMatchObject({
				id: "exa_4",
				name: "example 4",
				status: 200,
				bodyOmitted: true,
				bodyBytes: body.length,
			});
			expect(parsed.examples[3].body).toBe("");
			expect(parsed.examples[0].bodyOmitted).toBeUndefined();
		});

		test("a small body is passed through untouched", async () => {
			const client = fakeClient({
				listRequestExamples: vi
					.fn()
					.mockResolvedValue([{ id: "exa_1", name: "ok", status: 200, body: "{}" }]),
			});
			const res = await dispatchTool(
				"list_request_examples",
				{ requestId: "req_1" },
				ctxWith(client)
			);
			const parsed = JSON.parse(firstText(res)) as {
				examples: Array<Record<string, unknown>>;
			};
			expect(parsed.examples[0]).toEqual({
				id: "exa_1",
				name: "ok",
				status: 200,
				body: "{}",
			});
		});

		test("delete_request_example previews the example and its mock consequence", async () => {
			const client = fakeClient({
				listRequestExamples: vi
					.fn()
					.mockResolvedValue([{ id: "exa_1", name: "200 OK", status: 200 }]),
			});
			const res = await dispatchTool(
				"delete_request_example",
				{ requestId: "req_1", exampleId: "exa_1" },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			expect(firstText(res)).toMatch(/awaiting confirmation/i);
			expect(firstText(res)).toContain("200 OK");
			expect(firstText(res)).toMatch(/mock server/i);
			expect(client.deleteRequestExample).not.toHaveBeenCalled();
		});

		test("delete_request_example says a saved example goes to the Trash, and how it comes back", async () => {
			// Soft for a user-saved example since #2971: neither the preview nor the
			// description may call it final. Mutation check: restore "This cannot be
			// undone." for the `user` origin and this fails.
			const client = fakeClient({
				listRequestExamples: vi
					.fn()
					.mockResolvedValue([
						{ id: "exa_1", name: "200 OK", status: 200, origin: "user" },
					]),
			});
			const res = await dispatchTool(
				"delete_request_example",
				{ requestId: "req_1", exampleId: "exa_1" },
				ctxWith(client, { allowWrites: true })
			);
			expect(firstText(res)).toContain("It goes to Vayu's Trash");
			expect(firstText(res)).toContain("restore_trash_entry");
			expect(firstText(res)).not.toMatch(/cannot be undone|no undo/i);
			const description = String(
				TOOLS.find((t) => t.name === "delete_request_example")!.description
			);
			expect(description).toContain("list_trash");
			expect(description).toContain("restore_trash_entry");
			expect(description).not.toMatch(/there is no undo/i);
		});

		test.each([
			["an imported example", { origin: "import" }],
			["one that states no origin", {}],
		])("delete_request_example does not promise a restore for %s", async (_what, origin) => {
			const client = fakeClient({
				listRequestExamples: vi
					.fn()
					.mockResolvedValue([{ id: "exa_1", name: "200 OK", status: 200, ...origin }]),
			});
			const res = await dispatchTool(
				"delete_request_example",
				{ requestId: "req_1", exampleId: "exa_1" },
				ctxWith(client, { allowWrites: true })
			);
			expect(firstText(res)).toContain("it is not trashed");
			expect(firstText(res)).toContain("re-importing the document will");
			expect(firstText(res)).not.toContain("goes to Vayu's Trash");
		});

		test("confirmed, it deletes; unknown, it says so and deletes nothing", async () => {
			const client = fakeClient({
				listRequestExamples: vi
					.fn()
					.mockResolvedValue([{ id: "exa_1", name: "200 OK", status: 200 }]),
			});
			const ctx = ctxWith(client, { allowWrites: true });
			const done = await dispatchTool(
				"delete_request_example",
				{ requestId: "req_1", exampleId: "exa_1", confirmed: true },
				ctx
			);
			expect(done.isError).toBeFalsy();
			expect(client.deleteRequestExample).toHaveBeenCalledWith("req_1", "exa_1", undefined);

			const missing = await dispatchTool(
				"delete_request_example",
				{ requestId: "req_1", exampleId: "exa_gone", confirmed: true },
				ctx
			);
			expect(missing.isError).toBe(true);
			expect(firstText(missing)).toContain("exa_gone");
			expect(client.deleteRequestExample).toHaveBeenCalledTimes(1);
		});
	});

	test("every new write verb refuses before touching the engine when writes are off", async () => {
		const client = fakeClient();
		const calls: Array<[string, Record<string, unknown>, keyof EngineClient]> = [
			[
				"create_request_example",
				{ requestId: "req_1", name: "200 OK" },
				"createRequestExample",
			],
			[
				"update_request_example",
				{ requestId: "req_1", exampleId: "exa_1", status: 500 },
				"updateRequestExample",
			],
			[
				"delete_request_example",
				{ requestId: "req_1", exampleId: "exa_1", confirmed: true },
				"deleteRequestExample",
			],
			["move_item", { type: "request", itemId: "req_1", collectionId: "col_2" }, "reorder"],
		];
		for (const [tool, args, method] of calls) {
			const res = await dispatchTool(tool, args, ctxWith(client, { allowWrites: false }));
			expect(res.isError, tool).toBe(true);
			expect(client[method], tool).not.toHaveBeenCalled();
		}
		// Nor may one read what it would change while writes are off.
		expect(client.listRequestExamples).not.toHaveBeenCalled();
		expect(client.listRequests).not.toHaveBeenCalled();
	});

	test("the new tools carry the categories and hints their gates imply", () => {
		const byName = new Map(TOOLS.map((t) => [t.name, t]));
		expect(byName.get("list_request_examples")?.category).toBe("read");
		for (const name of [
			"create_request_example",
			"update_request_example",
			"delete_request_example",
			"move_item",
		]) {
			expect(byName.get(name)?.category, name).toBe("write");
		}
		expect(byName.get("delete_request_example")?.annotations.destructiveHint).toBe(true);
		expect(byName.get("list_request_examples")?.annotations.readOnlyHint).toBe(true);
	});
});
