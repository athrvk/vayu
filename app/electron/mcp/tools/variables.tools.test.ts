/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test, vi } from "vitest";
import { dispatchTool, TOOLS } from "../tools.js";
import {
	ENVIRONMENT_DEFAULT_SENTENCE,
	VARIABLE_PRECEDENCE_SENTENCE,
	VARIABLE_RESOLUTION_URI,
} from "../variable-origins.js";
import type { EngineClient } from "../engine-client.js";
import { descriptionOf, fakeClient, ctxWith, firstText } from "../tools.testkit.js";

describe("variable precedence is stated wherever a variable is written or listed", () => {
	/**
	 * The surfaces an agent reaches when it changes or surveys a value. Before
	 * issue #1207 the resolution order appeared in `run_request` and
	 * `get_globals` alone - never at a tool that writes one - so an agent
	 * "fixed" a value in a tier something above it shadowed and saw no effect
	 * and no explanation.
	 *
	 * Table-driven so a new variable tool cannot quietly omit the sentence: add
	 * one to this list and it is checked, and the list is what a reviewer reads
	 * to see whether it is complete.
	 */
	/**
	 * Derived, not listed: every tool taking a `variables` argument is a tool
	 * that writes a tier, so a new one is covered the day it is written. A
	 * hand-maintained list would only ever pin the tools someone remembered to
	 * add to it, which is the defect this issue was opened about wearing a
	 * different hat.
	 */
	const VARIABLE_WRITERS = TOOLS.filter((t) => "variables" in t.inputSchema);

	/**
	 * The read and activation surfaces, which take no `variables` argument and
	 * so cannot be derived the same way. Listed, and the list is asserted
	 * complete below against every tool whose description mentions variables.
	 */
	const VARIABLE_READERS = [
		"get_globals",
		"list_environments",
		"list_collections",
		"activate_environment",
		"resolve_variables",
	] as const;

	test("the derived writer set is non-empty and is what we think it is", () => {
		// A guard over a filter that silently matched nothing would pass forever.
		expect(VARIABLE_WRITERS.length).toBeGreaterThan(0);
		expect(VARIABLE_WRITERS.map((t) => t.name).sort()).toEqual([
			"create_collection",
			"create_environment",
			"update_collection",
			"update_environment",
			"update_globals",
		]);
	});

	test.each(VARIABLE_WRITERS.map((t) => [t.name, t] as const))(
		"%s (writes a tier) states the order and links the model",
		(_name, tool) => {
			// Mutation check: drop the precedenceNote() call from any one of these
			// descriptions and that row fails.
			expect(descriptionOf(tool)).toContain(VARIABLE_PRECEDENCE_SENTENCE);
			expect(descriptionOf(tool)).toContain(VARIABLE_RESOLUTION_URI);
		}
	);

	test.each(VARIABLE_READERS)("%s (reads or switches a tier) states it too", (name) => {
		const tool = TOOLS.find((t) => t.name === name);
		expect(tool, `${name} is missing from TOOLS`).toBeDefined();
		expect(descriptionOf(tool)).toContain(VARIABLE_PRECEDENCE_SENTENCE);
		expect(descriptionOf(tool)).toContain(VARIABLE_RESOLUTION_URI);
	});

	test("no tool spells the order its own way any more", () => {
		// The original complaint: the order appeared as prose in two tools and
		// nowhere else. A second spelling is how it drifts back apart.
		const rogue = TOOLS.filter(
			(t) =>
				/environment\s*>\s*collection\s*chain\s*>\s*globals/.test(descriptionOf(t)) &&
				!descriptionOf(t).includes(VARIABLE_RESOLUTION_URI)
		);
		expect(rogue.map((t) => t.name)).toEqual([]);
	});

	test("each surface names its own tier's position, not just the ladder", () => {
		const byName = new Map(TOOLS.map((t) => [t.name, t]));
		// A shared sentence alone would pass the scan above while telling an
		// agent nothing about the tier it is writing to.
		expect(descriptionOf(byName.get("update_globals"))).toMatch(/bottom tier/);
		expect(descriptionOf(byName.get("update_environment"))).toMatch(/top scope tier/);
		expect(descriptionOf(byName.get("create_collection"))).toMatch(
			/between globals and the active environment/
		);
	});

	test("the variablesInput helper carries it too, at the field an agent fills", () => {
		// Reached through the schema rather than the description: a client that
		// renders per-field docs shows this and not the tool blurb.
		const schema = TOOLS.find((t) => t.name === "update_environment")?.inputSchema.variables;
		expect(schema?.description).toContain(VARIABLE_PRECEDENCE_SENTENCE);
		expect(schema?.description).toContain(VARIABLE_RESOLUTION_URI);
	});
});

