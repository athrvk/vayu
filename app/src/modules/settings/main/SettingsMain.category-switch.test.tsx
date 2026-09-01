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
 * The second test covers the status stomp that lived in the same file: a
 * `setStatus("idle")` fired on mount and on every clean render, so opening
 * Settings cleared an `error` some other context had just published to the Dock.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

const mutateAsync = vi.fn((_payload: { entries: Record<string, string> }) => Promise.resolve({}));

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
	useSettingsStore: () => ({ selectedCategory, restartRequiredKeys: [] }),
}));

const showToast = vi.fn();
vi.mock("@/stores", () => ({
	useEngineStore: () => ({
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

const setStatus = vi.fn();
vi.mock("@/stores/save-store", () => ({
	useSaveStore: () => ({
		startSaving: vi.fn(),
		completeSaveThenIdle: vi.fn(),
		failSave: vi.fn(),
		setStatus: (...args: unknown[]) => setStatus(...args),
		markPendingSave: vi.fn(),
		registerContext: vi.fn(),
		unregisterContext: vi.fn(),
		setActiveContext: vi.fn(),
		updateContext: vi.fn(),
	}),
}));

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
		setStatus.mockClear();
		showToast.mockClear();
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

	it("leaves the save status alone while it has nothing pending", async () => {
		// Mounting a clean Settings panel used to publish `idle`, wiping whatever
		// another context had put there - most damagingly an `error`.
		const { unmount } = render(<Panel />);
		await act(async () => {
			unmount();
		});

		expect(setStatus).not.toHaveBeenCalled();
	});
});
