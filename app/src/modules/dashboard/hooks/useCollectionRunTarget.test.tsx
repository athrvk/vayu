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
 * Where the live header gets a collection run's target from (#2270): the run's
 * own row (its snapshot's scenario manifest) and the collections tree.
 *
 * Mutation check: read `run.type === "scenario"` instead of the manifest (use
 * `scenarioFromSnapshot`) and the collection-load case reddens; resolve the
 * name without the id fallback and the deleted-collection case reddens.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { withQueryClient } from "@/test/query-wrapper";
import { useCollectionRunTarget } from "./useCollectionRunTarget";

const getRun = vi.hoisted(() => vi.fn());
const listCollections = vi.hoisted(() => vi.fn());
vi.mock("@/services/api", () => ({ apiService: { getRun, listCollections } }));

function snapshotRun(type: "load" | "scenario" | "design", configSnapshot: object) {
	return { id: "run_1", type, status: "running", startTime: 0, endTime: 0, configSnapshot };
}

const manifest = (collectionId: string) => ({
	scenario: { collectionId, steps: [{ name: "a" }, { name: "b" }, { name: "c" }] },
});

function mount() {
	return renderHook(() => useCollectionRunTarget("run_1"), {
		wrapper: ({ children }) => withQueryClient(children),
	});
}

beforeEach(() => {
	getRun.mockReset();
	listCollections.mockReset().mockResolvedValue([{ id: "col_1", name: "Checkout" }]);
});

describe("useCollectionRunTarget", () => {
	it("names a collection load run's collection and counts its steps", async () => {
		getRun.mockResolvedValue(snapshotRun("load", manifest("col_1")));
		const { result } = mount();

		await waitFor(() =>
			expect(result.current).toEqual({ collectionName: "Checkout", stepCount: 3 })
		);
	});

	it("reads a sequential collection run the same way", async () => {
		getRun.mockResolvedValue(snapshotRun("scenario", manifest("col_1")));
		const { result } = mount();

		await waitFor(() => expect(result.current.collectionName).toBe("Checkout"));
	});

	it("falls back to the collection's id once it is deleted, never a blank", async () => {
		getRun.mockResolvedValue(snapshotRun("load", manifest("col_gone")));
		const { result } = mount();

		await waitFor(() => expect(result.current.collectionName).toBe("col_gone"));
		expect(result.current.stepCount).toBe(3);
	});

	it("is empty for a request-level run", async () => {
		getRun.mockResolvedValue(snapshotRun("load", { url: "https://api.test/ping" }));
		const { result } = mount();

		await waitFor(() => expect(getRun).toHaveBeenCalled());
		await waitFor(() => expect(listCollections).toHaveBeenCalled());
		expect(result.current).toEqual({});
	});

	it("does not poll a run it reads once", async () => {
		getRun.mockResolvedValue(snapshotRun("load", manifest("col_1")));
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			const { result } = mount();
			await waitFor(() => expect(result.current.collectionName).toBe("Checkout"));
			await vi.advanceTimersByTimeAsync(60_000);

			expect(getRun).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
