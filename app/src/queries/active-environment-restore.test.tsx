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
 * The active environment is engine state, and these lock the round trip.
 *
 * Which environment is active used to live only in localStorage, so it was
 * per-machine, per-profile, and invisible to the engine that stores the column
 * for it. Now the switch is a PUT and the answer comes back from the engine on
 * the next launch. The behaviours worth locking are the ones a future edit
 * could quietly drop: the switch reaching the wire at all, the rollback when
 * the engine refuses (a selection the engine did not accept must not survive,
 * or the next launch silently disagrees), the adopt-on-start direction, and
 * the one-shot upgrade push for users whose choice predates the column.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useSetActiveEnvironmentMutation } from "./environments";
import { useActiveEnvironmentRestore } from "@/hooks/useActiveEnvironmentRestore";
import { useSessionStore } from "@/stores/session-store";

const listEnvironments = vi.fn();
const updateEnvironment = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: {
		listEnvironments: (...a: unknown[]) => listEnvironments(...a),
		updateEnvironment: (...a: unknown[]) => updateEnvironment(...a),
	},
}));

const DEV = { id: "env_dev", name: "Dev", isActive: false };
const PROD = { id: "env_prod", name: "Prod", isActive: false };

function makeClient() {
	return new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: Infinity },
			mutations: { retry: false },
		},
	});
}

