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
 * Issue #1610: a `dependsOn` entry ("Correlation Id Header") means nothing
 * until the boolean sibling it names ("Send a Correlation Id") is on, but the
 * category screen sorted both by label and put unrelated entries between
 * them. `SettingsMain` now nests a dependent immediately under its parent -
 * out of alphabetical order for the pair, in order for everything else - and
 * disables its control with a hint until the parent reads true.
 *
 * Fixture deliberately mislabels the pair against alphabetical order (the
 * dependent's label sorts before its parent's) so a passing "renders in
 * nested order" case proves the nesting pass ran, not that the label sort
 * happened to agree with it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SettingsMain from "./SettingsMain";
import type { ConfigEntry } from "@/types";

const base = {
	category: "data_retention",
	requiresRestart: false,
	advanced: false,
	keywords: [],
	updatedAt: 0,
};

const parentSwitch: ConfigEntry = {
	...base,
	key: "switchKey",
	type: "boolean",
	label: "Zeta Switch",
	description: "The parent boolean.",
	value: "false",
	default: "false",
};
// Label sorts first alphabetically, but it must render last: it is nested
// under its parent, not placed by its own label.
const dependentHeader: ConfigEntry = {
	...base,
	key: "dependentKey",
	type: "string",
	label: "Alpha Header",
	description: "Means nothing until Zeta Switch is on.",
	value: "X-Custom",
	default: "X-Default",
	dependsOn: "switchKey",
};
const unrelated: ConfigEntry = {
	...base,
	key: "cKey",
	type: "string",
	label: "Middle Setting",
	description: "Not part of the pair.",
	value: "hello",
	default: "hello",
};

let configEntries: ConfigEntry[] = [parentSwitch, dependentHeader, unrelated];

vi.mock("@/queries", () => ({
	useConfigQuery: () => ({ data: { entries: configEntries }, isLoading: false, error: null }),
	useUpdateConfigMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/modules/settings/settings-store", () => ({
	useSettingsStore: () => ({ selectedCategory: "data_retention" }),
}));

vi.mock("@/stores", () => ({
	useEngineStore: () => ({
		engineStatus: "connected",
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

const cardFor = (entry: ConfigEntry) =>
	document.querySelector(`[data-setting-anchor="${entry.key}"]`);
const inputFor = (entry: ConfigEntry) => screen.queryByRole("textbox", { name: entry.label });
const switchFor = (entry: ConfigEntry) => screen.getByRole("switch", { name: entry.label });

beforeEach(() => {
	cleanup();
	configEntries = [parentSwitch, dependentHeader, unrelated];
});

describe("a dependent entry (#1610)", () => {
	it("renders nested immediately after its parent, out of its own alphabetical order", () => {
		renderSettings();
		const anchors = Array.from(document.querySelectorAll("[data-setting-anchor]")).map((el) =>
			el.getAttribute("data-setting-anchor")
		);
		// The unrelated entry and the parent keep the label sort ("Middle
		// Setting" before "Zeta Switch"); the dependent, despite "Alpha Header"
		// sorting first of all three, comes right after its parent instead.
		expect(anchors).toEqual(["cKey", "switchKey", "dependentKey"]);
	});

	it("indents the dependent's card and leaves the others unindented", () => {
		renderSettings();
		expect(cardFor(dependentHeader)?.className).toContain("ml-6");
		expect(cardFor(parentSwitch)?.className).not.toContain("ml-6");
		expect(cardFor(unrelated)?.className).not.toContain("ml-6");
	});

	it("disables the dependent's control and shows the hint while the parent is off", () => {
		renderSettings();
		expect(inputFor(dependentHeader)).toBeDisabled();
		expect(screen.getByText("Turn on Zeta Switch to use this")).toBeInTheDocument();
	});

	it("enables the dependent's control and drops the hint once the parent is switched on", () => {
		renderSettings();
		fireEvent.click(switchFor(parentSwitch));

		expect(inputFor(dependentHeader)).toBeEnabled();
		expect(screen.queryByText("Turn on Zeta Switch to use this")).not.toBeInTheDocument();
	});

	it("never disables or indents an entry with no dependsOn", () => {
		renderSettings();
		expect(inputFor(unrelated)).toBeEnabled();
	});
});
