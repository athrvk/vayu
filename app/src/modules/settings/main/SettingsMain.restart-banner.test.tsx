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
 * Saving a restart-required setting must still raise the banner.
 *
 * The engine store lost two actions that had no callers, `setPendingRestart`
 * and `reset`. Neither was on this path - the banner is raised by
 * `addRestartRequiredKey` (which latches `pendingRestart` itself) and lowered by
 * `clearRestartRequired` - but nothing proved that, because every existing
 * SettingsMain test mocks `@/stores` wholesale and hands the component a frozen
 * `pendingRestart: false`. So the state machine behind the banner had no test at
 * all, and a deletion one action over would have been caught by nobody.
 *
 * This one uses the **real** store and drives the real save path: change a
 * setting whose label marks it restart-required, save, and the banner appears
 * naming it. Dismiss puts it away.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SettingsMain from "./SettingsMain";
import { useEngineStore } from "@/stores";

const restartEntry = {
	key: "worker_threads",
	label: "Worker threads",
	description: "Threads the engine starts with",
	type: "integer" as const,
	value: "4",
	default: "4",
	category: "general_engine",
	min: "1",
	max: "64",
	// The engine's typed signal, not a parenthetical in the label. Saving an
	// entry without it must raise nothing - covered below.
	requiresRestart: true,
	advanced: false,
	keywords: [],
	updatedAt: 0,
};

/**
 * The mutation-check twin: the old label parser would have called this
 * restart-required, the typed flag does not. Rendered in its own case below.
 */
const labelSaysSoButTheFlagDoesNot = {
	...restartEntry,
	label: "Worker threads (Requires Restart)",
	requiresRestart: false,
};

let configEntries: (typeof restartEntry)[] = [restartEntry];
const mutateAsync = vi.fn().mockResolvedValue(undefined);

vi.mock("@/queries", () => ({
	useConfigQuery: () => ({
		data: { entries: configEntries },
		isLoading: false,
		error: null,
	}),
	useUpdateConfigMutation: () => ({ mutateAsync, isPending: false }),
}));

vi.mock("@/modules/settings/settings-store", () => ({
	useSettingsStore: () => ({ selectedCategory: "general_engine", restartRequiredKeys: [] }),
}));

// `@/stores` is deliberately NOT mocked - the real engine store is the thing
// under test. Only the save registry is stubbed, as the sibling tests do.
vi.mock("@/stores/save-store", () => ({
	useSaveStore: () => ({
		startSaving: vi.fn(),
		completeSaveThenIdle: vi.fn(),
		failSave: vi.fn(),
		setStatus: vi.fn(),
		markPendingSave: vi.fn(),
		registerContext: vi.fn(),
		unregisterContext: vi.fn(),
		setActiveContext: vi.fn(),
		updateContext: vi.fn(),
	}),
}));

function renderSettings() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<SettingsMain />
		</QueryClientProvider>
	);
}

const banner = () => screen.queryByText("Engine restart required");

beforeEach(() => {
	cleanup();
	vi.clearAllMocks();
	configEntries = [restartEntry];
	useEngineStore.setState({ pendingRestart: false, restartRequiredKeys: [] });
});

describe("the restart-required banner", () => {
	it("stays away until a restart-required setting is saved", () => {
		renderSettings();
		expect(banner()).toBeNull();
	});

	it("appears after saving one, naming the setting", async () => {
		renderSettings();

		fireEvent.change(screen.getByRole("spinbutton", { name: /Worker threads/i }), {
			target: { value: "8" },
		});
		fireEvent.click(screen.getByRole("button", { name: /Save/i }));

		await waitFor(() => expect(banner()).not.toBeNull());
		expect(mutateAsync).toHaveBeenCalledWith({ entries: { worker_threads: "8" } });
		// Read out of the banner's own line, not the page: the field's label
		// carries the same words and would match anywhere.
		const detail = screen.getByText(/will take effect after restarting the engine/);
		expect(detail.textContent).toContain("Changes to Worker threads");
		// The store is what holds it, and the component reads it from there.
		expect(useEngineStore.getState().pendingRestart).toBe(true);
		expect(useEngineStore.getState().restartRequiredKeys).toEqual(["worker_threads"]);
	});

	it("goes away on Dismiss", async () => {
		renderSettings();
		fireEvent.change(screen.getByRole("spinbutton", { name: /Worker threads/i }), {
			target: { value: "8" },
		});
		fireEvent.click(screen.getByRole("button", { name: /Save/i }));
		await waitFor(() => expect(banner()).not.toBeNull());

		fireEvent.click(screen.getByRole("button", { name: /Dismiss/i }));

		await waitFor(() => expect(banner()).toBeNull());
		expect(useEngineStore.getState().pendingRestart).toBe(false);
		expect(useEngineStore.getState().restartRequiredKeys).toEqual([]);
	});

	it("does not list the same key twice when it is saved again", () => {
		// `addRestartRequiredKey` dedupes; the banner would otherwise read
		// "Changes to Worker threads, Worker threads".
		const { addRestartRequiredKey } = useEngineStore.getState();
		addRestartRequiredKey("worker_threads");
		addRestartRequiredKey("worker_threads");

		renderSettings();

		expect(banner()).not.toBeNull();
		expect(useEngineStore.getState().restartRequiredKeys).toEqual(["worker_threads"]);
	});

	it("is raised by the typed flag, not by the words in the label", async () => {
		// The exact mutation this guards: put the substring parser back and this
		// entry - whose label still reads "(Requires Restart)" while the engine
		// says it does not - raises a banner that lies.
		configEntries = [labelSaysSoButTheFlagDoesNot];
		renderSettings();

		fireEvent.change(screen.getByRole("spinbutton", { name: /Worker threads/i }), {
			target: { value: "8" },
		});
		fireEvent.click(screen.getByRole("button", { name: /Save/i }));

		await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
		expect(banner()).toBeNull();
		expect(useEngineStore.getState().pendingRestart).toBe(false);
	});

	it("shows the Restart Required chip on the entry from the flag alone", () => {
		renderSettings();
		expect(screen.getByText("Restart Required")).not.toBeNull();

		cleanup();
		configEntries = [labelSaysSoButTheFlagDoesNot];
		renderSettings();
		expect(screen.queryByText("Restart Required")).toBeNull();
	});
});
