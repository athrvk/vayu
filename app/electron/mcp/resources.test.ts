/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file resources.test.ts
 * @brief Covers the script-sandbox resource added for issue #233. The load-
 *        bearing assertion is the anti-drift one: the resource's contents must
 *        come from what the engine served, so a hand-maintained list of pm.*
 *        names in the app would fail these tests rather than quietly going
 *        stale the way the app's own quick-reference panel did.
 */

import { describe, expect, test, vi } from "vitest";
import { STATIC_RESOURCES, projectScriptingSurface, projectScriptingTypes } from "./resources.js";
import { TOOLS, type ToolContext } from "./tools.js";
import {
	VARIABLE_PRECEDENCE_SENTENCE,
	VARIABLE_RESOLUTION_MODEL,
	VARIABLE_RESOLUTION_URI,
} from "./variable-origins.js";
import type { EngineClient } from "./engine-client.js";

/** One completion in the engine's shape - Monaco fields and all. */
function engineEntry(label: string, extra: Record<string, unknown> = {}) {
	return {
		label,
		kind: 1,
		insertText: `${label}(\${1:arg})`,
		insertTextRules: 4,
		sortText: `1_${label}`,
		filterText: `.${label}`,
		detail: `${label}(arg: string): string`,
		documentation: `What ${label} does.`,
		...extra,
	};
}

function scriptingResource() {
	const r = STATIC_RESOURCES.find((s) => s.uri === "vayu://scripting/completions");
	if (!r) throw new Error("scripting resource is not registered");
	return r;
}

function contextWith(completionsPayload: unknown, getScriptCompletions = vi.fn()) {
	getScriptCompletions.mockResolvedValue(completionsPayload);
	return {
		ctx: { client: { getScriptCompletions } as unknown as EngineClient } as ToolContext,
		getScriptCompletions,
	};
}

describe("projectScriptingSurface", () => {
	test("keeps the fields that mean something outside an editor", () => {
		const surface = projectScriptingSurface({
			version: "1.0.0",
			engine: "quickjs",
			completions: [engineEntry("pm.crypto.sha256")],
		});

		expect(surface.version).toBe("1.0.0");
		expect(surface.engine).toBe("quickjs");
		expect(surface.completions).toEqual([
			{
				label: "pm.crypto.sha256",
				detail: "pm.crypto.sha256(arg: string): string",
				documentation: "What pm.crypto.sha256 does.",
			},
		]);
	});

	test("drops Monaco's own fields - snippet placeholders and the kind enum", () => {
		const surface = projectScriptingSurface({
			completions: [engineEntry("pm.test")],
		});

		const [entry] = surface.completions;
		for (const monacoOnly of [
			"kind",
			"insertText",
			"insertTextRules",
			"sortText",
			"filterText",
		]) {
			expect(entry).not.toHaveProperty(monacoOnly);
		}
	});

	test("keeps snippet entries - their label and documentation still name a capability", () => {
		const surface = projectScriptingSurface({
			completions: [
				engineEntry("Sign the outgoing request", {
					kind: 28,
					detail: "Script template",
					documentation: "HMAC-sign the request from a pre-request script.",
				}),
			],
		});

		expect(surface.completions).toHaveLength(1);
		expect(surface.completions[0].documentation).toContain("HMAC-sign");
	});

	test("omits detail / documentation when the engine sent none, rather than emitting undefined", () => {
		const surface = projectScriptingSurface({ completions: [{ label: "pm" }] });

		expect(surface.completions[0]).toEqual({ label: "pm" });
	});

	test("skips entries with no usable label instead of offering a nameless API", () => {
		const surface = projectScriptingSurface({
			completions: [{ label: "" }, { kind: 1 }, null, "pm.test", engineEntry("pm.expect")],
		});

		expect(surface.completions.map((c) => c.label)).toEqual(["pm.expect"]);
	});

	// A partial surface is worse than an error: an agent reads a short list as
	// "the sandbox cannot do that" and never attempts what is missing.
	test.each([
		["a payload that is not an object", "not json"],
		["a payload with no completions key", { version: "1.0.0" }],
		["a completions value that is not an array", { completions: { label: "pm" } }],
		["null", null],
	])("throws loudly on %s", (_label, payload) => {
		expect(() => projectScriptingSurface(payload)).toThrow(/scripting\/completions/);
	});
});

