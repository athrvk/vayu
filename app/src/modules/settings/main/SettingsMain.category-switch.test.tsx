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
 * Picking another settings category used to throw away whatever was typed.
 *
 * The reset was a bare `setEditedValues({})` keyed on `selectedCategory`: no
 * save, no prompt, and nothing on screen afterwards to say an edit had ever
 * existed. Unmounting the panel - navigating away from Settings - ran the same
 * path. Engine settings are merge-patches, so leaving a category now writes its
 * edits rather than dropping them.
 *
 * The last cases cover what the flush leaves on the Dock, against the real save
 * store: a clean branch that published `idle` on mount used to clear an `error`
 * some other context had just published (#3350 moved the panel to reports under
 * its own id).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { resetSaveStoreForTests, useSaveStore } from "@/stores/save-store";
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
	{
		key: "request_timeout",
		label: "Request timeout",
		description: "Seconds before a request is abandoned",
		type: "integer" as const,
		value: "30",
		default: "30",
		category: "network_performance",
		min: "1",
		max: "600",
		updatedAt: 0,
	},
	{
		key: "worker_threads",
		label: "Worker threads",
		description: "Engine worker pool size",
		type: "integer" as const,
		value: "4",
		default: "4",
		category: "general_engine",
		min: "1",
		max: "64",
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

/** Driven by the test - the store the sidebar would write on a click. */
let selectedCategory = "network_performance";

// The registry card the Network category mounts above its entries (issue
// #707) reads the engine over its own queries, which is not what this file is
// about - stubbed on the `CookiesCard` precedent in the save-model test.
vi.mock("./panels/ClientCertificatesCard", () => ({ ClientCertificatesCard: () => null }));

vi.mock("@/modules/settings/settings-store", () => ({
	useSettingsStore: (selector: (s: Record<string, unknown>) => unknown) =>
		selector({ selectedCategory, restartRequiredKeys: [] }),
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

// `@/stores/save-store` is the real one: what the flush reports is asserted.

/** Only the engine-restart button reaches the real client; the rest is mocked. */
function Panel() {
	return (
		<QueryClientProvider client={new QueryClient()}>
			<SettingsMain />
		</QueryClientProvider>
	);
}

describe("SettingsMain - leaving a category", () => {
	beforeEach(() => {
		mutateAsync.mockClear();
		showToast.mockClear();
		resetSaveStoreForTests();
		selectedCategory = "network_performance";
	});

	it("saves the edits instead of dropping them", async () => {
		const { rerender } = render(<Panel />);

		fireEvent.change(screen.getByLabelText("Max connections"), { target: { value: "42" } });

		selectedCategory = "general_engine";
		await act(async () => {
			rerender(<Panel />);
		});

		expect(mutateAsync).toHaveBeenCalledTimes(1);
		expect(mutateAsync.mock.calls[0][0]).toEqual({ entries: { max_connections: "42" } });
	});

	it("saves them on unmount too - navigating away is the same loss", async () => {
		const { unmount } = render(<Panel />);

		fireEvent.change(screen.getByLabelText("Max connections"), { target: { value: "7" } });

		await act(async () => {
			unmount();
		});

		expect(mutateAsync).toHaveBeenCalledTimes(1);
		expect(mutateAsync.mock.calls[0][0]).toEqual({ entries: { max_connections: "7" } });
	});

	it("does not write an out-of-range value", async () => {
		// `handleSave` refuses an invalid batch and the Save button is disabled
		// while one exists; the flush must not be the way around that.
		const { unmount } = render(<Panel />);

		fireEvent.change(screen.getByLabelText("Max connections"), { target: { value: "9999" } });

		await act(async () => {
			unmount();
		});

		expect(mutateAsync).not.toHaveBeenCalled();
	});

	it("says an invalid edit was dropped rather than dropping it silently", async () => {
		/*
		 * The discard itself is right - a flush has no screen left to show an
		 * inline error on - but it happened with nothing on screen to say so, so
		 * a typed value simply vanished. The count is part of the message: with
		 * several staged edits, "1 invalid change" tells you the rest were kept.
		 */
		const { unmount } = render(<Panel />);

		fireEvent.change(screen.getByLabelText("Max connections"), { target: { value: "9999" } });

		await act(async () => {
			unmount();
		});

		expect(showToast).toHaveBeenCalledWith("1 invalid change was discarded.", "warning");
	});

	it("stays quiet when everything staged was valid", async () => {
		const { unmount } = render(<Panel />);

		fireEvent.change(screen.getByLabelText("Max connections"), { target: { value: "42" } });

		await act(async () => {
			unmount();
		});

		expect(showToast).not.toHaveBeenCalled();
	});

	it("leaves another context's failure alone while it has nothing pending", async () => {
		// Mounting a clean Settings panel used to publish `idle`, wiping whatever
		// another context had put there - most damagingly an `error`.
		useSaveStore.getState().reportFailed("globals-editor", "Couldn't save - busy");
		const { unmount } = render(<Panel />);
		await act(async () => {
			unmount();
		});

		expect(useSaveStore.getState().status).toBe("error");
	});

	/*
	 * The cleanup starts the write before the effect that sees the category's
	 * edits gone. Mutation check: let that effect discard a report that is
	 * `saving` and this reds - the Dock drops "Saving…" for a write still out.
	 */
	it("keeps the outgoing category's write on the Dock while it is in flight", async () => {
		let land!: () => void;
		mutateAsync.mockImplementationOnce(
			() => new Promise((resolve) => (land = () => resolve({})))
		);
		const { rerender } = render(<Panel />);
		fireEvent.change(screen.getByLabelText("Max connections"), { target: { value: "42" } });

		selectedCategory = "general_engine";
		await act(async () => {
			rerender(<Panel />);
		});
		expect(useSaveStore.getState().status).toBe("saving");

		await act(async () => land());
		expect(useSaveStore.getState().status).toBe("saved");
	});

	it("leaves nothing unsaved on the Dock once an invalid edit is dropped on unmount", async () => {
		const { unmount } = render(<Panel />);
		fireEvent.change(screen.getByLabelText("Max connections"), { target: { value: "9999" } });
		expect(useSaveStore.getState().status).toBe("pending");

		await act(async () => {
			unmount();
		});

		expect(useSaveStore.getState().status).toBe("idle");
	});

	/*
	 * Mutation check: stop the cleanup emptying `editedValuesRef` and this reds -
	 * the unmounted panel's dropped edit reads as one staged after the write.
	 */
	it("reports the unmount flush saved when the only edit it left behind was dropped", async () => {
		const { unmount } = render(<Panel />);
		fireEvent.change(screen.getByLabelText("Max connections"), { target: { value: "42" } });
		fireEvent.change(screen.getByLabelText("Request timeout"), { target: { value: "9999" } });

		await act(async () => {
			unmount();
		});

		expect(mutateAsync.mock.calls[0][0]).toEqual({ entries: { max_connections: "42" } });
		expect(useSaveStore.getState().status).toBe("saved");
	});
});
