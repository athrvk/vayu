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
 * Five engine entries are internals no user story reaches - a SQLite lock
 * pragma, an OAuth watchdog's backoff, a 250ms poll cadence - and they rendered
 * as first-class rows beside the settings people actually tune, interleaved by
 * key order. The engine now marks them `advanced` and they render collapsed at
 * the bottom of their category.
 *
 * Membership is the engine's call, not this component's: the assertions below
 * drive it off the flag on the payload, so a key added to or removed from the
 * group upstream needs no edit here (`config_route_test.cpp` pins which keys
 * carry it).
 *
 * Rendered rather than source-scanned - the grouping is a payload-driven
 * filter, which no scan of this file could see.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SettingsMain from "./SettingsMain";
import type { ConfigEntry } from "@/types";

const base = {
	type: "integer" as const,
	description: "",
	category: "database_performance",
	min: "1",
	max: "100000",
	requiresRestart: false,
	updatedAt: 0,
};

// Deliberately ordered so key-sort alone would interleave them: "aEveryday"
// sorts before "mInternal", which sorts before "zEveryday".
const everydayFirst: ConfigEntry = {
	...base,
	key: "aEverydayFirst",
	label: "Everyday First",
	value: "1",
	default: "1",
	advanced: false,
};
const internal: ConfigEntry = {
	...base,
	key: "mInternal",
	label: "Database Lock Wait Time",
	value: "10000",
	default: "10000",
	advanced: true,
};
const everydayLast: ConfigEntry = {
	...base,
	key: "zEverydayLast",
	label: "Everyday Last",
	value: "2",
	default: "2",
	advanced: false,
};

let configEntries: ConfigEntry[] = [everydayFirst, internal, everydayLast];

vi.mock("@/queries", () => ({
	useConfigQuery: () => ({ data: { entries: configEntries }, isLoading: false, error: null }),
	useUpdateConfigMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/modules/settings/settings-store", () => ({
	useSettingsStore: () => ({ selectedCategory: "database_performance" }),
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

const disclosure = () => screen.queryByRole("button", { name: /Advanced/i });
const controlFor = (entry: ConfigEntry) => screen.queryByRole("spinbutton", { name: entry.label });

beforeEach(() => {
	cleanup();
	configEntries = [everydayFirst, internal, everydayLast];
});

describe("the Advanced group", () => {
	it("keeps the flagged entries out of the list until asked for", () => {
		renderSettings();

		expect(controlFor(everydayFirst)).not.toBeNull();
		expect(controlFor(everydayLast)).not.toBeNull();
		// Not merely last - not rendered at all, which is what "collapsed" has
		// to mean for a screen reader too.
		expect(controlFor(internal)).toBeNull();
		expect(disclosure()?.getAttribute("aria-expanded")).toBe("false");
	});

	it("reveals exactly the flagged entries when expanded, and hides them again", () => {
		renderSettings();

		fireEvent.click(disclosure()!);
		expect(disclosure()?.getAttribute("aria-expanded")).toBe("true");
		expect(controlFor(internal)).not.toBeNull();
		// The everyday rows are not moved into the group by the expansion.
		expect(controlFor(everydayFirst)).not.toBeNull();

		fireEvent.click(disclosure()!);
		expect(controlFor(internal)).toBeNull();
	});

	it("counts what it is holding", () => {
		renderSettings();
		expect(disclosure()?.textContent).toContain("(1)");
	});

	it("is absent entirely from a category with no internals", () => {
		configEntries = [everydayFirst, everydayLast];
		renderSettings();

		expect(disclosure()).toBeNull();
		expect(controlFor(everydayFirst)).not.toBeNull();
	});
});
