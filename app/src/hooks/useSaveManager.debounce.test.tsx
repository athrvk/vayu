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
 * The delay is measured from the last edit, and "Saved" is a claim about the
 * editor rather than about the round trip (issue #1381).
 *
 * Both properties hang on `changeToken`, and both were broken without it. The
 * hook watched `hasChanges`, a boolean already `true` by the second keystroke:
 * the auto-save effect did not re-run, the timer armed by the *first* keystroke
 * ran to term, and a save went out five seconds into a burst carrying a
 * half-typed script. Then that save resolved, reported "Saved" over the
 * keystrokes it had not carried, and the provider cleared the dirty flag - so
 * nothing re-armed and the edit was gone.
 *
 * These cases drive the token the way an editing provider does: one increment
 * per edit, `hasChanges` staying `true` throughout, which is exactly the shape
 * that used to slip through.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useClientSettingsStore } from "@/stores";
import { useSaveStore } from "@/stores/save-store";
import { useSaveManager } from "./useSaveManager";

function mountManager(onSave: () => Promise<void>) {
	return renderHook(
		({ token }: { token: number }) =>
			useSaveManager({
				entityId: "req_1",
				contextName: "Request",
				onSave,
				// Dirty from the first edit and never re-clean: the provider only
				// clears this once a save carrying every edit comes back.
				hasChanges: true,
				changeToken: token,
			}),
		{ initialProps: { token: 1 } }
	);
}

/** Let queued promises run without moving the clock. */
async function settle() {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(0);
	});
}

/** A promise the test resolves by hand, to hold a save in flight. */
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("the auto-save delay as a debounce", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		useSaveStore.getState().reset();
		useClientSettingsStore.setState({ autoSave: { enabled: true, delayMs: 5000 } });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("restarts on every edit, so the save follows the pause and not the first keystroke", async () => {
		const onSave = vi.fn().mockResolvedValue(undefined);
		const { rerender } = mountManager(onSave);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(2000);
		});
		// A second edit, 2s into the first one's window.
		rerender({ token: 2 });

		await act(async () => {
			await vi.advanceTimersByTimeAsync(3000);
		});
		expect(onSave).not.toHaveBeenCalled();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1999);
		});
		expect(onSave).not.toHaveBeenCalled();

		// 5s after the *second* edit, not the first.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1);
		});
		expect(onSave).toHaveBeenCalledTimes(1);
	});

	it("saves a 15s typing burst once, at the end, not once per delay window", async () => {
		const onSave = vi.fn().mockResolvedValue(undefined);
		const { rerender } = mountManager(onSave);

		for (let edit = 2; edit <= 9; edit++) {
			await act(async () => {
				await vi.advanceTimersByTimeAsync(2000);
			});
			rerender({ token: edit });
		}
		expect(onSave).not.toHaveBeenCalled();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(onSave).toHaveBeenCalledTimes(1);
	});
});

describe("what a returning save is allowed to call itself", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		useSaveStore.setState({ status: "idle", contexts: new Map(), activeContextId: null });
		// Auto-save off: the only save in these cases is the explicit one, so the
		// status under test cannot be a later timer's.
		useClientSettingsStore.setState({ autoSave: { enabled: false, delayMs: 5000 } });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("reports Saved when nothing was typed while it was in flight", async () => {
		const held = deferred();
		const onSave = vi.fn().mockReturnValue(held.promise);
		const { result } = mountManager(onSave);

		act(() => {
			void result.current.forceSave();
		});
		await settle();
		expect(useSaveStore.getState().status).toBe("saving");

		held.resolve();
		await settle();
		expect(useSaveStore.getState().status).toBe("saved");
	});

	it("stays unsaved when an edit landed while it was in flight", async () => {
		const held = deferred();
		const onSave = vi.fn().mockReturnValue(held.promise);
		const { result, rerender } = mountManager(onSave);

		act(() => {
			void result.current.forceSave();
		});
		await settle();

		// The keystroke the flying payload does not carry.
		rerender({ token: 2 });

		held.resolve();
		await settle();
		expect(useSaveStore.getState().status).toBe("pending");
		expect(useSaveStore.getState().status).not.toBe("saved");
	});
});
