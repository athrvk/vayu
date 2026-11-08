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
 * A failed auto-save used to stop trying, permanently. The failure published
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
import { resetSaveStoreForTests, useSaveStore, type FlushTally } from "@/stores/save-store";
import { ApiError } from "@/services/http-client";
import { SaveBlockedError } from "@/lib/elements";
import { saveRetryDelayMs } from "@/lib/save-failure";
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
	resetSaveStoreForTests();
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
		// The helper the hook reads its delay from, pinned against the constant
		// it caps at - this is what "capped at a minute" means without driving
		// eight failures through fake timers to prove it.
		expect(saveRetryDelayMs(5000, 0)).toBe(5000);
		expect(saveRetryDelayMs(5000, 3)).toBe(40000);
		expect(saveRetryDelayMs(5000, 10)).toBe(TIMING.SAVE_RETRY_MAX_DELAY_MS);
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

	it("re-registers a context whose entity-switch flush failed, so a later flush can retry it (#1489)", async () => {
		const onSaveA = vi.fn().mockRejectedValue(new Error("engine unreachable"));
		const onSaveB = vi.fn().mockResolvedValue(undefined);
		const { rerender } = mountManager({ entityId: "req_a", onSave: onSaveA });

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(onSaveA).toHaveBeenCalledTimes(1);

		// The register/unregister effect has already dropped "request-req_a" for
		// the switch by the time the cleanup's own flush fails against onSaveA a
		// moment later - the context has to be put back for `flushAll` (a
		// reconnect, or a later quit) to find it at all.
		await act(async () => {
			rerender({ entityId: "req_b", onSave: onSaveB, hasChanges: false });
			await vi.advanceTimersByTimeAsync(0);
		});

		const context = useSaveStore.getState().contexts.get("request-req_a");
		expect(context?.hasPendingChanges).toBe(true);
	});

	it("clears that context once a later flush saves it, so the Dock goes idle and a reconnect sends nothing", async () => {
		// Mutation check: re-registering the raw saver, which leaves the entry
		// dirty after it lands, makes the second flush send the draft again.
		const onSaveA = vi.fn().mockRejectedValueOnce(new Error("engine unreachable"));
		onSaveA.mockRejectedValueOnce(new Error("engine unreachable"));
		onSaveA.mockResolvedValue(undefined);
		const onSaveB = vi.fn().mockResolvedValue(undefined);
		const { rerender } = mountManager({ entityId: "req_a", onSave: onSaveA });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		await act(async () => {
			rerender({ entityId: "req_b", onSave: onSaveB, hasChanges: false });
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(useSaveStore.getState().status).toBe("error");

		let first: FlushTally | undefined;
		await act(async () => {
			first = await useSaveStore.getState().flushAll();
		});
		expect(first).toEqual({ saved: 1, failed: 0, pending: 0 });
		expect(onSaveA).toHaveBeenCalledTimes(3);
		expect(useSaveStore.getState().contexts.has("request-req_a")).toBe(false);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(TIMING.SAVED_STATUS_DURATION_MS);
		});
		expect(useSaveStore.getState().status).toBe("idle");

		await act(async () => {
			await useSaveStore.getState().flushAll();
		});
		expect(onSaveA).toHaveBeenCalledTimes(3);
	});

	it("does not leave a held-back entity-switch flush counting as unsaved", async () => {
		// The pane is gone and the provider reseeds from the next entity, so
		// nothing is left that could ever send the held part.
		const onSaveA = vi.fn().mockRejectedValue(new SaveBlockedError());
		const { rerender } = mountManager({ entityId: "req_a", onSave: onSaveA });
		expect(useSaveStore.getState().status).toBe("pending");

		await act(async () => {
			rerender({ entityId: "req_b", onSave: vi.fn(), hasChanges: false });
			await vi.advanceTimersByTimeAsync(0);
		});

		expect(onSaveA).toHaveBeenCalledTimes(1);
		expect(useSaveStore.getState().status).toBe("idle");
	});

	it("pokes the health query on a network failure, not on a 4xx the engine rejected outright", async () => {
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");
		const onSave = vi
			.fn()
			.mockRejectedValueOnce(new ApiError(400, "BAD_REQUEST", "bad request"));
		mountManager({ entityId: "req_1", onSave });

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(onSave).toHaveBeenCalledTimes(1);
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("pokes the health query when a save fails without the engine answering", async () => {
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");
		const onSave = vi.fn().mockRejectedValueOnce(new Error("fetch failed"));
		mountManager({ entityId: "req_1", onSave });

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(invalidate).toHaveBeenCalledTimes(1);
	});
});

