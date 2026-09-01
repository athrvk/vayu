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
 * An engine card used to print "Default: 10" and, separately, a button called
 * Reset that did not go to the default - it discarded the staged edit. Two
 * different things wearing one name, with the actual way back to the default
 * missing. They are now Revert (drop what I typed) and Reset (go to the
 * default), and the second exists for every entry type, not just the numeric
 * ones.
 *
 * The search reveal is here too, because it is the other thing a card has to do
 * on arrival: a result that selects the right category and then leaves you to
 * find the row among forty-five is barely a result.
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

const numeric: ConfigEntry = {
	...base,
	key: "dbBusyTimeout",
	label: "Busy Timeout",
	description: "How long a write waits for the lock before it fails.",
	type: "integer",
	value: "4000",
	default: "2000",
	min: "1",
	max: "100000",
};

const toggle: ConfigEntry = {
	...base,
	key: "dbWalMode",
	label: "WAL Mode",
	description: "Write-ahead logging.",
	type: "boolean",
	value: "false",
	default: "true",
};

const internal: ConfigEntry = {
	...base,
	key: "dbLockWaitMs",
	label: "Lock Wait",
	description: "How long a writer waits.",
	type: "integer",
	value: "10",
	default: "10",
	min: "1",
	max: "100",
	advanced: true,
};

let highlightedKey: string | null = null;
const clearHighlight = vi.fn();

vi.mock("@/queries", () => ({
	useConfigQuery: () => ({
		data: { entries: [numeric, toggle, internal] },
		isLoading: false,
		error: null,
	}),
	useUpdateConfigMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// Selector-aware: `useRevealedSetting` subscribes with one, the view reads the
// whole state. A mock that ignored the selector would hand the hook the state
// object where it expects a key.
vi.mock("@/modules/settings/settings-store", () => ({
	useSettingsStore: (selector?: (s: unknown) => unknown) => {
		const state = {
			selectedCategory: "data_retention",
			highlightedKey,
			clearHighlight,
		};
		return selector ? selector(state) : state;
	},
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

const timeoutField = () => screen.getByLabelText("Busy Timeout") as HTMLInputElement;

beforeEach(() => {
	cleanup();
	highlightedKey = null;
	clearHighlight.mockClear();
});

describe("an engine entry's two ways back", () => {
	it("shows the default and resets to it - for a numeric entry", () => {
		renderSettings();

		// 4000 saved against a default of 2000: the line is what says so.
		expect(screen.getByText("Default: 2000")).toBeInTheDocument();
		fireEvent.click(screen.getAllByRole("button", { name: "Reset" })[0]);
		expect(timeoutField().value).toBe("2000");
	});

	it("shows the default and resets to it - for a boolean entry too", () => {
		// The Default line used to render only under the numeric branch, so a
		// toggle sitting off its default said nothing and offered nothing.
		renderSettings();

		const walRow = screen.getByText("Default: true").closest("div");
		const reset = walRow?.querySelector("button");
		fireEvent.click(reset as HTMLButtonElement);

		expect(screen.getByRole("switch", { name: "WAL Mode" })).toHaveAttribute(
			"aria-checked",
			"true"
		);
	});

	it("Revert drops the staged edit and goes back to the saved value, not the default", () => {
		renderSettings();

		fireEvent.change(timeoutField(), { target: { value: "9000" } });
		fireEvent.click(screen.getByRole("button", { name: "Revert" }));

		// The saved value, which is not the default - the distinction the old
		// single "Reset" could not express.
		expect(timeoutField().value).toBe("4000");
	});

	it("offers Revert only while something is staged", () => {
		renderSettings();
		expect(screen.queryByRole("button", { name: "Revert" })).toBeNull();

		fireEvent.change(timeoutField(), { target: { value: "9000" } });
		expect(screen.getByRole("button", { name: "Revert" })).toBeInTheDocument();
	});
});

describe("revealing the entry a search result asked for", () => {
	it("opens the Advanced group when the wanted entry is inside it", () => {
		// Advanced is collapsed by design, so a result pointing into it would
		// otherwise land on a screen that does not contain the row.
		highlightedKey = "dbLockWaitMs";
		renderSettings();

		expect(screen.getByLabelText("Lock Wait")).toBeInTheDocument();
	});

	it("leaves Advanced collapsed when the wanted entry is not in it", () => {
		highlightedKey = "dbBusyTimeout";
		renderSettings();

		expect(screen.queryByLabelText("Lock Wait")).toBeNull();
	});

	it("clears the request once it has been acted on, so it fires once", () => {
		vi.useFakeTimers();
		try {
			highlightedKey = "dbBusyTimeout";
			renderSettings();
			vi.runAllTimers();
			expect(clearHighlight).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
