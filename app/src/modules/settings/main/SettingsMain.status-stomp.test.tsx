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
 * What a settings write leaves on the Dock, against the real save store.
 *
 * The panel reports under its own id (`settings`), so its success cannot take
 * another surface's failure down with it, and its own report says "Not saved"
 * only while the edit that failed is still staged (#3350). Most cases drive the
 * category-switch flush, which is the same `saveEntries` call as the Save button
 * and needs no click target - see `SettingsMain.category-switch.test.tsx`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TIMING } from "@/config/timing";
import { resetSaveStoreForTests, useSaveStore } from "@/stores/save-store";
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

const mutateAsync = vi.fn((_payload: { entries: Record<string, string> }): Promise<unknown> =>
	Promise.resolve({})
);

vi.mock("@/queries", () => ({
	useConfigQuery: () => ({ data: { entries }, isLoading: false, error: null }),
	useUpdateConfigMutation: () => ({ mutateAsync, isPending: false }),
}));

// The registry card the Network category mounts above its entries (issue
// #707) reads the engine over its own queries, which is not what this file is
// about - stubbed on the `CookiesCard` precedent in the save-model test.
vi.mock("./panels/ClientCertificatesCard", () => ({ ClientCertificatesCard: () => null }));

vi.mock("@/modules/settings/settings-store", () => ({
	useSettingsStore: (selector: (s: Record<string, unknown>) => unknown) =>
		selector({ selectedCategory: "network_performance", restartRequiredKeys: [] }),
}));

const showToast = vi.fn();
vi.mock("@/stores", () => ({
	useEngineStore: (selector: (s: Record<string, unknown>) => unknown) =>
		selector({
			engineStatus: "connected",
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

const store = () => useSaveStore.getState();
const maxConnections = () => screen.getByLabelText("Max connections");

/** Another surface's failure, already on the Dock. */
function anotherSurfaceFailed() {
	act(() => store().reportFailed("globals-editor", "Couldn't save - busy"));
}

describe("the status a settings write leaves", () => {
	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		mutateAsync.mockClear();
		resetSaveStoreForTests();
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

		expect(store().status).toBe("idle");
	});

	it("leaves a failure that arrived meanwhile on screen", async () => {
		await saveOnce();

		anotherSurfaceFailed();
		await act(async () => {
			vi.advanceTimersByTime(TIMING.SAVED_STATUS_DURATION_MS);
		});

		expect(store().status).toBe("error");
	});

	/*
	 * Effect 4 of #3350: the panel's clean branch used to publish `idle`, which
	 * wiped whatever another surface had on the Dock. Mutation check: point the
	 * clean branch's `discard` at "globals-editor" and this reds.
	 */
	it("does not clear another surface's failure when it mounts clean or an edit is reverted", () => {
		anotherSurfaceFailed();
		render(<Panel />);
		expect(store().status).toBe("error");

		fireEvent.change(maxConnections(), { target: { value: "42" } });
		fireEvent.click(screen.getByRole("button", { name: "Revert" }));

		expect(store().status).toBe("error");
		expect(store().lastErrorMessage).toBe("Couldn't save - busy");
	});

	/*
	 * Mutation check: drop the clean branch's `discard` and the last assertion
	 * reds - "Not saved" outlives the edit it described.
	 */
	it("says Not saved while the failed edit is staged, and stops once it is reverted", async () => {
		mutateAsync.mockRejectedValueOnce(new Error("busy"));
		render(<Panel />);
		fireEvent.change(maxConnections(), { target: { value: "42" } });
		await act(async () => {
			await store().flushAll();
		});
		expect(store().status).toBe("error");
		expect(useToastStore.getState().toasts).toHaveLength(1);

		fireEvent.click(screen.getByRole("button", { name: "Revert" }));

		expect(store().status).toBe("idle");
	});

	/*
	 * Mutation check: report saved unconditionally after the write and this
	 * reds - the Dock says "Saved" over the edit typed while it was in flight.
	 */
	it("says Unsaved changes for an edit typed while its write was in flight", async () => {
		let land!: () => void;
		mutateAsync.mockImplementationOnce(
			() => new Promise((resolve) => (land = () => resolve({})))
		);
		render(<Panel />);
		fireEvent.change(maxConnections(), { target: { value: "42" } });
		let flushed!: Promise<unknown>;
		act(() => {
			flushed = store().flushAll();
		});
		expect(store().status).toBe("saving");

		fireEvent.change(maxConnections(), { target: { value: "43" } });
		await act(async () => {
			land();
			await flushed;
		});

		expect(store().status).toBe("pending");
	});

	/*
	 * Ctrl/Cmd+S on an invalid edit: `handleSave` declined and resolved, and the
	 * store read the silence as a success - "Saved", and the entry gone, with the
	 * invalid value still on screen. Mutation check (confirmed): resolve nothing
	 * for an invalid batch again and this reds on "saved".
	 */
	it("keeps Unsaved changes when Ctrl+S meets an invalid staged edit", async () => {
		render(<Panel />);
		fireEvent.change(maxConnections(), { target: { value: "9999" } });
		expect(store().status).toBe("pending");

		await act(async () => {
			await store().triggerSave();
		});

		expect(mutateAsync).not.toHaveBeenCalled();
		expect(store().status).toBe("pending");
		expect(store().unsaved.get("settings")?.kind).toBe("pending");
	});
});