function wrapper(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

beforeEach(() => {
	listEnvironments.mockReset();
	updateEnvironment.mockReset();
	useSessionStore.setState({ activeEnvironmentId: null });
});

describe("switching the active environment", () => {
	it("tells the engine, so the choice outlives this window", async () => {
		updateEnvironment.mockResolvedValue({ ...PROD, isActive: true });
		listEnvironments.mockResolvedValue([DEV, PROD]);
		const { result } = renderHook(() => useSetActiveEnvironmentMutation(), {
			wrapper: wrapper(makeClient()),
		});

		await act(async () => {
			await result.current.mutateAsync({ id: "env_prod", previousId: "env_dev" });
		});

		// One PUT, not two: the engine deactivates env_dev in the same
		// transaction, so a client-side companion write would be a second
		// definition of the same rule.
		expect(updateEnvironment).toHaveBeenCalledTimes(1);
		expect(updateEnvironment).toHaveBeenCalledWith({ id: "env_prod", isActive: true });
		expect(useSessionStore.getState().activeEnvironmentId).toBe("env_prod");
	});

	it("clears by deactivating the environment that holds the flag", async () => {
		updateEnvironment.mockResolvedValue({ ...PROD, isActive: false });
		listEnvironments.mockResolvedValue([DEV, PROD]);
		useSessionStore.setState({ activeEnvironmentId: "env_prod" });
		const { result } = renderHook(() => useSetActiveEnvironmentMutation(), {
			wrapper: wrapper(makeClient()),
		});

		await act(async () => {
			await result.current.mutateAsync({ id: null, previousId: "env_prod" });
		});

		expect(updateEnvironment).toHaveBeenCalledWith({ id: "env_prod", isActive: false });
		expect(useSessionStore.getState().activeEnvironmentId).toBeNull();
	});

	it("rolls the selection back when the engine refuses it", async () => {
		updateEnvironment.mockRejectedValue(new Error("engine unreachable"));
		listEnvironments.mockResolvedValue([DEV, PROD]);
		useSessionStore.setState({ activeEnvironmentId: "env_dev" });
		const { result } = renderHook(() => useSetActiveEnvironmentMutation(), {
			wrapper: wrapper(makeClient()),
		});

		await act(async () => {
			await result.current
				.mutateAsync({ id: "env_prod", previousId: "env_dev" })
				.catch(() => undefined);
		});

		// Not env_prod: the UI must not show a selection the next launch will
		// contradict.
		expect(useSessionStore.getState().activeEnvironmentId).toBe("env_dev");
	});
});

describe("restoring on launch", () => {
	it("adopts the environment the engine has marked active", async () => {
		listEnvironments.mockResolvedValue([DEV, { ...PROD, isActive: true }]);
		renderHook(() => useActiveEnvironmentRestore(), { wrapper: wrapper(makeClient()) });

		await waitFor(() =>
			expect(useSessionStore.getState().activeEnvironmentId).toBe("env_prod")
		);
		// Adopting is a read, not a write-back.
		expect(updateEnvironment).not.toHaveBeenCalled();
	});

	it("pushes a persisted selection the engine does not know about, once", async () => {
		// The upgrade path: a choice made before the engine stored it.
		// listEnvironments keeps answering "nobody is active" - a write the
		// engine dropped, or one whose effect this client has not seen yet - so
		// every refetch re-presents the exact condition that triggered the push.
		listEnvironments.mockResolvedValue([DEV, PROD]);
		updateEnvironment.mockResolvedValue({ ...DEV, isActive: true });
		useSessionStore.setState({ activeEnvironmentId: "env_dev" });

		const client = makeClient();
		renderHook(() => useActiveEnvironmentRestore(), { wrapper: wrapper(client) });

		await waitFor(() => expect(updateEnvironment).toHaveBeenCalledTimes(1));
		expect(updateEnvironment).toHaveBeenCalledWith({ id: "env_dev", isActive: true });

		await act(async () => {
			await client.refetchQueries();
		});

		expect(updateEnvironment).toHaveBeenCalledTimes(1);
		expect(useSessionStore.getState().activeEnvironmentId).toBe("env_dev");
	});

	it("does not re-ask forever when the push keeps failing", async () => {
		/*
		 * The failure path is the one that needs the once-per-session guard.
		 * On success the engine starts reporting the environment active and the
		 * condition that triggered the push is gone; on failure nothing changes -
		 * the store still holds a valid id, the engine still reports none - so
		 * every re-render that clears the in-flight flag re-presents it.
		 *
		 * The rejection is deferred rather than immediate so React actually
		 * commits the pending state and then the settled one. An immediately
		 * rejected mock is batched into a single commit, which hides the loop
		 * this test exists to catch.
		 */
		listEnvironments.mockResolvedValue([DEV, PROD]);
		updateEnvironment.mockImplementation(
			() =>
				new Promise((_resolve, reject) =>
					setTimeout(() => reject(new Error("engine unreachable")), 10)
				)
		);
		useSessionStore.setState({ activeEnvironmentId: "env_dev" });

		const client = makeClient();
		renderHook(() => useActiveEnvironmentRestore(), { wrapper: wrapper(client) });

		await waitFor(() => expect(updateEnvironment).toHaveBeenCalledTimes(1));
		await act(async () => {
			await new Promise((r) => setTimeout(r, 150));
			await client.refetchQueries();
			await new Promise((r) => setTimeout(r, 50));
		});

		expect(updateEnvironment).toHaveBeenCalledTimes(1);
	});

	it("adopts a deactivation the engine reports after holding a selection", async () => {
		/*
		 * The direction #758 needed: `activate_environment` with "none" clears the
		 * engine's flag, and this window has a perfectly valid id in its store.
		 * Without the once-seen guard the upgrade push fires on that refetch and
		 * writes the id straight back - the MCP call undone by the app that was
		 * only watching. Revert the guard and this test sees a PUT.
		 */
		listEnvironments.mockResolvedValue([DEV, { ...PROD, isActive: true }]);
		const client = makeClient();
		renderHook(() => useActiveEnvironmentRestore(), { wrapper: wrapper(client) });

		await waitFor(() =>
			expect(useSessionStore.getState().activeEnvironmentId).toBe("env_prod")
		);

		listEnvironments.mockResolvedValue([DEV, PROD]);
		await act(async () => {
			await client.refetchQueries();
		});

		await waitFor(() => expect(useSessionStore.getState().activeEnvironmentId).toBeNull());
		expect(updateEnvironment).not.toHaveBeenCalled();
	});

	it("keeps the stored selection when the engine cannot be reached", async () => {
		// An empty list from a failed fetch reads exactly like "no environments
		// exist" - clearing on it would drop a good selection every time the app
		// wins the startup race.
		listEnvironments.mockRejectedValue(new Error("ECONNREFUSED"));
		useSessionStore.setState({ activeEnvironmentId: "env_dev" });

		renderHook(() => useActiveEnvironmentRestore(), { wrapper: wrapper(makeClient()) });

		await new Promise((r) => setTimeout(r, 50));
		expect(useSessionStore.getState().activeEnvironmentId).toBe("env_dev");
		expect(updateEnvironment).not.toHaveBeenCalled();
	});
});
