/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test, vi } from "vitest";
import { dispatchTool, TOOLS } from "../tools.js";
import { argumentsSchema } from "./kit.js";
import type { McpSafetyConfig } from "../config.js";
import type { EngineClient } from "../engine-client.js";
import { fakeClient, ctxWith, firstText } from "../tools.testkit.js";

/**
 * State CRUD parity (#758): the environment lifecycle, the globals singleton
 * and the cookie jar.
 *
 * What is worth locking here is what the *blob* rule makes fragile. Every write
 * in this family replaces a whole JSON object engine-side, so each of these
 * tools is a read-merge-write, and every one of them can silently destroy a
 * flag, a value or a whole variable by merging wrong. The rest is the shape of
 * the two calls the engine has no verb for: activation (one PUT, no companion
 * write) and the three cookie scopes (absent, null and an id are three
 * different calls).
 */
describe("environments, globals and the cookie jar", () => {
	const WRITES = { allowWrites: true };
	const allText = (r: { content: Array<{ text: string }> }) =>
		r.content.map((c) => c.text).join("\n");
	const varsOf = (payload: unknown) =>
		(payload as { variables: Record<string, unknown> }).variables;
	const lastCall = (fn: unknown) => (fn as ReturnType<typeof vi.fn>).mock.calls[0];

	test("update_environment sets flags and keeps the ones it was not asked about", async () => {
		// The #314 invariant extended to the object form: `type` and `enabled`
		// arrive, `value`, `secret` and `createdAt` survive untouched. Drop the
		// stored spread from the merge and this reads back a plaintext token.
		const client = fakeClient({
			getEnvironment: vi.fn().mockResolvedValue({
				id: "env_1",
				name: "Dev",
				variables: {
					apiKey: { value: "old", enabled: true, secret: true, createdAt: 42 },
				},
			}),
		});
		const res = await dispatchTool(
			"update_environment",
			{ environmentId: "env_1", variables: { apiKey: { type: "string", enabled: false } } },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBeFalsy();
		expect(varsOf(lastCall(client.updateEnvironment)[1]).apiKey).toEqual({
			value: "old",
			enabled: false,
			secret: true,
			type: "string",
			createdAt: 42,
		});
	});

	test("update_environment takes an entry written back as read, and writes its description (#3556)", async () => {
		// The strict entry declares what a read row carries, so the row an agent
		// read (a withheld secret: no `value`, `valueWithheld: true`) is not
		// refused; the stored value and stamp are kept, and only `description`,
		// the one edited member, is written. Mutation check: drop
		// `"description"` from WRITTEN_VARIABLE_FIELDS and the note is lost.
		const client = fakeClient({
			getEnvironment: vi.fn().mockResolvedValue({
				id: "env_1",
				name: "Dev",
				variables: {
					apiKey: { value: "old", enabled: true, secret: true, createdAt: 42 },
				},
			}),
		});
		const schema = argumentsSchema(
			TOOLS.find((t) => t.name === "update_environment")!.inputSchema
		);
		const args = schema.parse({
			environmentId: "env_1",
			variables: {
				apiKey: {
					valueWithheld: true,
					enabled: true,
					secret: true,
					createdAt: 7,
					description: "Rotated monthly",
				},
			},
		});
		const res = await dispatchTool("update_environment", args, ctxWith(client, WRITES));
		expect(res.isError).toBeFalsy();
		expect(varsOf(lastCall(client.updateEnvironment)[1]).apiKey).toEqual({
			value: "old",
			enabled: true,
			secret: true,
			createdAt: 42,
			description: "Rotated monthly",
		});
	});

	test("update_environment removes a variable rather than blanking it", async () => {
		// The gap this closes: writing "" leaves the name resolving to an empty
		// string, which is not the same as the name not being there.
		const client = fakeClient({
			getEnvironment: vi.fn().mockResolvedValue({
				id: "env_1",
				name: "Dev",
				variables: {
					keep: { value: "a", enabled: true },
					drop: { value: "b", enabled: true },
				},
			}),
		});
		const res = await dispatchTool(
			"update_environment",
			{ environmentId: "env_1", removeVariables: ["drop"] },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBeFalsy();
		const written = varsOf(lastCall(client.updateEnvironment)[1]);
		expect(Object.keys(written)).toEqual(["keep"]);
		expect(written).not.toHaveProperty("drop");
	});

	test("update_environment says which names it found nothing to remove for", async () => {
		// Not an error - a retried call whose first attempt landed would fail on
		// its own success - but not silent either, or a typo reads as a removal.
		const client = fakeClient();
		const res = await dispatchTool(
			"update_environment",
			{ environmentId: "env_1", removeVariables: ["ghost"] },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBeFalsy();
		expect(allText(res)).toContain("ghost");
		expect(client.updateEnvironment).toHaveBeenCalled();
	});

	test("update_environment refuses a name that is both set and removed", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_environment",
			{ environmentId: "env_1", variables: { token: "v" }, removeVariables: ["token"] },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBe(true);
		expect(client.updateEnvironment).not.toHaveBeenCalled();
	});

	test("update_environment refuses to flag a variable that has no value yet", async () => {
		// `{secret: true}` against a mistyped name would otherwise create an empty
		// secret variable and report success.
		const client = fakeClient();
		const res = await dispatchTool(
			"update_environment",
			{ environmentId: "env_1", variables: { apiKeey: { secret: true } } },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain("apiKeey");
		expect(client.updateEnvironment).not.toHaveBeenCalled();
	});

	test("update_environment refuses a call with nothing to change", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_environment",
			{ environmentId: "env_1" },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBe(true);
		expect(client.updateEnvironment).not.toHaveBeenCalled();
	});

	test("update_environment renames without disturbing the variables", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_environment",
			{ environmentId: "env_1", name: "Development" },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBeFalsy();
		expect(lastCall(client.updateEnvironment)[1]).toEqual({
			name: "Development",
			variables: { baseUrl: { value: "x", enabled: true } },
		});
	});

	test.each(["", "  ", "\t\r\n "])(
		"create_environment and update_environment refuse the blank name %j without calling the engine",
		async (blank) => {
			const client = fakeClient();
			const created = await dispatchTool(
				"create_environment",
				{ name: blank },
				ctxWith(client, WRITES)
			);
			const renamed = await dispatchTool(
				"update_environment",
				{ environmentId: "env_1", name: blank },
				ctxWith(client, WRITES)
			);
			for (const res of [created, renamed]) {
				expect(res.isError).toBe(true);
				expect(res.structuredContent).toMatchObject({ error: { class: "input" } });
			}
			expect(firstText(renamed)).toContain("whitespace-only");
			expect(client.createEnvironment).not.toHaveBeenCalled();
			expect(client.getEnvironment).not.toHaveBeenCalled();
			expect(client.updateEnvironment).not.toHaveBeenCalled();
		}
	);

	test("create_environment and update_environment keep a name's surrounding spaces as written", async () => {
		const client = fakeClient();
		await dispatchTool("create_environment", { name: " Staging " }, ctxWith(client, WRITES));
		await dispatchTool(
			"update_environment",
			{ environmentId: "env_1", name: " Renamed " },
			ctxWith(client, WRITES)
		);
		expect(lastCall(client.createEnvironment)[0]).toMatchObject({ name: " Staging " });
		expect(lastCall(client.updateEnvironment)[1]).toMatchObject({ name: " Renamed " });
	});

	test("create_environment stores variables as entries and lets the engine assign the id", async () => {
		// A body `id` is a 400 since #97, so the tool offers no field for one and
		// a caller that invents one has it dropped rather than forwarded.
		const client = fakeClient();
		const res = await dispatchTool(
			"create_environment",
			{
				id: "env_mine",
				name: "Staging",
				description: "pre-prod",
				variables: { host: "stg.example.com", token: { value: "t", secret: true } },
			},
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBeFalsy();
		const payload = lastCall(client.createEnvironment)[0];
		expect(payload).not.toHaveProperty("id");
		expect(payload).toEqual({
			name: "Staging",
			description: "pre-prod",
			variables: {
				host: { value: "stg.example.com", enabled: true },
				token: { value: "t", enabled: true, secret: true },
			},
		});
	});

	test("create_environment refuses a variable with no value", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"create_environment",
			{ name: "Staging", variables: { token: { secret: true } } },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBe(true);
		expect(client.createEnvironment).not.toHaveBeenCalled();
	});

	test("create_environment is refused when writes are disabled", async () => {
		const client = fakeClient();
		const res = await dispatchTool("create_environment", { name: "Staging" }, ctxWith(client));
		expect(res.isError).toBe(true);
		expect(client.createEnvironment).not.toHaveBeenCalled();
	});

	test("activate_environment is one PUT carrying only the flag", async () => {
		// The engine deactivates the previous row in the same transaction, so a
		// companion write would be a second definition of the same rule - and a
		// `name` would be a rename nobody asked for.
		const client = fakeClient();
		const res = await dispatchTool(
			"activate_environment",
			{ environmentId: "env_2" },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBeFalsy();
		expect(client.updateEnvironment).toHaveBeenCalledTimes(1);
		expect(lastCall(client.updateEnvironment)).toEqual([
			"env_2",
			{ isActive: true },
			undefined,
		]);
	});

	test('activate_environment "none" deactivates whichever environment holds the flag', async () => {
		// There is no "no environment" row to write true to, so the id has to be
		// read - which is why this direction costs a list read the other does not.
		const client = fakeClient({
			listEnvironments: vi.fn().mockResolvedValue([
				{ id: "env_1", name: "Dev", isActive: false },
				{ id: "env_2", name: "Prod", isActive: true },
			]),
		});
		const res = await dispatchTool(
			"activate_environment",
			{ environmentId: "none" },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBeFalsy();
		expect(lastCall(client.updateEnvironment)).toEqual([
			"env_2",
			{ isActive: false },
			undefined,
		]);
	});

	test('activate_environment "none" writes nothing when nothing is active', async () => {
		const client = fakeClient({
			listEnvironments: vi.fn().mockResolvedValue([{ id: "env_1", isActive: false }]),
		});
		const res = await dispatchTool(
			"activate_environment",
			{ environmentId: "none" },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBeFalsy();
		expect(firstText(res)).toContain("No environment was active");
		expect(client.updateEnvironment).not.toHaveBeenCalled();
	});

	test("activate_environment is refused when writes are disabled", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"activate_environment",
			{ environmentId: "env_2" },
			ctxWith(client)
		);
		expect(res.isError).toBe(true);
		expect(client.updateEnvironment).not.toHaveBeenCalled();
	});

	test("delete_environment previews with the name and variable count, and deletes nothing", async () => {
		const client = fakeClient({
			getEnvironment: vi.fn().mockResolvedValue({
				id: "env_1",
				name: "Prod",
				isActive: true,
				variables: { a: { value: "1" }, b: { value: "2" }, c: { value: "3" } },
			}),
		});
		const res = await dispatchTool(
			"delete_environment",
			{ environmentId: "env_1" },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBeFalsy();
		expect(firstText(res)).toContain("Prod");
		expect(firstText(res)).toContain("3 variables");
		expect(firstText(res)).toContain("currently active");
		expect(client.deleteEnvironment).not.toHaveBeenCalled();
	});

	test("delete_environment says the environment goes to the Trash, and how it comes back", async () => {
		// The delete is soft since #2970: the preview and the description must
		// not tell the agent it is final, and they name the tools that undo it.
		const client = fakeClient();
		const res = await dispatchTool(
			"delete_environment",
			{ environmentId: "env_1" },
			ctxWith(client, WRITES)
		);
		expect(firstText(res)).toContain("It would go to Vayu's Trash");
		expect(firstText(res)).toContain("restore_trash_entry");
		expect(firstText(res)).not.toMatch(/cannot be undone|no undo/i);
		const description = String(TOOLS.find((t) => t.name === "delete_environment")!.description);
		expect(description).toContain("list_trash");
		expect(description).toContain("restore_trash_entry");
		expect(description).not.toMatch(/there is no undo/i);
	});

	test("delete_environment deletes once confirmed", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"delete_environment",
			{ environmentId: "env_1", confirmed: true },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBeFalsy();
		expect(client.deleteEnvironment).toHaveBeenCalledWith("env_1", undefined);
	});

	test("delete_environment refuses an id no environment has", async () => {
		// `getEnvironment` resolves from the list, so a miss is null rather than a
		// 404 - and deleting blind on a null would confirm against nothing.
		const client = fakeClient({ getEnvironment: vi.fn().mockResolvedValue(null) });
		const res = await dispatchTool(
			"delete_environment",
			{ environmentId: "env_gone", confirmed: true },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBe(true);
		expect(client.deleteEnvironment).not.toHaveBeenCalled();
	});

	test("delete_environment is refused when writes are disabled", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"delete_environment",
			{ environmentId: "env_1", confirmed: true },
			ctxWith(client)
		);
		expect(res.isError).toBe(true);
		expect(client.getEnvironment).not.toHaveBeenCalled();
		expect(client.deleteEnvironment).not.toHaveBeenCalled();
	});

	test("update_globals merges into the stored singleton", async () => {
		// `POST /globals` replaces the blob whole - it is the resource with no
		// create/update split - so without the read this write deletes `region`.
		const client = fakeClient();
		const res = await dispatchTool(
			"update_globals",
			{ variables: { traceId: "abc" } },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBeFalsy();
		expect(varsOf(lastCall(client.saveGlobals)[0])).toEqual({
			region: { value: "eu", enabled: true },
			traceId: { value: "abc", enabled: true },
		});
	});

	test("update_globals removes a global rather than blanking it", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_globals",
			{ removeVariables: ["region"] },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBeFalsy();
		expect(varsOf(lastCall(client.saveGlobals)[0])).toEqual({});
	});

	test("update_globals refuses a call with nothing to change", async () => {
		const client = fakeClient();
		const res = await dispatchTool("update_globals", {}, ctxWith(client, WRITES));
		expect(res.isError).toBe(true);
		expect(client.saveGlobals).not.toHaveBeenCalled();
	});

	test("update_globals is refused when writes are disabled", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_globals",
			{ variables: { a: "b" } },
			ctxWith(client)
		);
		expect(res.isError).toBe(true);
		expect(client.saveGlobals).not.toHaveBeenCalled();
	});

	/**
	 * With Reveal secrets to agents off, an agent may not turn a stored secret
	 * into a readable one by writing `secret: false` (#1809). The three tools that
	 * merge variables share one gate, so each is driven through the same cases.
	 */
	describe("clearing a stored secret flag (#1809)", () => {
		const stored = { token: { value: "t0k", enabled: true, secret: true, type: "string" } };
		const cases = [
			{
				tool: "update_environment",
				args: { environmentId: "env_1" },
				seed: () => ({
					getEnvironment: vi
						.fn()
						.mockResolvedValue({ id: "env_1", name: "Dev", variables: stored }),
				}),
				write: (c: EngineClient) => c.updateEnvironment,
				sent: (call: unknown[]) => varsOf(call[1]),
			},
			{
				tool: "update_globals",
				args: {},
				seed: () => ({ getGlobals: vi.fn().mockResolvedValue({ variables: stored }) }),
				write: (c: EngineClient) => c.saveGlobals,
				sent: (call: unknown[]) => varsOf(call[0]),
			},
			{
				tool: "update_collection",
				args: { collectionId: "col_1" },
				seed: () => ({
					getCollection: vi
						.fn()
						.mockResolvedValue({ id: "col_1", name: "API", variables: stored }),
				}),
				write: (c: EngineClient) => c.updateCollection,
				sent: (call: unknown[]) => varsOf(call[1]),
			},
		];

		describe.each(cases)("$tool", ({ tool, args, seed, write, sent }) => {
			const run = (variables: Record<string, unknown>, safety: Partial<McpSafetyConfig>) => {
				const client = fakeClient(seed());
				return dispatchTool(tool, { ...args, variables }, ctxWith(client, safety)).then(
					(res) => ({ res, client })
				);
			};

			test("refuses secret:false over a stored secret, naming the setting", async () => {
				const { res, client } = await run({ token: { secret: false } }, WRITES);
				expect(res.isError).toBe(true);
				expect(firstText(res)).toContain("token");
				expect(firstText(res)).toContain("Reveal secrets to agents");
				expect(firstText(res)).toContain("Vayu Settings → MCP");
				expect(write(client)).not.toHaveBeenCalled();
			});

			test("refuses it when a value rides along, too", async () => {
				const { res, client } = await run(
					{ token: { value: "new", secret: false } },
					WRITES
				);
				expect(res.isError).toBe(true);
				expect(write(client)).not.toHaveBeenCalled();
			});

			test("allows it once reveal is on", async () => {
				const { res, client } = await run(
					{ token: { secret: false } },
					{ ...WRITES, revealSecretsToAgents: true }
				);
				expect(res.isError).toBeFalsy();
				expect(sent(lastCall(write(client))).token).toMatchObject({ secret: false });
			});

			test("leaves secret:true and unrelated edits alone with reveal off", async () => {
				const keep = await run({ token: { secret: true, enabled: false } }, WRITES);
				expect(keep.res.isError).toBeFalsy();
				expect(sent(lastCall(write(keep.client))).token).toMatchObject({
					secret: true,
					enabled: false,
				});

				const rotate = await run({ token: "rotated" }, WRITES);
				expect(rotate.res.isError).toBeFalsy();
				expect(sent(lastCall(write(rotate.client))).token).toMatchObject({
					value: "rotated",
					secret: true,
				});

				const fresh = await run({ other: { value: "o", secret: false } }, WRITES);
				expect(fresh.res.isError).toBeFalsy();
				expect(sent(lastCall(write(fresh.client))).other).toMatchObject({ secret: false });
			});
		});
	});

	test("clear_cookies distinguishes every jar, one environment's, and the unnamed one", async () => {
		// Three calls, not two: the engine reads an absent parameter as "all" and
		// a present-but-empty one as the no-environment jar, so collapsing null
		// into undefined would clear every session in the app instead of one.
		const all = fakeClient();
		expect((await dispatchTool("clear_cookies", {}, ctxWith(all, WRITES))).isError).toBeFalsy();
		expect(lastCall(all.clearCookies)).toEqual([undefined, undefined]);

		const scoped = fakeClient();
		expect(
			(
				await dispatchTool(
					"clear_cookies",
					{ environmentId: "env_1" },
					ctxWith(scoped, WRITES)
				)
			).isError
		).toBeFalsy();
		expect(lastCall(scoped.clearCookies)).toEqual(["env_1", undefined]);

		const unnamed = fakeClient();
		expect(
			(await dispatchTool("clear_cookies", { environmentId: null }, ctxWith(unnamed, WRITES)))
				.isError
		).toBeFalsy();
		expect(lastCall(unnamed.clearCookies)).toEqual([null, undefined]);
	});

	test("clear_cookies is refused when writes are disabled", async () => {
		const client = fakeClient();
		const res = await dispatchTool("clear_cookies", {}, ctxWith(client));
		expect(res.isError).toBe(true);
		expect(client.clearCookies).not.toHaveBeenCalled();
	});

	test("get_globals and get_cookies read without a gate", async () => {
		const client = fakeClient();
		expect((await dispatchTool("get_globals", {}, ctxWith(client))).isError).toBeFalsy();
		expect((await dispatchTool("get_cookies", {}, ctxWith(client))).isError).toBeFalsy();
		expect(client.getGlobals).toHaveBeenCalled();
		expect(client.getCookiesPage).toHaveBeenCalled();
	});
});
