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
 * A settings write's "Saved" must not take an unrelated failure down with it.
 *
 * `saveEntries` reported success as `completeSave()` plus its own
 * `setTimeout(() => setStatus("idle"))` - the same unguarded timer the panel's
 * *other* status bug was about, where an unconditional `setStatus("idle")` on
 * every clean render wiped an error just by opening Settings. The pending
 * tracking (`markedPendingRef`) fixed that one; this is the success path, and it
 * goes through `completeSaveThenIdle` now.
 *
 * The panel is driven through the category-switch flush rather than the Save
 * button because it is the same `saveEntries` call and needs no mocked click
 * target - see `SettingsMain.category-switch.test.tsx`, whose harness this is.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TIMING } from "@/config/timing";
import { useSaveStore } from "@/stores/save-store";
import { useToastStore } from "@/stores/toast-store";
import SettingsMain from "./SettingsMain";

const entries = [
	{
		key: "max_connections",
		label: "Max connections",
		description: "Upper bound on concurrent connections",
		type: "integer" as const,
		value: "10",
		default: "10",
		category: "network_performance",
		min: "1",
		max: "100",
		updatedAt: 0,
	},
];

const mutateAsync = vi.fn((_payload: { entries: Record<string, string> }) => Promise.resolve({}));

vi.mock("@/queries", () => ({
	useConfigQuery: () => ({ data: { entries }, isLoading: false, error: null }),
	useUpdateConfigMutation: () => ({ mutateAsync, isPending: false }),
}));

// The registry card the Network category mounts above its entries (issue
// #707) reads the engine over its own queries, which is not what this file is
// about - stubbed on the `CookiesCard` precedent in the save-model test.
vi.mock("./panels/ClientCertificatesCard", () => ({ ClientCertificatesCard: () => null }));

vi.mock("@/modules/settings/settings-store", () => ({
	useSettingsStore: () => ({ selectedCategory: "network_performance", restartRequiredKeys: [] }),
}));

const showToast = vi.fn();
vi.mock("@/stores", () => ({
	useEngineStore: () => ({
		isEngineConnected: true,
		pendingRestart: false,
		restartRequiredKeys: [],
		addRestartRequiredKey: vi.fn(),
		clearRestartRequired: vi.fn(),
	}),
	// The panel toasts the edits a category-switch flush had to drop.
	useToastStore: (selector: (s: { showToast: typeof showToast }) => unknown) =>
		selector({ showToast }),
}));

// `@/stores/save-store` is deliberately not mocked: the status this panel
// publishes is the whole subject, and the panel imports it from there directly.

function Panel() {
	return (
		<QueryClientProvider client={new QueryClient()}>
			<SettingsMain />
		</QueryClientProvider>
	);
}

/** Edit a value, then unmount - the cleanup flushes it through `saveEntries`. */
async function saveOnce() {
	const { unmount } = render(<Panel />);
	fireEvent.change(screen.getByLabelText("Max connections"), { target: { value: "42" } });
	await act(async () => {
		unmount();
	});
	expect(mutateAsync).toHaveBeenCalledTimes(1);
	expect(useSaveStore.getState().status).toBe("saved");
}

describe("the status timer a settings write arms", () => {
	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		mutateAsync.mockClear();
		useSaveStore.setState({ status: "idle", contexts: new Map(), activeContextId: null });
		useToastStore.setState({ toasts: [] });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns the Dock to idle when nothing else has happened", async () => {
		await saveOnce();

		await act(async () => {
			vi.advanceTimersByTime(TIMING.SAVED_STATUS_DURATION_MS);
		});

		expect(useSaveStore.getState().status).toBe("idle");
	});

	it("leaves a failure that arrived meanwhile on screen", async () => {
		await saveOnce();

		act(() => useSaveStore.getState().failSave("delete failed"));
		await act(async () => {
			vi.advanceTimersByTime(TIMING.SAVED_STATUS_DURATION_MS);
		});

		expect(useSaveStore.getState().status).toBe("error");
	});
});
