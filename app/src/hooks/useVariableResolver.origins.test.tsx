/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The resolver used to throw away everything that lost.
 *
 * It built one flat map by overwriting - globals, then the collection chain
 * root-to-leaf, then the environment - so by the time anything could read it,
 * the only surviving fact was the winning value. That is all execution needs and
 * strictly less than the UI needs: the popover could say a variable came from
 * "an environment" but not *which*, and could not answer "why is this the value?"
 * at all.
 *
 * Two cases were invisible, and the second is the common one:
 *
 *   1. A name defined at several scopes - the losers were overwritten.
 *   2. A name whose highest-scope definition is **disabled**. `if (v.enabled)`
 *      meant it never entered the map, so nothing could report that the value
 *      you set is being skipped rather than absent.
 *
 * `getVariableOrigins` keeps both. What must NOT change is which definition
 * wins, so that is asserted here against the same cases the old loop handled -
 * the winner is now derived from the origins list rather than computed beside
 * it, which is the only way the two cannot drift apart.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

const globals = { variables: {} as Record<string, unknown> };
const collections: Array<Record<string, unknown>> = [];
const environments: Array<Record<string, unknown>> = [];
const session = {
	activeEnvironmentId: null as string | null,
};

vi.mock("@/queries", () => ({
	useGlobalsQuery: () => ({ data: globals }),
	useCollectionsQuery: () => ({ data: collections }),
	useEnvironmentsQuery: () => ({ data: environments }),
}));
vi.mock("@/stores", () => ({
	useSessionStore: () => session,
}));

import { useVariableResolver } from "./useVariableResolver";

/** `enabled` defaults to true - the disabled cases below say so explicitly. */
const v = (value: string, extra: Record<string, unknown> = {}) => ({
	value,
	enabled: true,
	...extra,
});

function setup(opts: {
	globalVars?: Record<string, unknown>;
	cols?: Array<{
		id: string;
		name: string;
		parentId?: string;
		variables?: Record<string, unknown>;
	}>;
	envs?: Array<{ id: string; name: string; variables?: Record<string, unknown> }>;
	activeCollectionId?: string | null;
	activeEnvironmentId?: string | null;
}) {
	globals.variables = opts.globalVars ?? {};
	collections.length = 0;
	collections.push(...(opts.cols ?? []));
	environments.length = 0;
	environments.push(...(opts.envs ?? []));
	session.activeEnvironmentId = opts.activeEnvironmentId ?? null;
	/*
	 * Collection scope is an explicit option, never a store field: the store
	 * fallback was removed with `activeCollectionId` (#239), which had a reader
	 * here and no writer anywhere.
	 */
	return renderHook(() =>
		useVariableResolver({ collectionId: opts.activeCollectionId ?? undefined })
	).result.current;
}

beforeEach(() => {
	globals.variables = {};
	collections.length = 0;
	environments.length = 0;
	session.activeEnvironmentId = null;
});

describe("which definition wins - unchanged behaviour", () => {
	it("prefers the environment over the collection chain and globals", () => {
		const r = setup({
			globalVars: { baseUrl: v("http://localhost:8080") },
			cols: [{ id: "c1", name: "Acme", variables: { baseUrl: v("https://api.acme.io") } }],
			envs: [
				{ id: "e1", name: "Staging", variables: { baseUrl: v("https://staging.acme.io") } },
			],
			activeCollectionId: "c1",
			activeEnvironmentId: "e1",
		});
		expect(r.getVariable("baseUrl")?.value).toBe("https://staging.acme.io");
		expect(r.resolveString("{{baseUrl}}/x")).toBe("https://staging.acme.io/x");
	});

	it("prefers the leaf collection over its ancestors", () => {
		const r = setup({
			cols: [
				{ id: "root", name: "Acme", variables: { baseUrl: v("https://root.io") } },
				{
					id: "leaf",
					name: "Billing",
					parentId: "root",
					variables: { baseUrl: v("https://leaf.io") },
				},
			],
			activeCollectionId: "leaf",
		});
		expect(r.getVariable("baseUrl")?.value).toBe("https://leaf.io");
	});

	it("skips a disabled definition and falls back to the next one down", () => {
		const r = setup({
			globalVars: { token: v("global-token") },
			envs: [
				{
					id: "e1",
					name: "Staging",
					variables: { token: v("env-token", { enabled: false }) },
				},
			],
			activeEnvironmentId: "e1",
		});
		expect(r.getVariable("token")?.value).toBe("global-token");
	});

	it("leaves a name unresolved when every definition is disabled", () => {
		// Absent, not present-and-empty: the red token keys off absence, and
		// `getAllVariables` is what feeds it - a present-and-empty entry would
		// paint the token as resolved and send "".
		const r = setup({
			globalVars: { token: v("x", { enabled: false }) },
		});
		expect(r.getVariable("token")).toBeNull();
		expect(r.getAllVariables()).not.toHaveProperty("token");
	});

	it("still carries the declared type through to typedValue", () => {
		// Regression guard: the winner is now rebuilt from an origin, and `type`
		// has to survive that trip or every script reading a typed variable
		// silently gets a string.
		const r = setup({ globalVars: { retries: v("3", { type: "number" }) } });
		expect(r.getVariable("retries")?.type).toBe("number");
		expect(r.getVariable("retries")?.typedValue).toBe(3);
	});
});

