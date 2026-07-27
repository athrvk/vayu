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
 * Settings → store → timer, end to end.
 *
 * The chain is four links: `GeneralPanel` calls `setAutoSave`, the persisted
 * `client-settings-store` holds `{enabled, delayMs}`, `useSaveManager` reads
 * both, and `RequestBuilderProvider` mounts the hook. Every link existed, and
 * *none* of it was tested: `useSaveManager` is mocked out in all four test
 * files that touch it, so nothing anywhere asserted that the delay a user picks
 * is the delay that runs.
 *
 * That mattered because the neighbouring config had already rotted -
 * `TIMING.AUTO_SAVE_DELAY_MS` is 3000, has no readers, and disagrees with the
 * real default of 5000 in `constants/client-settings.ts`. A hook that quietly
 * used the dead constant would have looked exactly like this one.
 *
 * These tests drive the store the way the Settings panel does rather than
 * passing a delay in, so a regression that stops reading the setting fails
 * here even though the hook's own signature never changes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSaveManager } from "./useSaveManager";
import { useClientSettingsStore } from "@/stores";
import { useSaveStore } from "@/stores/save-store";

/** What the Settings panel writes when the user picks a delay. */
function chooseInSettings(patch: { enabled?: boolean; delayMs?: number }) {
	act(() => {
		useClientSettingsStore.getState().setAutoSave(patch);
	});
}

function mountManager(onSave: () => Promise<void>) {
	return renderHook(() =>
		useSaveManager({ entityId: "req_1", contextName: "Request", onSave, hasChanges: true })
	);
}

describe("the auto-save delay chosen in Settings", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		useSaveStore.getState().reset();
		useClientSettingsStore.setState({ autoSave: { enabled: true, delayMs: 5000 } });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("is the delay that actually runs, and not a moment before", async () => {
		const onSave = vi.fn().mockResolvedValue(undefined);
		mountManager(onSave);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(4999);
		});
		expect(onSave).not.toHaveBeenCalled();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1);
		});
		expect(onSave).toHaveBeenCalledTimes(1);
	});

	it("moves when the user picks a different one", async () => {
		/*
		 * The discriminating case. A hook that hardcoded a constant - the dead
		 * `TIMING.AUTO_SAVE_DELAY_MS`, say - passes the test above whenever the
		 * constant happens to match the default, and fails only here.
		 */
		chooseInSettings({ delayMs: 1000 });
		const onSave = vi.fn().mockResolvedValue(undefined);
		mountManager(onSave);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(999);
		});
		expect(onSave).not.toHaveBeenCalled();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1);
		});
		expect(onSave).toHaveBeenCalledTimes(1);
	});

	it("reschedules an edit already waiting, rather than letting the old timer win", async () => {
		// `autoSaveDelayMs` is in the effect's dependency list, so changing the
		// setting mid-wait tears the pending timer down and starts a new one.
		const onSave = vi.fn().mockResolvedValue(undefined);
		mountManager(onSave);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(3000);
		});
		expect(onSave).not.toHaveBeenCalled();

		chooseInSettings({ delayMs: 10_000 });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2000); // 5s total - the old deadline
		});
		expect(onSave).not.toHaveBeenCalled();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(8000);
		});
		expect(onSave).toHaveBeenCalledTimes(1);
	});
});

describe("turning auto-save off in Settings", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		useSaveStore.getState().reset();
		useClientSettingsStore.setState({ autoSave: { enabled: false, delayMs: 5000 } });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("never fires the timer", async () => {
		const onSave = vi.fn().mockResolvedValue(undefined);
		mountManager(onSave);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(onSave).not.toHaveBeenCalled();
	});

	it("still reports the edit as unsaved, so Cmd+S has something to save", async () => {
		// Off means "do not save for me", not "pretend there is nothing to save".
		const onSave = vi.fn().mockResolvedValue(undefined);
		mountManager(onSave);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(useSaveStore.getState().status).toBe("pending");
	});
});
