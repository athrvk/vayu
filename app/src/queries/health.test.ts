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
 * The health poll is the only thing that carries the engine's startup recovery
 * record into the app (issue #922), and a field written by no one is the
 * mirror image of this codebase's most repeated defect. So this asserts the
 * wiring rather than the shape: the node reaches the store `RecoveryBanner`
 * reads, and a clean answer clears it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const getHealth = vi.fn();
vi.mock("@/services/api", () => ({ apiService: { getHealth: () => getHealth() } }));

import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { useHealthQuery } from "./health";
import { useEngineStore } from "@/stores";
import type { EngineRecovery } from "@/types/domain";

const RECOVERY: EngineRecovery = {
	outcome: "deleted_corrupt",
	at: 1_755_870_000_000,
	databasePath: "/home/someone/.vayu/vayu.db",
};

function wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
	vi.clearAllMocks();
	useEngineStore.setState({ isEngineConnected: false, engineError: null, recovery: null });
});

describe("useHealthQuery", () => {
	it("carries a reported recovery into the engine store", async () => {
		getHealth.mockResolvedValue({
			status: "ok",
			version: "1.0.0",
			workers: 8,
			recovery: RECOVERY,
		});

		renderHook(() => useHealthQuery(), { wrapper });

		await waitFor(() => expect(useEngineStore.getState().recovery).toEqual(RECOVERY));
	});

	it("clears the record when the engine reports a clean start", async () => {
		// Absent is a clean start, and the engine answering now is the authority
		// on its own startup - a stale record left in place would keep
		// announcing a wipe that a restarted engine no longer reports.
		useEngineStore.setState({ recovery: RECOVERY });
		getHealth.mockResolvedValue({ status: "ok", version: "1.0.0", workers: 8 });

		renderHook(() => useHealthQuery(), { wrapper });

		await waitFor(() => expect(useEngineStore.getState().isEngineConnected).toBe(true));
		expect(useEngineStore.getState().recovery).toBeNull();
	});
});
