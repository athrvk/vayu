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
 * `activeEnvironmentId` must never outlive its environment.
 *
 * The switcher hides a dangling id behind a defensive `find()` - it renders
 * "No Environment" and looks correct - while every composed payload keeps
 * carrying the deleted id, and localStorage keeps it across restarts. So the
 * assertions here are about the *store*, not the label: what the UI shows was
 * never the broken half.
 *
 * Two closing points, because an id can go stale two ways:
 *   - the delete this app performed (the mutation), and
 *   - an id that was already stale when the app started (the guard).
 *
 * The guard's `isSuccess` condition carries the weight: an unreachable engine
 * also produces an empty list, and clearing on that would throw away a good
 * selection every time the app won the startup race against the engine.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useDeleteEnvironmentMutation } from "./environments";
import { useActiveEnvironmentGuard } from "@/hooks/useActiveEnvironmentGuard";
import { useSessionStore } from "@/stores/session-store";
import { queryKeys } from "./keys";
import type { Environment } from "@/types";

const deleteEnvironment = vi.fn();
const listEnvironments = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: {
		deleteEnvironment: (...a: unknown[]) => deleteEnvironment(...a),
		listEnvironments: (...a: unknown[]) => listEnvironments(...a),
	},
}));

const env = (id: string): Environment =>
	({ id, name: id, variables: {} }) as unknown as Environment;

function makeClient() {
	return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
}

function wrapper(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	useSessionStore.setState({ activeEnvironmentId: null });
});

describe("deleting an environment clears it from the session", () => {
	it("nulls the active id when the deleted environment was the active one", async () => {
		useSessionStore.setState({ activeEnvironmentId: "e1" });
		deleteEnvironment.mockResolvedValue(undefined);
		const client = makeClient();
		client.setQueryData(queryKeys.environments.list(), [env("e1"), env("e2")]);

		const { result } = renderHook(() => useDeleteEnvironmentMutation(), {
			wrapper: wrapper(client),
		});
		await result.current.mutateAsync("e1");

		// The point of the fix: without it the id survives here, and every
		// subsequent /compose carries an environment the engine has deleted.
		expect(useSessionStore.getState().activeEnvironmentId).toBeNull();
		expect(client.getQueryData(queryKeys.environments.list())).toEqual([env("e2")]);
	});

	it("leaves the active id alone when a different environment is deleted", async () => {
		useSessionStore.setState({ activeEnvironmentId: "e1" });
		deleteEnvironment.mockResolvedValue(undefined);
		const client = makeClient();
		client.setQueryData(queryKeys.environments.list(), [env("e1"), env("e2")]);

		const { result } = renderHook(() => useDeleteEnvironmentMutation(), {
			wrapper: wrapper(client),
		});
		await result.current.mutateAsync("e2");

		expect(useSessionStore.getState().activeEnvironmentId).toBe("e1");
	});

	it("keeps the id when the delete fails - the environment is still there", async () => {
		useSessionStore.setState({ activeEnvironmentId: "e1" });
		deleteEnvironment.mockRejectedValue(new Error("engine said no"));
		const client = makeClient();

		const { result } = renderHook(() => useDeleteEnvironmentMutation(), {
			wrapper: wrapper(client),
		});
		await expect(result.current.mutateAsync("e1")).rejects.toThrow("engine said no");

		expect(useSessionStore.getState().activeEnvironmentId).toBe("e1");
	});
});

describe("rehydrate validation", () => {
	it("clears a stored id the engine's environment list does not contain", async () => {
		useSessionStore.setState({ activeEnvironmentId: "gone" });
		listEnvironments.mockResolvedValue([env("e1")]);
		const client = makeClient();

		renderHook(() => useActiveEnvironmentGuard(), { wrapper: wrapper(client) });

		await waitFor(() => expect(useSessionStore.getState().activeEnvironmentId).toBeNull());
	});

	it("keeps an id the list does contain", async () => {
		useSessionStore.setState({ activeEnvironmentId: "e1" });
		listEnvironments.mockResolvedValue([env("e1")]);
		const client = makeClient();

		const { result } = renderHook(
			() => {
				useActiveEnvironmentGuard();
				return useSessionStore.getState().activeEnvironmentId;
			},
			{ wrapper: wrapper(client) }
		);

		await waitFor(() => expect(listEnvironments).toHaveBeenCalled());
		await waitFor(() => expect(result.current).toBe("e1"));
		expect(useSessionStore.getState().activeEnvironmentId).toBe("e1");
	});

	it("keeps the id when the environments query failed - an empty list is not proof", async () => {
		useSessionStore.setState({ activeEnvironmentId: "e1" });
		listEnvironments.mockRejectedValue(new Error("engine unreachable"));
		const client = makeClient();

		renderHook(() => useActiveEnvironmentGuard(), { wrapper: wrapper(client) });

		// The engine never answered, so nothing here is evidence that e1 is gone.
		// Guarding on `environments.length` instead of `isSuccess` fails this.
		await waitFor(() => expect(listEnvironments).toHaveBeenCalled());
		expect(useSessionStore.getState().activeEnvironmentId).toBe("e1");
	});
});
