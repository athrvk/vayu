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
	useSessionStore: () => session,
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
