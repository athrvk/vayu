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
 * Stopping the live run a `RunningRun` names (#3381). The two kinds stop
 * differently: the dashboard's run also detaches the stream and settles the
 * store, a run no dashboard owns refreshes the History caches instead.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useStopLiveRun } from "./useStopLiveRun";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/queries/keys";
import { apiService } from "@/services/api";
import { loadTestService } from "@/services/load-test-service";
import { useDashboardStore, isDashboardRunLive } from "@/stores/dashboard-store";
import type { RunningRun } from "@/stores/run-gate";
import { useToastStore } from "@/stores/toast-store";

const DASHBOARD_RUN: RunningRun = { kind: "load", runId: "run_dash", label: null };
const COLLECTION_RUN: RunningRun = { kind: "collection", runId: "run_coll", label: null };

afterEach(() => {
	useDashboardStore.setState({ currentRunId: null, phase: { phase: "idle" }, isStopping: false });
	useToastStore.setState({ toasts: [] });
	vi.restoreAllMocks();
});

describe("useStopLiveRun", () => {
	// Mutation check: delete the `stopMonitoring()` call and the stream stays
	// attached to a run the engine has stopped.
	it("stops the dashboard's run, detaches its stream and settles the store", async () => {
		const stopRun = vi.spyOn(apiService, "stopRun").mockResolvedValue({} as never);
		const detach = vi.spyOn(loadTestService, "stopMonitoring").mockImplementation(() => {});
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");
		useDashboardStore.getState().startRun("run_dash");
		const { result } = renderHook(() => useStopLiveRun());

		await act(() => result.current.stop(DASHBOARD_RUN));

		expect(stopRun).toHaveBeenCalledWith("run_dash");
		expect(detach).toHaveBeenCalledTimes(1);
		expect(isDashboardRunLive(useDashboardStore.getState().phase)).toBe(false);
		expect(useDashboardStore.getState().isStopping).toBe(false);
		expect(result.current.isStopping).toBe(false);
		expect(invalidate).not.toHaveBeenCalled();
	});

	// Mutation check: drop `setStopping(runId, true)` and the header never
	// shows Stopping while the request is out.
	it("marks the dashboard run stopping while the request is in flight", async () => {
		let answer: (value: never) => void = () => {};
		vi.spyOn(apiService, "stopRun").mockReturnValue(
			new Promise<never>((resolve) => {
				answer = resolve;
			})
		);
		vi.spyOn(loadTestService, "stopMonitoring").mockImplementation(() => {});
		useDashboardStore.getState().startRun("run_dash");
		const { result } = renderHook(() => useStopLiveRun());

		let done: Promise<void> = Promise.resolve();
		act(() => {
			done = result.current.stop(DASHBOARD_RUN);
		});

		expect(useDashboardStore.getState().isStopping).toBe(true);
		expect(result.current.isStopping).toBe(true);
		await act(async () => {
			answer({} as never);
			await done;
		});
		expect(useDashboardStore.getState().isStopping).toBe(false);
	});

	// Mutation check: route every kind through the dashboard path and the
	// collection run is stopped without its caches refreshed (or, worse, the
	// dashboard's unrelated run is detached).
	it("stops a run no dashboard owns and refreshes what History shows of it", async () => {
		const stopRun = vi.spyOn(apiService, "stopRun").mockResolvedValue({} as never);
		const detach = vi.spyOn(loadTestService, "stopMonitoring").mockImplementation(() => {});
		const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
		useDashboardStore.getState().startRun("run_dash");
		const { result } = renderHook(() => useStopLiveRun());

		await act(() => result.current.stop(COLLECTION_RUN));

		expect(stopRun).toHaveBeenCalledWith("run_coll");
		expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.runs.detail("run_coll") });
		expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.runs.report("run_coll") });
		expect(detach).not.toHaveBeenCalled();
		expect(isDashboardRunLive(useDashboardStore.getState().phase)).toBe(true);
	});

	it.each([{ run: DASHBOARD_RUN }, { run: COLLECTION_RUN }])(
		"tells the user a $run.kind stop failed and retries the same run",
		async ({ run }) => {
			vi.spyOn(console, "error").mockImplementation(() => {});
			const stopRun = vi
				.spyOn(apiService, "stopRun")
				.mockRejectedValue(new Error("unreachable"));
			const detach = vi.spyOn(loadTestService, "stopMonitoring").mockImplementation(() => {});
			vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
			useDashboardStore.getState().startRun("run_dash");
			const { result } = renderHook(() => useStopLiveRun());

			await act(() => result.current.stop(run));

			const [toast] = useToastStore.getState().toasts;
			expect(toast).toMatchObject({
				variant: "error",
				message: "Couldn't stop the run - unreachable",
				action: { label: "Try again" },
			});
			expect(detach).not.toHaveBeenCalled();
			expect(isDashboardRunLive(useDashboardStore.getState().phase)).toBe(true);
			expect(useDashboardStore.getState().isStopping).toBe(false);
			expect(result.current.isStopping).toBe(false);

			stopRun.mockClear();
			stopRun.mockResolvedValue({} as never);
			act(() => toast.action?.onClick());
			await waitFor(() => expect(stopRun).toHaveBeenCalledWith(run.runId));
		}
	);
});
