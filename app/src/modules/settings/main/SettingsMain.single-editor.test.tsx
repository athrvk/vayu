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
 * One knob, one editor (#586).
 *
 * `liveReplayWindowMs` rendered twice: here as "Live Chart Window" with a
 * staged edit and a Save bar, and in App > Dashboard as "Chart window" with
 * autosave option buttons. Same `/config` entry, two labels, two save models -
 * stage one, flip the other, and this row silently showed a value nobody saved
 * here. The engine list drops the entries an app panel row edits; everything
 * else in the category still renders, which is the half that keeps the filter
 * from being "hide the observability list".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SettingsMain from "./SettingsMain";
import { ENGINE_SETTINGS_EDITED_IN_APP } from "../engine-settings-edited-in-app";
import type { ConfigEntry } from "@/types";

const base = {
	category: "observability",
	requiresRestart: false,
	advanced: false,
	keywords: [],
	updatedAt: 0,
};

const chartWindow: ConfigEntry = {
	...base,
	key: "liveReplayWindowMs",
	label: "Live Chart Window",
	description: "How much recent live-metrics history to keep.",
	type: "integer",
	value: "60000",
	default: "60000",
	min: "0",
	max: "3600000",
};

const tickCeiling: ConfigEntry = {
	...base,
	key: "liveMaxRetainedTicks",
	label: "Live Metrics Tick Ceiling",
	description: "Hard ceiling on live-metrics data points held in memory per run.",
	type: "integer",
	value: "50000",
	default: "50000",
	min: "1000",
	max: "500000",
};

vi.mock("@/queries", () => ({
	useConfigQuery: () => ({
		data: { entries: [chartWindow, tickCeiling] },
		isLoading: false,
		error: null,
	}),
	useUpdateConfigMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/modules/settings/settings-store", () => ({
	useSettingsStore: (selector?: (s: unknown) => unknown) => {
		const state = {
			selectedCategory: "observability",
			highlightedKey: null,
			clearHighlight: vi.fn(),
		};
		return selector ? selector(state) : state;
	},
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

beforeEach(cleanup);

describe("an engine entry an app panel edits", () => {
	it("is not offered a second editor in the engine list", () => {
		renderSettings();

		expect(screen.queryByLabelText("Live Chart Window")).toBeNull();
	});

	it("still renders every other entry in that category", () => {
		// The filter is per entry, not per category: dropping the whole list
		// would pass the assertion above and lose four settings.
		renderSettings();

		expect(screen.getByLabelText("Live Metrics Tick Ceiling")).toBeInTheDocument();
	});

	it("names the app row that does edit it, so the filter cannot point nowhere", () => {
		// The map is what both the filter and the search index read; an anchor
		// nobody renders would drop the entry from the list and from search at
		// once, which is a deletion rather than a move.
		expect(ENGINE_SETTINGS_EDITED_IN_APP.liveReplayWindowMs).toEqual({
			panel: "dashboard",
			anchor: "chart-window",
		});
	});
});
