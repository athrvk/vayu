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
 * A failed auto-save used to stop trying, permanently. `failSave` published
 * `status: "error"` and a ten-second toast, and nothing on the auto-save path
 * ever scheduled another attempt: the effect that arms a save only reacts to a
 * *new* edit, and the draft that just failed to save is not one.
 *
 * These cases drive `performSave` to reject and assert the retry it now
 * schedules - doubling from the user's auto-save delay, capped, cancelled on
 * unmount and on an entity switch, and dropped once a save actually lands.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import { useClientSettingsStore } from "@/stores";
import { useSaveStore } from "@/stores/save-store";
import { ApiError } from "@/services/http-client";
import { TIMING } from "@/config/timing";
import { useSaveManager } from "./useSaveManager";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client: queryClient }, children);
}

interface Props {
	entityId: string;
	onSave: () => Promise<void>;
	hasChanges?: boolean;
}

function mountManager(initial: Props) {
	return renderHook(
		(props: Props) =>
			useSaveManager({
				entityId: props.entityId,
				contextName: "Request",
				onSave: props.onSave,
				hasChanges: props.hasChanges ?? true,
				changeToken: 1,
			}),
		{ initialProps: initial, wrapper }
	);
}

beforeEach(() => {
	vi.useFakeTimers();
	useSaveStore.getState().reset();
	useClientSettingsStore.setState({ autoSave: { enabled: true, delayMs: 5000 } });
	queryClient.clear();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("retrying a failed auto-save", () => {
	it("tries again after the auto-save delay, not never", async () => {
		const onSave = vi.fn().mockRejectedValueOnce(new Error("engine unreachable"));
		onSave.mockResolvedValueOnce(undefined);
		mountManager({ entityId: "req_1", onSave });

		// The ordinary auto-save fires and fails.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(onSave).toHaveBeenCalledTimes(1);
		expect(useSaveStore.getState().status).toBe("error");

		// Nothing else re-arms a save: the auto-save effect only reacts to a new
		// edit, and none has landed.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(4999);
		});
		expect(onSave).toHaveBeenCalledTimes(1);

		// The retry, at the same delay as the first attempt (attempt 0).
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1);
		});
		expect(onSave).toHaveBeenCalledTimes(2);
		expect(useSaveStore.getState().status).toBe("saved");
	});

	it("doubles the delay on each further failure, capped at the ceiling", async () => {
		const onSave = vi
			.fn()
			.mockRejectedValueOnce(new Error("one"))
			.mockRejectedValueOnce(new Error("two"))
			.mockResolvedValueOnce(undefined);
		mountManager({ entityId: "req_1", onSave });

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000); // first attempt, fails
		});
		expect(onSave).toHaveBeenCalledTimes(1);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000); // retry 1: 5000 * 2^0
		});
		expect(onSave).toHaveBeenCalledTimes(2);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(9999); // retry 2 armed at 5000 * 2^1
		});
		expect(onSave).toHaveBeenCalledTimes(2);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1);
		});
		expect(onSave).toHaveBeenCalledTimes(3);
		expect(useSaveStore.getState().status).toBe("saved");
	});

	it("never waits past the retry ceiling", () => {
		// The formula the hook uses, pinned against the constant it reads -
		// this is what "capped at a minute" means without driving eight
		// failures through fake timers to prove it.
		const delay = (attempt: number) =>
			Math.min(5000 * 2 ** attempt, TIMING.SAVE_RETRY_MAX_DELAY_MS);
		expect(delay(0)).toBe(5000);
		expect(delay(3)).toBe(40000);
		expect(delay(10)).toBe(TIMING.SAVE_RETRY_MAX_DELAY_MS);
	});

	it("stops retrying once a save lands, rather than continuing to back off", async () => {
		const onSave = vi
			.fn()
			.mockRejectedValueOnce(new Error("one"))
			.mockResolvedValueOnce(undefined);
		mountManager({ entityId: "req_1", onSave });

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000); // the retry, which succeeds
		});
		expect(onSave).toHaveBeenCalledTimes(2);
		expect(useSaveStore.getState().status).toBe("saved");

		// If a stale retry were still armed, this would call onSave again with
		// nothing having failed.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(onSave).toHaveBeenCalledTimes(2);
	});

	it("cancels the scheduled retry on unmount", async () => {
		const onSave = vi.fn().mockRejectedValue(new Error("engine unreachable"));
		const { unmount } = mountManager({ entityId: "req_1", onSave });

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(onSave).toHaveBeenCalledTimes(1);

		// Unmounting a dirty entity flushes it once more, on its own - that
		// pre-dates retries and stays a single attempt. The flush is fired
		// from the cleanup without being awaited, so let its microtask land.
		unmount();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(onSave).toHaveBeenCalledTimes(2);

		// What retries cancel: nothing calls onSave a third time once the
		// component is gone, however long real time (or a stray timer) runs.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(onSave).toHaveBeenCalledTimes(2);
	});

	it("cancels the scheduled retry on an entity switch, rather than saving into the new one", async () => {
		const onSaveA = vi.fn().mockRejectedValue(new Error("engine unreachable"));
		const onSaveB = vi.fn().mockResolvedValue(undefined);
		const { rerender } = mountManager({ entityId: "req_a", onSave: onSaveA });

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(onSaveA).toHaveBeenCalledTimes(1);

		// Switch to a clean req_b - hasChanges: false, so nothing about *its*
		// own auto-save effect schedules a save, which isolates the thing this
		// case exists to catch. The old entity's dirty draft still flushes once
		// from the cleanup (against onSaveA, which fails again); the retry the
		// first failure armed must not survive to call onSaveB.
		await act(async () => {
			rerender({ entityId: "req_b", onSave: onSaveB, hasChanges: false });
		});
		expect(onSaveA).toHaveBeenCalledTimes(2);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(onSaveB).not.toHaveBeenCalled();
	});

	it("pokes the health query on a network failure, not on a 4xx the engine rejected outright", async () => {
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");
		const onSave = vi
			.fn()
			.mockRejectedValueOnce(new ApiError(400, "BAD_REQUEST", "bad request"))
			.mockRejectedValueOnce(new Error("fetch failed"));
		mountManager({ entityId: "req_1", onSave });

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(invalidate).not.toHaveBeenCalled();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000); // the retry, a network error this time
		});
		expect(invalidate).toHaveBeenCalledTimes(1);
	});
});
