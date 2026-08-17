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
 * The engine `enum` card renders `SelectSettingRow`, not a fourth copy of it
 * (issue #747).
 *
 * `SettingsMain.enum.test.tsx` drives the same card through the `combobox`
 * role, which a hand-rolled `Select` satisfies just as well - so it cannot tell
 * the primitive from a copy of it, and a copy is what stops receiving the
 * primitive's fixes. These two assertions are the ones that can: the row's own
 * box (written only by the primitives) and the label wiring that the
 * hand-rolled markup did not have.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SettingsMain from "./SettingsMain";
import type { ConfigEntry } from "@/types";

const enumEntry: ConfigEntry = {
	key: "defaultHttpVersion",
	label: "Default HTTP Version",
	description: "Protocol a newly created request starts with.",
	type: "enum",
	value: "auto",
	default: "auto",
	category: "general_engine",
	requiresRestart: false,
	advanced: false,
	keywords: [],
	updatedAt: 0,
	options: [
		{ value: "auto", label: "Auto" },
		{ value: "http1.1", label: "HTTP/1.x" },
		{ value: "http2", label: "HTTP/2" },
	],
};

vi.mock("@/queries", () => ({
	useConfigQuery: () => ({
		data: { entries: [enumEntry] },
		isLoading: false,
		error: null,
	}),
	useUpdateConfigMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/modules/settings/settings-store", () => ({
	useSettingsStore: () => ({ selectedCategory: "general_engine", restartRequiredKeys: [] }),
}));

vi.mock("@/stores", () => ({
	useEngineStore: () => ({
		isEngineConnected: true,
		pendingRestart: false,
		restartRequiredKeys: [],
		addRestartRequiredKey: vi.fn(),
		clearRestartRequired: vi.fn(),
	}),
	useToastStore: (selector: (s: { showToast: () => void }) => unknown) =>
		selector({ showToast: vi.fn() }),
}));

vi.mock("@/stores/save-store", () => ({
	// SettingsMain destructures nine members; a partial mock throws on the first
	// one it calls, which is easy to mistake for a defect in the component.
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
	// SettingsMain calls useQueryClient directly (for invalidation), so the
	// provider is required even with the query hooks mocked.
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<SettingsMain />
		</QueryClientProvider>
	);
}

beforeEach(() => vi.clearAllMocks());

describe("the engine enum card", () => {
	it("is the shared row, which names its own box", () => {
		const { container } = renderSettings();

		// `data-setting-row` is written by the primitive from the same string that
		// names the trigger. Hand-rolled markup carries none.
		const row = container.querySelector('[data-setting-row="Default HTTP Version"]');
		expect(row).not.toBeNull();
		expect(row?.querySelector('[role="combobox"]')).not.toBeNull();
	});

	it("says the setting's name once on screen and still names the control", () => {
		renderSettings();

		// The CardTitle is the visible name; the row's label is present for the
		// trigger's sake and hidden, so the card does not print it twice.
		const printed = screen
			.getAllByText("Default HTTP Version")
			.filter((el) => !el.className.includes("sr-only"));
		expect(printed).toHaveLength(1);
		expect(screen.getByRole("combobox", { name: "Default HTTP Version" })).toBeTruthy();
	});
});