describe("vayu://scripting/completions resource", () => {
	test("serves whatever the engine's completions endpoint returned", async () => {
		// A name the app has never heard of: only a resource that actually reads
		// the engine can produce it, so a hardcoded list here fails.
		const { ctx, getScriptCompletions } = contextWith({
			version: "1.0.0",
			engine: "quickjs",
			completions: [engineEntry("pm.somethingTheAppHasNeverHeardOf")],
		});

		const surface = (await scriptingResource().read(ctx)) as {
			completions: Array<{ label: string }>;
		};

		expect(getScriptCompletions).toHaveBeenCalledTimes(1);
		expect(surface.completions.map((c) => c.label)).toEqual([
			"pm.somethingTheAppHasNeverHeardOf",
		]);
	});

	test("a name the engine stops serving disappears from the resource", async () => {
		const { ctx } = contextWith({ completions: [engineEntry("pm.test")] });

		const surface = (await scriptingResource().read(ctx)) as {
			completions: Array<{ label: string }>;
		};

		expect(surface.completions.map((c) => c.label)).not.toContain("pm.crypto.sha256");
	});

	test("forwards the cancellation signal to the engine client", async () => {
		const { ctx, getScriptCompletions } = contextWith({ completions: [] });
		const controller = new AbortController();

		await scriptingResource().read(ctx, controller.signal);

		expect(getScriptCompletions).toHaveBeenCalledWith(controller.signal);
	});

	test("propagates an engine failure rather than serving an empty surface", async () => {
		const ctx = {
			client: {
				getScriptCompletions: vi.fn().mockRejectedValue(new Error("engine is down")),
			} as unknown as EngineClient,
		} as ToolContext;

		await expect(scriptingResource().read(ctx)).rejects.toThrow("engine is down");
	});
});

/**
 * The declarations half of the same surface (issue #760). The completions
 * resource answers "what is there"; this one answers "what does it take", and
 * the same anti-drift rule applies - the text must be the engine's, not a copy
 * kept here.
 */
describe("vayu://scripting/types resource", () => {
	const typesResource = () => {
		const r = STATIC_RESOURCES.find((s) => s.uri === "vayu://scripting/types");
		if (!r) throw new Error("scripting types resource is not registered");
		return r;
	};

	function typesContext(payload: unknown, getScriptTypeDefinitions = vi.fn()) {
		getScriptTypeDefinitions.mockResolvedValue(payload);
		return {
			ctx: {
				client: { getScriptTypeDefinitions } as unknown as EngineClient,
			} as ToolContext,
			getScriptTypeDefinitions,
		};
	}

	test("serves the declarations the engine generated, with its version stamps", async () => {
		// A declaration the app has never heard of: only a resource that reads
		// the engine can produce it, so a hardcoded .d.ts here fails.
		const { ctx, getScriptTypeDefinitions } = typesContext({
			version: "1.0.0",
			engine: "quickjs",
			libUri: "ts:vayu/pm.d.ts",
			typeDefinitions: "declare function somethingTheAppHasNeverHeardOf(): void;",
		});

		const types = await typesResource().read(ctx);

		expect(getScriptTypeDefinitions).toHaveBeenCalledTimes(1);
		expect(types).toEqual({
			version: "1.0.0",
			engine: "quickjs",
			libUri: "ts:vayu/pm.d.ts",
			typeDefinitions: "declare function somethingTheAppHasNeverHeardOf(): void;",
		});
	});

	test("forwards the cancellation signal to the engine client", async () => {
		const { ctx, getScriptTypeDefinitions } = typesContext({
			typeDefinitions: "declare var pm;",
		});
		const controller = new AbortController();

		await typesResource().read(ctx, controller.signal);

		expect(getScriptTypeDefinitions).toHaveBeenCalledWith(controller.signal);
	});

	// Same rule as the completions resource: an agent reading a missing
	// declaration concludes the sandbox has no such call.
	test.each([
		["a payload that is not an object", "declare var pm;"],
		["a payload with no typeDefinitions key", { version: "1.0.0" }],
		["typeDefinitions that is not a string", { typeDefinitions: { pm: true } }],
		["an empty declaration text", { typeDefinitions: "" }],
		["null", null],
	])("throws loudly on %s", (_label, payload) => {
		expect(() => projectScriptingTypes(payload)).toThrow(/scripting\/types/);
	});

	test("propagates an engine failure rather than serving an empty surface", async () => {
		const ctx = {
			client: {
				getScriptTypeDefinitions: vi.fn().mockRejectedValue(new Error("engine is down")),
			} as unknown as EngineClient,
		} as ToolContext;

		await expect(typesResource().read(ctx)).rejects.toThrow("engine is down");
	});
});

/**
 * The description is what an agent reads before it reads the payload, so it is
 * the part that can lie. `vayu://runs` serves one page - the reader asks for
 * `?limit=100` - and a description promising "all runs" talks an agent out of
 * looking for a baseline the workspace still holds.
 */