/**
 * A 4xx is the engine's verdict on the payload, so re-sending it can only
 * re-toast (#1889). The status stays "error" - the Dock keeps saying "Not
 * saved" - and the next edit is what arms another attempt.
 */
describe("a save the engine rejected with a 4xx", () => {
	it("is not retried, and the failure stays on screen", async () => {
		const onSave = vi
			.fn()
			.mockRejectedValueOnce(new ApiError(400, "BAD_REQUEST", "bad request"));
		mountManager({ entityId: "req_1", onSave });

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(onSave).toHaveBeenCalledTimes(1);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(TIMING.SAVE_RETRY_MAX_DELAY_MS);
		});
		expect(onSave).toHaveBeenCalledTimes(1);
		expect(useSaveStore.getState().status).toBe("error");
	});

	it("is saved again by the next edit", async () => {
		const onSave = vi
			.fn()
			.mockRejectedValueOnce(new ApiError(413, "PAYLOAD_TOO_LARGE", "too large"))
			.mockResolvedValueOnce(undefined);
		const { rerender } = renderHook(
			({ changeToken }: { changeToken: number }) =>
				useSaveManager({
					entityId: "req_1",
					onSave,
					hasChanges: true,
					changeToken,
				}),
			{ initialProps: { changeToken: 1 }, wrapper }
		);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(onSave).toHaveBeenCalledTimes(1);

		await act(async () => {
			rerender({ changeToken: 2 });
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(onSave).toHaveBeenCalledTimes(2);
		expect(useSaveStore.getState().status).toBe("saved");
	});

	it("still retries a 5xx, which is the engine's trouble and not the payload's", async () => {
		const onSave = vi
			.fn()
			.mockRejectedValueOnce(new ApiError(503, "UNAVAILABLE", "busy"))
			.mockResolvedValueOnce(undefined);
		mountManager({ entityId: "req_1", onSave });

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(onSave).toHaveBeenCalledTimes(2);
		expect(useSaveStore.getState().status).toBe("saved");
	});

	it("still retries a failure that is not an engine verdict at all", async () => {
		const onSave = vi
			.fn()
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockResolvedValueOnce(undefined);
		mountManager({ entityId: "req_1", onSave });

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(onSave).toHaveBeenCalledTimes(2);
	});
});

/**
 * The engine answers a write its volume has no room for with 507 (#2423). It
 * clears when space is freed, so unlike a 4xx it is retried; unlike a dead
 * engine it has a cause the toast and the quit prompt can name.
 */
describe("a save the disk had no room for", () => {
	const diskFull = () =>
		new ApiError(
			507,
			"insufficient_storage",
			"The disk holding Vayu's data is full - free up space and try again"
		);

	it("shows the engine's sentence under the generic lead, with no lead of its own", async () => {
		const onSave = vi.fn().mockRejectedValueOnce(diskFull());
		mountManager({ entityId: "req_1", onSave });

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});

		expect(useSaveStore.getState().status).toBe("error");
		expect(useSaveStore.getState().lastErrorMessage).toBe(
			"Couldn't save - The disk holding Vayu's data is full - free up space and try again"
		);
		// Mutation check: reporting the failure without its cause clears this.
		expect(useSaveStore.getState().unsaved.get("request-req_1")).toMatchObject({
			diskFull: true,
		});
	});

	it("keeps the generic lead for a 4xx", async () => {
		const onSave = vi
			.fn()
			.mockRejectedValueOnce(new ApiError(400, "bad_request", "name is required"));
		mountManager({ entityId: "req_1", onSave });

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});

		expect(useSaveStore.getState().lastErrorMessage).toBe("Couldn't save - name is required");
	});

	it("is retried on the backoff and saved once space returns", async () => {
		const onSave = vi.fn().mockRejectedValueOnce(diskFull()).mockResolvedValueOnce(undefined);
		mountManager({ entityId: "req_1", onSave });

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(onSave).toHaveBeenCalledTimes(1);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(onSave).toHaveBeenCalledTimes(2);
		expect(useSaveStore.getState().status).toBe("saved");
	});

	it("reaches the quit flush as a disk-full failure, not a generic one", async () => {
		const onSave = vi.fn().mockRejectedValue(diskFull());
		mountManager({ entityId: "req_1", onSave });

		let result: FlushTally | undefined;
		await act(async () => {
			result = await useSaveStore.getState().flushAll();
		});

		expect(result).toEqual({ saved: 0, failed: 1, pending: 0, reason: "disk-full" });
	});
});