describe("resolve_variables", () => {
	const GLOBALS = {
		variables: {
			host: { value: "globals.test", enabled: true },
			onlyGlobal: { value: "g", enabled: true },
		},
	};
	const COLLECTIONS = [
		{
			id: "root",
			name: "Root",
			parentId: null,
			variables: { host: { value: "root.test", enabled: true } },
		},
		{
			id: "leaf",
			name: "Leaf",
			parentId: "root",
			variables: { host: { value: "leaf.test", enabled: true } },
		},
	];
	const ENVIRONMENTS = [
		{
			id: "env_active",
			name: "Staging",
			isActive: true,
			variables: { host: { value: "staging.test", enabled: true } },
		},
		{
			id: "env_other",
			name: "Prod",
			isActive: false,
			variables: { host: { value: "prod.test", enabled: true } },
		},
	];

	const variableClient = (overrides = {}) =>
		fakeClient({
			getGlobals: vi.fn().mockResolvedValue(GLOBALS),
			listCollections: vi.fn().mockResolvedValue(COLLECTIONS),
			listEnvironments: vi.fn().mockResolvedValue(ENVIRONMENTS),
			...overrides,
		});

	const resolve = async (args: Record<string, unknown>, client = variableClient()) =>
		JSON.parse(
			firstText(
				(await dispatchTool("resolve_variables", args, ctxWith(client))) as {
					content: Array<{ text: string }>;
				}
			)
		);

	test("is a read tool that changes nothing", () => {
		const tool = TOOLS.find((t) => t.name === "resolve_variables");
		expect(tool?.category).toBe("read");
		expect(tool?.invalidates).toEqual([]);
		expect(tool?.annotations.readOnlyHint).toBe(true);
	});

	test("the active environment wins, and every loser is named with its reason", async () => {
		const out = await resolve({ collectionId: "leaf" });
		const host = out.variables.find((v: { name: string }) => v.name === "host");

		expect(host.value).toBe("staging.test");
		expect(host.scope).toBe("environment");
		expect(host.sourceName).toBe("Staging");
		// Highest precedence first: the nearest miss is the one to read first.
		expect(host.shadowedBy).toEqual([
			{
				scope: "collection",
				sourceId: "leaf",
				sourceName: "Leaf",
				value: "leaf.test",
				enabled: true,
				reason: "outranked",
			},
			{
				scope: "collection",
				sourceId: "root",
				sourceName: "Root",
				value: "root.test",
				enabled: true,
				reason: "outranked",
			},
			{ scope: "global", value: "globals.test", enabled: true, reason: "outranked" },
		]);
	});

	test("the collection chain is only in play when a collectionId is given", async () => {
		const out = await resolve({});
		const host = out.variables.find((v: { name: string }) => v.name === "host");
		expect(host.value).toBe("staging.test");
		// Two definitions, not four: no chain was asked for.
		expect(host.shadowedBy).toEqual([
			{ scope: "global", value: "globals.test", enabled: true, reason: "outranked" },
		]);
		expect(out.context.collectionChain).toEqual([]);
	});

	test('"none" resolves as if no environment were active', async () => {
		const out = await resolve({ collectionId: "leaf", environmentId: "none" });
		const host = out.variables.find((v: { name: string }) => v.name === "host");
		expect(host.value).toBe("leaf.test");
		expect(host.scope).toBe("collection");
		expect(out.context.environmentSelection).toBe("explicitly none");
		expect(out.context.environmentId).toBeNull();
	});

	test("a named environment is used over the active one", async () => {
		const out = await resolve({ environmentId: "env_other" });
		const host = out.variables.find((v: { name: string }) => v.name === "host");
		expect(host.value).toBe("prod.test");
		expect(out.context.environmentSelection).toBe("named by the caller");
	});

	test("an id that names nothing is refused, not resolved as empty", async () => {
		// The whole point: silently resolving a typo'd collection against globals
		// alone would report confident, wrong answers.
		const missingCollection = await dispatchTool(
			"resolve_variables",
			{ collectionId: "ghost" },
			ctxWith(variableClient())
		);
		expect(missingCollection.isError).toBe(true);
		expect(firstText(missingCollection)).toContain('No collection with id "ghost"');

		const missingEnv = await dispatchTool(
			"resolve_variables",
			{ environmentId: "ghost" },
			ctxWith(variableClient())
		);
		expect(missingEnv.isError).toBe(true);
		expect(firstText(missingEnv)).toContain('No environment with id "ghost"');
	});

	test("names selects, and a name nothing defines is reported rather than omitted", async () => {
		const out = await resolve({ names: ["onlyGlobal", "nowhere"] });
		expect(out.variables.map((v: { name: string }) => v.name)).toEqual([
			"onlyGlobal",
			"nowhere",
		]);
		const nowhere = out.variables[1];
		expect(nowhere.resolved).toBe(false);
		expect(nowhere.shadowedBy).toEqual([]);
	});

	test("a malformed names argument is an argument error, not an empty answer", async () => {
		const res = await dispatchTool(
			"resolve_variables",
			{ names: ["ok", 7] },
			ctxWith(variableClient())
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain('"names" must be an array of strings');
	});

	test("a secret's value is withheld while the rest of the report stands", async () => {
		const client = variableClient({
			getGlobals: vi.fn().mockResolvedValue({
				variables: { token: { value: "s3cret", enabled: true, secret: true } },
			}),
			listEnvironments: vi.fn().mockResolvedValue([]),
		});
		const out = await resolve({}, client);
		const token = out.variables.find((v: { name: string }) => v.name === "token");
		expect(token.resolved).toBe(true);
		expect(token.valueWithheld).toBe(true);
		expect(token).not.toHaveProperty("value");
		expect(JSON.stringify(out)).not.toContain("s3cret");
	});

	test("a disabled winner falls through, and says it was switched off", async () => {
		const client = variableClient({
			listEnvironments: vi.fn().mockResolvedValue([
				{
					id: "env_active",
					name: "Staging",
					isActive: true,
					variables: { host: { value: "staging.test", enabled: false } },
				},
			]),
		});
		const out = await resolve({}, client);
		const host = out.variables.find((v: { name: string }) => v.name === "host");
		expect(host.value).toBe("globals.test");
		expect(host.shadowedBy[0]).toMatchObject({ scope: "environment", reason: "disabled" });
	});

	test("summary counts what the report holds", async () => {
		const out = await resolve({ collectionId: "leaf" });
		expect(out.summary.reported).toBe(out.variables.length);
		expect(out.summary.resolved).toBe(
			out.variables.filter((v: { resolved: boolean }) => v.resolved).length
		);
		expect(out.summary.shadowed).toBe(1); // `host` only; `onlyGlobal` is unopposed
	});

	test("an engine failure reads as an engine failure, not a bad argument", async () => {
		const client = variableClient({
			getGlobals: vi.fn().mockRejectedValue(new Error("fetch failed")),
		});
		const res = await dispatchTool("resolve_variables", {}, ctxWith(client));
		expect(res.isError).toBe(true);
		expect(firstText(res)).not.toContain("must be an array");
	});

	/**
	 * Every tool that composes with an environment picks it the way
	 * resolve_variables does (#2480): the active row for an omitted id, none for
	 * "none", a refusal for an id no environment has.
	 */
	describe("a send resolves against the environment the preview names", () => {
		type Spy = ReturnType<typeof vi.fn>;
		interface Send {
			label: string;
			tool: string;
			args: Record<string, unknown>;
			/** The environment the engine runs with, when it is not the compose body's. */
			forwarded?: (client: EngineClient) => unknown;
		}
		const runPayload = (client: EngineClient) =>
			((client.startRun as Spy).mock.calls[0][0] as Record<string, unknown>).environmentId;
		const SENDS: Send[] = [
			{
				label: "run_request",
				tool: "run_request",
				args: { url: "https://api.example.com/x" },
			},
			{
				label: "start_load_run (url)",
				tool: "start_load_run",
				args: { url: "https://api.example.com/x", duration: "30s", confirmed: true },
			},
			{
				label: "start_load_run (requestId)",
				tool: "start_load_run",
				args: { requestId: "r1", duration: "30s", confirmed: true },
			},
			{
				label: "start_load_run (scenario)",
				tool: "start_load_run",
				args: { scenario: { collectionId: "c1" }, duration: "30s", confirmed: true },
				forwarded: runPayload,
			},
			{
				label: "run_collection",
				tool: "run_collection",
				args: { collectionId: "c1" },
				forwarded: runPayload,
			},
			{
				label: "run_collection_smoke",
				tool: "run_collection_smoke",
				args: { collectionId: "c1" },
			},
			{
				label: "get_graphql_schema",
				tool: "get_graphql_schema",
				args: { requestId: "r1" },
				forwarded: (client) =>
					((client.executeRequest as Spy).mock.calls[0][0] as Record<string, unknown>)
						.environmentId,
			},
		];
		const ALLOWED = { allowlist: ["api.example.com"] };

		const sendClient = (environments: unknown[] = ENVIRONMENTS) =>
			fakeClient({
				listEnvironments: vi.fn().mockResolvedValue(environments),
				listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "login" }]),
				composeRequest: vi
					.fn()
					.mockResolvedValue({ method: "GET", url: "https://api.example.com/x" }),
			});

		/** Every environment the call composed or ran with, one entry per engine call. */
		async function sentEnvironments(
			send: Send,
			args: Record<string, unknown>,
			client = sendClient()
		) {
			await dispatchTool(send.tool, args, ctxWith(client, ALLOWED));
			const composed = (client.composeRequest as Spy).mock.calls.map(
				([body]) => (body as Record<string, unknown>).environmentId
			);
			expect(composed.length).toBeGreaterThan(0);
			return send.forwarded ? [...composed, send.forwarded(client)] : composed;
		}

		test.each(SENDS)("$label with no environmentId uses the active one", async (send) => {
			const sent = await sentEnvironments(send, send.args);
			expect(new Set(sent)).toEqual(new Set(["env_active"]));
		});

		test.each(SENDS)('$label with "none" composes with no environment', async (send) => {
			const sent = await sentEnvironments(send, { ...send.args, environmentId: "none" });
			expect(new Set(sent)).toEqual(new Set([undefined]));
		});

		test.each(SENDS)(
			"$label with none active and none named has no environment",
			async (send) => {
				const inactive = ENVIRONMENTS.map((row) => ({ ...row, isActive: false }));
				const sent = await sentEnvironments(send, send.args, sendClient(inactive));
				expect(new Set(sent)).toEqual(new Set([undefined]));
			}
		);

		test.each(SENDS)("$label with a named environment uses that one", async (send) => {
			const sent = await sentEnvironments(send, { ...send.args, environmentId: "env_other" });
			expect(new Set(sent)).toEqual(new Set(["env_other"]));
		});

		test.each(SENDS)(
			"$label refuses an unknown environmentId and sends nothing",
			async (send) => {
				const client = sendClient();
				const res = await dispatchTool(
					send.tool,
					{ ...send.args, environmentId: "ghost" },
					ctxWith(client, ALLOWED)
				);
				expect(res.isError).toBe(true);
				expect(firstText(res)).toContain('No environment with id "ghost"');
				expect(client.composeRequest).not.toHaveBeenCalled();
				expect(client.executeRequest).not.toHaveBeenCalled();
				expect(client.startRun).not.toHaveBeenCalled();
			}
		);

		test("resolve_variables and run_request name the same environment", async () => {
			const preview = await resolve({});
			const sent = await sentEnvironments(SENDS[0], SENDS[0].args);
			expect(preview.context.environmentId).toBe("env_active");
			expect(sent).toEqual([preview.context.environmentId]);
		});

		test("every tool that takes environmentId states the one default", () => {
			const names = [
				"resolve_variables",
				"activate_environment",
				...new Set(SENDS.map((send) => send.tool)),
			];
			const read = names.filter((name) => {
				const tool = TOOLS.find((t) => t.name === name);
				const param = tool?.inputSchema.environmentId?.description ?? "";
				return `${descriptionOf(tool)} ${param}`.includes(ENVIRONMENT_DEFAULT_SENTENCE);
			});
			expect(ENVIRONMENT_DEFAULT_SENTENCE).not.toBe("");
			expect(read).toEqual([
				"resolve_variables",
				"activate_environment",
				"run_request",
				"start_load_run",
				"run_collection",
				"run_collection_smoke",
				"get_graphql_schema",
			]);
		});
	});
});