describe("vayu://runs description", () => {
	const runsResource = () => {
		const r = STATIC_RESOURCES.find((s) => s.uri === "vayu://runs");
		if (!r) throw new Error("runs resource is not registered");
		return r;
	};

	test("states the page size and does not promise every run", () => {
		const description = runsResource().description;
		expect(description.length).toBeGreaterThan(0);
		expect(description).toContain("100");
		expect(description).not.toMatch(/^All runs/);
	});

	test("points at the pagination fields that carry the real count", () => {
		expect(runsResource().description).toMatch(/pagination\.total/);
	});
});

describe("the variable resolution resource", () => {
	const resource = () => {
		const r = STATIC_RESOURCES.find((s) => s.uri === VARIABLE_RESOLUTION_URI);
		if (!r) throw new Error("variable resolution resource is not registered");
		return r;
	};

	const read = async () =>
		(await resource().read({} as ToolContext)) as typeof VARIABLE_RESOLUTION_MODEL;

	test("is registered and needs no engine call to answer", async () => {
		// A rules document, not current state: it must not fail with the engine
		// down, which is exactly when an agent is reading about resolution.
		await expect(resource().read({} as ToolContext)).resolves.toBeDefined();
	});

	test("states the four tiers, in order, once", async () => {
		const model = await read();
		expect(model.tiers.map((t) => t.scope)).toEqual([
			"global",
			"collection",
			"environment",
			"row",
		]);
		// Ranks ascend with precedence, so a client sorting by rank gets the
		// ladder rather than declaration order.
		expect(model.tiers.map((t) => t.rank)).toEqual([1, 2, 3, 4]);
	});

	test("every tier names the tools that write it, and those tools exist", async () => {
		const model = await read();
		const toolNames = new Set(TOOLS.map((t) => t.name));
		const named = model.tiers.flatMap((t) => [...t.writtenBy, ...t.readBy]);
		// "Written but never read" in reverse: a tool named here that no longer
		// exists sends an agent to a call it cannot make.
		expect(named.length).toBeGreaterThan(0);
		for (const name of named) expect(toolNames, name).toContain(name);
	});

	test("names where resolution actually runs, so the model is not read as MCP's own", async () => {
		const model = await read();
		expect(model.resolvedBy).toMatch(/POST \/compose/);
		expect(model.resolvedBy).toMatch(/conformance fixture|shared conformance/i);
	});

	test("the collections resource points at the model too, not just environments", () => {
		const collections = STATIC_RESOURCES.find((s) => s.uri === "vayu://collections");
		expect(collections?.description).toContain(VARIABLE_PRECEDENCE_SENTENCE);
		expect(collections?.description).toContain(VARIABLE_RESOLUTION_URI);
	});

	test("carries the rules a winner alone cannot express", async () => {
		const model = await read();
		const rules = model.rules.join(" ");
		// Mutation check: drop any one of these rules and its line fails.
		expect(rules).toMatch(/only an explicit `enabled: false` disables/i);
		expect(rules).toMatch(/non-string stored `value` reads as the empty string/i);
		expect(rules).toMatch(/absent, not present-and-empty/i);
	});

	test("names the reserved namespaces, and the $vu / $guid split", async () => {
		const model = await read();
		const patterns = model.reservedNamespaces.map((n) => n.pattern);
		expect(patterns.some((p) => p.includes("data."))).toBe(true);
		expect(patterns.some((p) => p.includes("$vu"))).toBe(true);

		const vu = model.reservedNamespaces.find((n) => n.pattern.includes("$vu"))!;
		const guid = model.reservedNamespaces.find((n) => n.pattern.includes("$guid"))!;
		// The two behave oppositely and the docs say so: a variable named $vu
		// does not answer for the identity, a variable named $guid does win.
		expect(vu.rule).toMatch(/does not answer/i);
		expect(guid.rule).toMatch(/DOES win|does win/i);
	});

	test("describes the scoped-vs-merged script read, the #1196 footgun", async () => {
		const model = await read();
		expect(model.fromAScript.scoped).toMatch(/do not fall through/i);
		expect(model.fromAScript.merged).toMatch(/stopping at the first scope/i);
		expect(model.fromAScript.chain).toMatch(/whole chain/i);
	});

	test("the environments resource points at the model rather than restating it", () => {
		const environments = STATIC_RESOURCES.find((s) => s.uri === "vayu://environments");
		expect(environments?.description).toContain(VARIABLE_PRECEDENCE_SENTENCE);
		expect(environments?.description).toContain(VARIABLE_RESOLUTION_URI);
		// The fact the old one-liner omitted, and the reason an agent wrote to
		// the wrong environment.
		expect(environments?.description).toMatch(/isActive/);
	});
});