describe("where the winning value came from", () => {
	it("names the environment, not just the scope", () => {
		const r = setup({
			envs: [{ id: "e1", name: "Staging", variables: { host: v("staging.acme.io") } }],
			activeEnvironmentId: "e1",
		});
		expect(r.getVariable("host")).toMatchObject({
			scope: "environment",
			sourceId: "e1",
			sourceName: "Staging",
		});
	});

	it("names the specific collection in the chain", () => {
		const r = setup({
			cols: [
				{ id: "root", name: "Acme", variables: { host: v("root") } },
				{ id: "leaf", name: "Billing", parentId: "root", variables: { host: v("leaf") } },
			],
			activeCollectionId: "leaf",
		});
		expect(r.getVariable("host")).toMatchObject({ sourceId: "leaf", sourceName: "Billing" });
	});

	it("gives global no source name, because there is only one", () => {
		const r = setup({ globalVars: { host: v("x") } });
		expect(r.getVariable("host")?.scope).toBe("global");
		expect(r.getVariable("host")?.sourceName).toBeUndefined();
	});
});

describe("the definitions that lost", () => {
	it("lists every scope, lowest precedence first, marking the winner", () => {
		const r = setup({
			globalVars: { baseUrl: v("http://localhost:8080") },
			cols: [{ id: "c1", name: "Acme", variables: { baseUrl: v("https://api.acme.io") } }],
			envs: [
				{ id: "e1", name: "Staging", variables: { baseUrl: v("https://staging.acme.io") } },
			],
			activeCollectionId: "c1",
			activeEnvironmentId: "e1",
		});
		const origins = r.getVariableOrigins("baseUrl");
		expect(origins.map((o) => o.scope)).toEqual(["global", "collection", "environment"]);
		expect(origins.filter((o) => o.winner)).toHaveLength(1);
		expect(origins.find((o) => o.winner)?.value).toBe("https://staging.acme.io");
	});

	it("keeps a disabled definition, so it can explain the value that did win", () => {
		// The case the old `if (v.enabled)` filter made unreportable, and the most
		// common reason a value is not the one you set.
		const r = setup({
			globalVars: { token: v("global-token") },
			envs: [
				{
					id: "e1",
					name: "Staging",
					variables: { token: v("env-token", { enabled: false }) },
				},
			],
			activeEnvironmentId: "e1",
		});
		const origins = r.getVariableOrigins("token");
		expect(origins).toHaveLength(2);

		const disabled = origins.find((o) => o.scope === "environment");
		expect(disabled).toMatchObject({ enabled: false, winner: false, value: "env-token" });
		// It is present *and* explicitly not the winner - the distinction the
		// three-state row in the popover renders.
		expect(origins.find((o) => o.winner)?.scope).toBe("global");
	});

	it("marks no winner at all when every definition is disabled", () => {
		const r = setup({ globalVars: { token: v("x", { enabled: false }) } });
		const origins = r.getVariableOrigins("token");
		expect(origins).toHaveLength(1);
		expect(origins.some((o) => o.winner)).toBe(false);
	});

	it("keeps two collections in one chain apart", () => {
		// Both are scope "collection". Keyed by scope alone they would collapse
		// into one row and hide the override that actually happened.
		const r = setup({
			cols: [
				{ id: "root", name: "Acme", variables: { host: v("root.io") } },
				{
					id: "leaf",
					name: "Billing",
					parentId: "root",
					variables: { host: v("leaf.io") },
				},
			],
			activeCollectionId: "leaf",
		});
		const origins = r.getVariableOrigins("host");
		expect(origins).toHaveLength(2);
		expect(origins.map((o) => o.sourceName)).toEqual(["Acme", "Billing"]);
		expect(origins.find((o) => o.winner)?.sourceName).toBe("Billing");
	});

	it("returns an empty list for a name nothing defines", () => {
		const r = setup({});
		expect(r.getVariableOrigins("nope")).toEqual([]);
	});

	it("ignores collections outside the active chain", () => {
		const r = setup({
			cols: [
				{ id: "c1", name: "Acme", variables: { host: v("acme") } },
				{ id: "c2", name: "Other", variables: { host: v("other") } },
			],
			activeCollectionId: "c1",
		});
		expect(r.getVariableOrigins("host").map((o) => o.sourceName)).toEqual(["Acme"]);
	});
});
