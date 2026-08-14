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
 * The provider half of the variable popover, through the real provider.
 *
 * Every other test around this feature either mocks `useRequestBuilderContext`
 * or drives `VariablePopover` by props, so the two things the provider actually
 * derives were verified only against stubs. Both are the kind that agree today
 * because they were written together and have nothing holding them together
 * tomorrow:
 *
 *   - `writableScopes` repeats the guards `updateVariable` opens each branch
 *     with. If a guard changes and this list does not, the popover offers a
 *     scope whose write silently returns.
 *   - a write always **enables**. Each branch used to spread the existing entry
 *     to keep its flags, so creating a value for a name that was disabled
 *     everywhere kept `enabled: false` - the token stayed red and Create
 *     appeared to do nothing. That is the same dead end Create exists to
 *     remove, so it is worth a test rather than a comment.
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
	// The provider walks this for the auth an `inherit` resolves to; nothing
	// here is about inheritance, so the chain is empty.
	useCollectionAncestors: () => [],
	useEnvironmentsQuery: () => ({ data: environments }),
	useUpdateGlobalsMutation: () => ({ mutate: mutateGlobals }),
	useUpdateCollectionMutation: () => ({ mutate: mutateCollection }),
	useUpdateEnvironmentMutation: () => ({ mutate: mutateEnvironment }),
	useLastDesignRunQuery: () => ({ run: null, report: null, isLoading: false }),
}));
vi.mock("@/stores", async (importOriginal) => ({
	// The real event-stream store, which the provider reads to know whether a
	// stream of its own is open (issue #574). Left real rather than stubbed:
	// it is a plain zustand store with no side effects, and a stub would have
	// to reproduce its selectors to answer "nothing is streaming".
	...(await importOriginal<typeof import("@/stores")>()),
	useSessionStore: () => session,
	useResponseStore: () => ({ getResponse: () => null, setResponse: vi.fn() }),
}));
vi.mock("@/hooks", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/hooks")>();
	return { ...actual, useSaveManager: () => ({ saveStatus: "idle", isSaving: false }) };
});

const { default: RequestBuilderProvider } = await import("./RequestBuilderProvider");
const { useRequestBuilderContext } = await import("./RequestBuilderContext");

function setup(opts: {
	globalVars?: Record<string, unknown>;
	cols?: Array<{ id: string; name: string; variables?: Record<string, unknown> }>;
	envs?: Array<{ id: string; name: string; variables?: Record<string, unknown> }>;
	collectionId?: string | null;
	activeEnvironmentId?: string | null;
}) {
	globals.variables = opts.globalVars ?? {};
	collections.length = 0;
	collections.push(...(opts.cols ?? []));
	environments.length = 0;
	environments.push(...(opts.envs ?? []));
	session.activeEnvironmentId = opts.activeEnvironmentId ?? null;

	return renderHook(() => useRequestBuilderContext(), {
		wrapper: ({ children }) => (
			<RequestBuilderProvider collectionId={opts.collectionId ?? null}>
				{children}
			</RequestBuilderProvider>
		),
	}).result;
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
		// `updateVariable`'s environment branch opens with
		// `if (!activeEnvironmentId) return`, so offering it here would give the
		// popover a Create button that silently does nothing.
		const r = setup({ globalVars: {} });
		expect(r.current.writableScopes).not.toContain("environment");
	});

	it("omits the collection when the builder has none", () => {
		const r = setup({ globalVars: {} });
		expect(r.current.writableScopes).not.toContain("collection");
	});

	it("omits a collection id that matches no loaded collection", () => {
		// The branch re-finds the collection and returns if it is missing, so an
		// id alone is not enough to promise a write will land.
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
	 * a list that over-promises only over-promises where the target is missing -
	 * checking the fully-populated case alone cannot fail.
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
		// The dead end this closes: a name disabled everywhere does not resolve,
		// so the token is red and the popover offers Create - and the write used
		// to spread the disabled entry, keep `enabled: false`, and leave the
		// token exactly as red as before.
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
		// The one that was switched off stays switched off - only the variable
		// being written is enabled.
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
	/*
	 * `createdAt` is the variables editor's sort key, and absent means "older
	 * than everything". So a variable created here must be stamped, or it sorts
	 * above rows that genuinely predate it; one that already exists must keep the
	 * stamp it has; and one that has none must keep having none, because
	 * backfilling on a write reshuffles a settled list every time a value happens
	 * to be edited (issue #135).
	 */
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
