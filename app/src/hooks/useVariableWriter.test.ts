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
 * The write half of variable scope (issue #1651), extracted out of
 * `RequestBuilderProvider` so the collection Elements tab can use the same
 * `updateVariable`/`writableScopes` it always had, instead of the hardcoded
 * no-op/`[]` that made every script element's token there open read-only.
 *
 * This suite is `RequestBuilderProvider.variables.test.tsx`'s behavior matrix,
 * moved here because the behavior itself moved: that file now only proves the
 * provider forwards its own `collectionId` into this hook correctly, and this
 * one is the source of truth for what the hook actually does. Both things it
 * verifies are the kind that agree today because they were written together
 * and have nothing holding them together tomorrow:
 *
 *   - `writableScopes` repeats the guards `updateVariable` opens each branch
 *     with. If a guard changes and this list does not, a caller offers a
 *     scope whose write silently returns.
 *   - a write always **enables**. Each branch used to spread the existing
 *     entry to keep its flags, so creating a value for a name that was
 *     disabled everywhere kept `enabled: false` - the token stayed red and
 *     Create appeared to do nothing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

const globals = { variables: {} as Record<string, unknown> };
const collections: Array<Record<string, unknown>> = [];
const environments: Array<Record<string, unknown>> = [];
const session = {
	activeEnvironmentId: null as string | null,
};

const mutateGlobals = vi.fn();
const mutateCollection = vi.fn();
const mutateEnvironment = vi.fn();

vi.mock("@/queries", () => ({
	useGlobalsQuery: () => ({ data: globals }),
	useCollectionsQuery: () => ({ data: collections }),
	useEnvironmentsQuery: () => ({ data: environments }),
	useUpdateGlobalsMutation: () => ({ mutate: mutateGlobals }),
	useUpdateCollectionMutation: () => ({ mutate: mutateCollection }),
	useUpdateEnvironmentMutation: () => ({ mutate: mutateEnvironment }),
}));
vi.mock("@/stores", () => ({
	useSessionStore: (selector: (s: typeof session) => unknown) => selector(session),
}));

import { useVariableWriter } from "./useVariableWriter";

function setup(opts: {
	globalVars?: Record<string, unknown>;
	cols?: Array<{ id: string; name: string; variables?: Record<string, unknown> }>;
	envs?: Array<{ id: string; name: string; variables?: Record<string, unknown> }>;
	collectionId?: string;
	activeEnvironmentId?: string | null;
}) {
	globals.variables = opts.globalVars ?? {};
	collections.length = 0;
	collections.push(...(opts.cols ?? []));
	environments.length = 0;
	environments.push(...(opts.envs ?? []));
	session.activeEnvironmentId = opts.activeEnvironmentId ?? null;

	return renderHook(() => useVariableWriter({ collectionId: opts.collectionId })).result;
}

beforeEach(() => {
	vi.clearAllMocks();
	globals.variables = {};
	collections.length = 0;
	environments.length = 0;
	session.activeEnvironmentId = null;
});

describe("which scopes a variable can be created in", () => {
	it("omits the environment when none is selected", () => {
		const r = setup({ globalVars: {} });
		expect(r.current.writableScopes).not.toContain("environment");
	});

	it("omits the collection when no collectionId is passed", () => {
		const r = setup({ globalVars: {} });
		expect(r.current.writableScopes).not.toContain("collection");
	});

	it("omits a collection id that matches no loaded collection", () => {
		const r = setup({
			globalVars: {},
			cols: [{ id: "c1", name: "Acme" }],
			collectionId: "gone",
		});
		expect(r.current.writableScopes).not.toContain("collection");
	});

	it("lists all three when each has a target", () => {
		const r = setup({
			globalVars: {},
			cols: [{ id: "c1", name: "Acme" }],
			envs: [{ id: "e1", name: "Staging" }],
			collectionId: "c1",
			activeEnvironmentId: "e1",
		});
		expect(r.current.writableScopes).toEqual(["global", "collection", "environment"]);
	});

	/*
	 * The property, stated directly: every scope offered must actually reach a
	 * mutation. Run across the states that differ in what is selected, because
	 * a list that over-promises only over-promises where the target is
	 * missing - checking the fully-populated case alone cannot fail.
	 */
	it.each([
		["nothing selected", {}],
		["environment only", { envs: [{ id: "e1", name: "Staging" }], activeEnvironmentId: "e1" }],
		["collection only", { cols: [{ id: "c1", name: "Acme" }], collectionId: "c1" }],
		[
			"a collection id pointing at nothing",
			{ cols: [{ id: "c1", name: "Acme" }], collectionId: "gone" },
		],
		[
			"both",
			{
				cols: [{ id: "c1", name: "Acme" }],
				collectionId: "c1",
				envs: [{ id: "e1", name: "Staging" }],
				activeEnvironmentId: "e1",
			},
		],
	])("promises nothing it cannot deliver: %s", (_label, opts) => {
		const r = setup({ globalVars: {}, ...opts });
		expect(r.current.writableScopes.length).toBeGreaterThan(0);
		for (const scope of r.current.writableScopes) {
			vi.clearAllMocks();
			r.current.updateVariable("newVar", "v", scope);
			const fired =
				mutateGlobals.mock.calls.length +
				mutateCollection.mock.calls.length +
				mutateEnvironment.mock.calls.length;
			expect(fired, `${scope} was offered but wrote nothing`).toBe(1);
		}
	});
});

describe("writing a variable enables it", () => {
	it("creates a new one enabled", () => {
		const r = setup({ globalVars: {} });
		r.current.updateVariable("token", "abc", "global");
		expect(mutateGlobals).toHaveBeenCalledWith({
			variables: { token: expect.objectContaining({ value: "abc", enabled: true }) },
		});
	});

	it("re-enables a name that was defined but switched off", () => {
		const r = setup({ globalVars: { token: { value: "old", enabled: false } } });
		r.current.updateVariable("token", "abc", "global");
		expect(mutateGlobals).toHaveBeenCalledWith({
			variables: { token: expect.objectContaining({ value: "abc", enabled: true }) },
		});
	});

	it("leaves the other variables in the scope alone", () => {
		const r = setup({
			globalVars: {
				keep: { value: "x", enabled: true },
				off: { value: "y", enabled: false },
			},
		});
		r.current.updateVariable("keep", "z", "global");
		const written = mutateGlobals.mock.calls[0][0].variables;
		expect(written.off).toEqual({ value: "y", enabled: false });
	});

	it("keeps flags it has no business changing, like secret", () => {
		const r = setup({
			globalVars: { apiKey: { value: "old", enabled: true, secret: true } },
		});
		r.current.updateVariable("apiKey", "new", "global");
		expect(mutateGlobals.mock.calls[0][0].variables.apiKey).toEqual({
			value: "new",
			enabled: true,
			secret: true,
		});
	});

	it("writes into a collection that has never had variables", () => {
		const r = setup({ globalVars: {}, cols: [{ id: "c1", name: "Acme" }], collectionId: "c1" });
		r.current.updateVariable("token", "abc", "collection");
		expect(mutateCollection).toHaveBeenCalledWith({
			id: "c1",
			variables: { token: expect.objectContaining({ value: "abc", enabled: true }) },
		});
	});
});

describe("writing a variable leaves row ordering alone", () => {
	it("stamps a variable it creates", () => {
		const before = Date.now();
		const r = setup({ globalVars: {} });
		r.current.updateVariable("token", "abc", "global");
		expect(mutateGlobals.mock.calls[0][0].variables.token.createdAt).toBeGreaterThanOrEqual(
			before
		);
	});

	it("keeps the stamp an existing variable already carries", () => {
		const r = setup({ globalVars: { token: { value: "old", enabled: true, createdAt: 42 } } });
		r.current.updateVariable("token", "abc", "global");
		expect(mutateGlobals.mock.calls[0][0].variables.token).toEqual({
			value: "abc",
			enabled: true,
			createdAt: 42,
		});
	});

	it("does not backfill a stamp onto an existing variable that has none", () => {
		const r = setup({ globalVars: { token: { value: "old", enabled: true } } });
		r.current.updateVariable("token", "abc", "global");
		expect(mutateGlobals.mock.calls[0][0].variables.token).not.toHaveProperty("createdAt");
	});
});

/*
 * An edit writes to the definition the popover displayed (#3683). The request's
 * own collection is only where a *create* lands: with a chain root that defines
 * the name and a leaf that does not, editing from the leaf used to write a copy
 * of the root's value into the leaf and leave the root's untouched.
 */
describe("editing a definition from a collection chain", () => {
	const chain = {
		cols: [
			{
				id: "root",
				name: "Root",
				variables: {
					baseUrl: { value: "https://old", enabled: true, secret: true, createdAt: 7 },
				},
			},
			{ id: "leaf", name: "Leaf", variables: {} },
		],
		collectionId: "leaf",
	};

	it("writes to the collection the sourceId names, keeping its flags", () => {
		const r = setup(chain);
		r.current.updateVariable("baseUrl", "https://new", "collection", "root");
		expect(mutateCollection).toHaveBeenCalledTimes(1);
		expect(mutateCollection).toHaveBeenCalledWith({
			id: "root",
			variables: {
				baseUrl: { value: "https://new", enabled: true, secret: true, createdAt: 7 },
			},
		});
	});

	it("never touches the request's own collection", () => {
		const r = setup(chain);
		r.current.updateVariable("baseUrl", "https://new", "collection", "root");
		expect(mutateCollection).not.toHaveBeenCalledWith(expect.objectContaining({ id: "leaf" }));
	});

	it("is a no-op when the source collection is gone, not a write to the leaf", () => {
		const r = setup(chain);
		r.current.updateVariable("baseUrl", "https://new", "collection", "deleted");
		expect(mutateCollection).not.toHaveBeenCalled();
	});

	it("still creates in the request's own collection when no sourceId is given", () => {
		const r = setup(chain);
		r.current.updateVariable("fresh", "v", "collection");
		expect(mutateCollection).toHaveBeenCalledWith({
			id: "leaf",
			variables: { fresh: expect.objectContaining({ value: "v", enabled: true }) },
		});
	});
});

describe("editing an environment definition", () => {
	const envs = [
		{ id: "e1", name: "Staging", variables: { host: { value: "a", enabled: true } } },
		{ id: "e2", name: "Prod", variables: { host: { value: "b", enabled: true } } },
	];

	it("writes to the environment the sourceId names", () => {
		const r = setup({ envs, activeEnvironmentId: "e1" });
		r.current.updateVariable("host", "c", "environment", "e2");
		expect(mutateEnvironment).toHaveBeenCalledWith({
			id: "e2",
			variables: { host: { value: "c", enabled: true } },
		});
	});

	it("is a no-op when the source environment is gone", () => {
		const r = setup({ envs, activeEnvironmentId: "e1" });
		r.current.updateVariable("host", "c", "environment", "deleted");
		expect(mutateEnvironment).not.toHaveBeenCalled();
	});

	it("creates in the active environment when no sourceId is given", () => {
		const r = setup({ envs, activeEnvironmentId: "e1" });
		r.current.updateVariable("fresh", "v", "environment");
		expect(mutateEnvironment).toHaveBeenCalledWith(expect.objectContaining({ id: "e1" }));
	});
});

/*
 * A create can mark the entry secret. It can land on an existing entry (the
 * popover offers a create while the name's only definition is switched off), so
 * the mark applies there too; an edit passes no options and never changes it.
 */
describe("creating a secret", () => {
	const SCOPES: Array<["global" | "collection" | "environment", Parameters<typeof setup>[0]]> = [
		["global", {}],
		["collection", { cols: [{ id: "c1", name: "Acme" }], collectionId: "c1" }],
		["environment", { envs: [{ id: "e1", name: "Staging" }], activeEnvironmentId: "e1" }],
	];

	/** The entry the write put under `name`, from whichever mutation it reached. */
	function written(scope: "global" | "collection" | "environment", name: string) {
		const call = {
			global: mutateGlobals,
			collection: mutateCollection,
			environment: mutateEnvironment,
		}[scope].mock.calls[0][0];
		return call.variables[name];
	}

	it.each(SCOPES)("stores secret: true on a new %s entry", (scope, opts) => {
		const r = setup(opts);
		r.current.updateVariable("signing_key", "pem", scope, undefined, { secret: true });
		expect(written(scope, "signing_key")).toEqual({
			value: "pem",
			enabled: true,
			createdAt: expect.any(Number),
			secret: true,
		});
	});

	it.each([
		["no options", undefined],
		["secret: false", { secret: false }],
	])("leaves a new entry as it was with %s", (_label, options) => {
		const r = setup({});
		r.current.updateVariable("token", "abc", "global", undefined, options);
		expect(written("global", "token")).toEqual({
			value: "abc",
			enabled: true,
			createdAt: expect.any(Number),
		});
	});

	it("marks an existing definition a create lands on, and re-enables it", () => {
		const r = setup({ globalVars: { token: { value: "old", enabled: false, createdAt: 9 } } });
		r.current.updateVariable("token", "abc", "global", undefined, { secret: true });
		expect(written("global", "token")).toEqual({
			value: "abc",
			enabled: true,
			createdAt: 9,
			secret: true,
		});
	});

	it("does not mark an existing definition when the flag is off", () => {
		const r = setup({ globalVars: { token: { value: "old", enabled: false } } });
		r.current.updateVariable("token", "abc", "global", undefined, { secret: false });
		expect(written("global", "token")).toEqual({ value: "abc", enabled: true });
	});

	it("keeps the mark an existing secret has when an edit passes no options", () => {
		const r = setup({ globalVars: { token: { value: "old", enabled: true, secret: true } } });
		r.current.updateVariable("token", "abc", "global");
		expect(written("global", "token")).toEqual({ value: "abc", enabled: true, secret: true });
	});

	it("never un-secrets an existing secret, whatever the flag says", () => {
		const r = setup({ globalVars: { token: { value: "old", enabled: true, secret: true } } });
		r.current.updateVariable("token", "abc", "global", undefined, { secret: false });
		expect(written("global", "token")).toEqual({ value: "abc", enabled: true, secret: true });
	});
});
