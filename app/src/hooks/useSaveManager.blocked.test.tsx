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
 * `SaveBlockedError` (issue #1635) is how a caller says "I already know this
 * payload will 400 - do not send it, and do not retry it". These cases pin
 * the distinction from a genuine failure: no `"error"` status, no console
 * noise, and critically no backoff retry, since the payload that failed is
 * exactly the payload the next attempt would still carry.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import { useClientSettingsStore } from "@/stores";
import { useSaveStore } from "@/stores/save-store";
import { SaveBlockedError } from "@/lib/elements";
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

describe("a save an onSave callback blocks", () => {
	it("reports pending, not error", async () => {
		const onSave = vi.fn().mockRejectedValue(new SaveBlockedError());
		mountManager({ entityId: "req_1", onSave });

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(onSave).toHaveBeenCalledTimes(1);
		expect(useSaveStore.getState().status).toBe("pending");
		expect(useSaveStore.getState().lastErrorMessage).toBeNull();
	});

	it("does not schedule a retry, unlike a genuine failure", async () => {
		const onSave = vi.fn().mockRejectedValue(new SaveBlockedError());
		mountManager({ entityId: "req_1", onSave });

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(onSave).toHaveBeenCalledTimes(1);

		// A genuine failure would retry at this same delay (attempt 0). Nothing
		// here should call onSave again without a new edit.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(onSave).toHaveBeenCalledTimes(1);
	});

	it("does not log a console error for a blocked save", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const onSave = vi.fn().mockRejectedValue(new SaveBlockedError());
		mountManager({ entityId: "req_1", onSave });

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(consoleError).not.toHaveBeenCalled();
	});

	it("tries again once a new edit bumps the change token, same as any pending save", async () => {
		const onSave = vi.fn().mockRejectedValueOnce(new SaveBlockedError());
		onSave.mockResolvedValueOnce(undefined);
		const { rerender } = renderHook(
			({ token }: { token: number }) =>
				useSaveManager({
					entityId: "req_1",
					contextName: "Request",
					onSave,
					hasChanges: true,
					changeToken: token,
				}),
			{ initialProps: { token: 1 }, wrapper }
		);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(onSave).toHaveBeenCalledTimes(1);

		// The field that was blocking the save just got filled in - a real edit,
		// which is what re-arms the debounce (not a timer of its own).
		await act(async () => {
			rerender({ token: 2 });
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(onSave).toHaveBeenCalledTimes(2);
		expect(useSaveStore.getState().status).toBe("saved");
	});
});
