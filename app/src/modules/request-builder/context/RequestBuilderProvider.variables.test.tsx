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
 * `RequestBuilderProvider`'s own slice of variable writing: proof that it
 * forwards its `collectionId` prop into `useVariableWriter` (issue #1651)
 * rather than, say, a stale closed-over id or a hardcoded `undefined`. The
 * behavior matrix this used to hold directly - which scopes are writable,
 * that a write always enables, row-ordering on write - now lives with the
 * hook itself in `hooks/useVariableWriter.test.ts`, since the behavior moved
 * there; duplicating it here would just be two suites for one guard to drift
 * apart in.
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
	// RequestBuilderProvider now reads the catalogue itself (issue #1635); an
	// empty list means "nothing required", so the save-skip check is inert.
	useElementKindsQuery: () => ({ data: [] }),
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
	// The provider reads the engine data caps for Send-with-row's row cap
	// (`useDataFileLimits`); empty entries leave it on the seeds.
	useConfigQuery: () => ({ data: { entries: [] } }),
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

describe("RequestBuilderProvider forwards its collectionId into useVariableWriter", () => {
	it("offers the collection scope once its own collectionId prop resolves to a loaded collection", () => {
		const r = setup({
			globalVars: {},
			cols: [{ id: "c1", name: "Acme" }],
			collectionId: "c1",
		});
		expect(r.current.writableScopes).toContain("collection");

		r.current.updateVariable("token", "abc", "collection");
		expect(mutateCollection).toHaveBeenCalledWith({
			id: "c1",
			variables: { token: expect.objectContaining({ value: "abc", enabled: true }) },
		});
	});

	it("omits collection when the prop is null, rather than reading some other id", () => {
		const r = setup({
			globalVars: {},
			cols: [{ id: "c1", name: "Acme" }],
			collectionId: null,
		});
		expect(r.current.writableScopes).not.toContain("collection");
	});
});
