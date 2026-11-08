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
 * The hook speaks for this request's own edit, and only while the edit exists
 * (#3350).
 *
 * Its `status` was the Dock's, every surface's at once, so another surface's
 * failure kept the request's description source open (`InfoPanel`). And a
 * report it made was only ever cleared by a save: an edit reverted, or a
 * request deleted elsewhere while dirty, left "Unsaved changes" or "Not saved"
 * up until restart.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import { TIMING } from "@/config/timing";
import { useClientSettingsStore } from "@/stores";
import { resetSaveStoreForTests, useSaveStore } from "@/stores/save-store";
import { useSaveManager } from "./useSaveManager";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client: queryClient }, children);
}

interface Props {
	entityId?: string;
	onSave: () => Promise<void>;
	hasChanges?: boolean;
	enabled?: boolean;
}

function mountManager(initial: Props) {
	return renderHook(
		(props: Props) =>
			useSaveManager({
				entityId: props.entityId ?? "req_1",
				contextName: "Request",
				onSave: props.onSave,
				hasChanges: props.hasChanges ?? true,
				changeToken: 1,
				enabled: props.enabled ?? true,
			}),
		{ initialProps: initial, wrapper }
	);
}

const entry = (id = "request-req_1") => useSaveStore.getState().unsaved.get(id);
const offline = () => Promise.reject(new Error("engine unreachable"));

beforeEach(() => {
	vi.useFakeTimers();
	resetSaveStoreForTests();
	useClientSettingsStore.setState({ autoSave: { enabled: true, delayMs: 5000 } });
	queryClient.clear();
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("the status the hook returns", () => {
	// Mutation check (confirmed): returning the store's `status` again reads
	// "error" and `isSaving: true` from the settings id's reports.
	it("ignores another surface's reports", () => {
		const { result } = mountManager({ onSave: () => Promise.resolve(), hasChanges: false });

		act(() => useSaveStore.getState().reportFailed("settings", "Couldn't save settings"));
		expect(useSaveStore.getState().status).toBe("error");
		expect(result.current.status).toBe("idle");

		act(() => useSaveStore.getState().reportSaving("settings"));
		expect(result.current.isSaving).toBe(false);
	});

	it("follows this request's own save", async () => {
		let answer: () => void = () => {};
		const onSave = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					answer = resolve;
				})
		);
		const { result } = mountManager({ onSave });
		expect(result.current.status).toBe("pending");

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(result.current.status).toBe("saving");
		expect(result.current.isSaving).toBe(true);

		await act(async () => {
			answer();
		});
		expect(result.current.status).toBe("idle");
	});

	it("is error while this request's own save has failed", async () => {
		const { result } = mountManager({ onSave: offline });

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});

		expect(result.current.status).toBe("error");
	});
});

describe("an edit that is gone without a save", () => {
	// Mutation check (confirmed) for the four cases below: deleting the effect
	// that discards the id leaves the entry in place in each.
	it("withdraws 'Unsaved changes' when the edit is reverted", () => {
		useClientSettingsStore.setState({ autoSave: { enabled: false, delayMs: 5000 } });
		const props = { onSave: () => Promise.resolve() };
		const { rerender } = mountManager(props);
		expect(entry()?.kind).toBe("pending");

		rerender({ ...props, hasChanges: false });

		expect(entry()).toBeUndefined();
		expect(useSaveStore.getState().status).toBe("idle");
	});

	it("withdraws 'Not saved' and stops retrying when the failed edit is reverted", async () => {
		const onSave = vi.fn(offline);
		const { rerender } = mountManager({ onSave });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(entry()?.kind).toBe("failed");

		rerender({ onSave, hasChanges: false });
		expect(entry()).toBeUndefined();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(TIMING.SAVE_RETRY_MAX_DELAY_MS);
		});
		expect(onSave).toHaveBeenCalledTimes(1);
	});

	it("withdraws 'Not saved' when the request is deleted elsewhere", async () => {
		const onSave = vi.fn(offline);
		const { rerender } = mountManager({ onSave });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(entry()?.kind).toBe("failed");

		rerender({ onSave, enabled: false });

		expect(entry()).toBeUndefined();
		expect(useSaveStore.getState().status).toBe("idle");
	});

	// Mutation check (confirmed): without `attemptAutoSave`'s `hasChangesRef`
	// guard the failure arms a retry for the reverted edit, and onSave runs again.
	it("lets a save in flight report, then withdraws the failure it reports", async () => {
		let fail: (error: Error) => void = () => {};
		const onSave = vi.fn(
			() =>
				new Promise<void>((_resolve, reject) => {
					fail = reject;
				})
		);
		const { rerender } = mountManager({ onSave });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		rerender({ onSave, hasChanges: false });
		expect(entry()?.kind).toBe("saving");

		await act(async () => {
			fail(new Error("engine unreachable"));
		});
		expect(entry()).toBeUndefined();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(TIMING.SAVE_RETRY_MAX_DELAY_MS);
		});
		expect(onSave).toHaveBeenCalledTimes(1);
	});
});

describe("the edit a goodbye flush carried off", () => {
	// Keyed on the pane's current entity: the previous request's failed flush is
	// still unsaved, held by the retry context, and must stay "Not saved".
	it("keeps the previous request's failure through the next one's clean state", async () => {
		const onSave = vi.fn(offline);
		const { rerender } = mountManager({ onSave });

		await act(async () => {
			rerender({ entityId: "req_2", onSave, hasChanges: false });
			await vi.advanceTimersByTimeAsync(0);
		});

		expect(entry("request-req_1")?.kind).toBe("failed");
		expect(useSaveStore.getState().contexts.has("request-req_1")).toBe(true);
		expect(useSaveStore.getState().status).toBe("error");
	});
});
