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
 * Phase 3's three sources: settings entries, variables, and runs.
 *
 * Through the palette rather than through each hook, because what they promise
 * is a *landing*: a settings hit selects a category and leaves an anchor for
 * `useRevealedSetting`, a variable hit scopes the Variables tab, a run hit opens
 * that run's tab. A hook test could assert the items and still let the wiring
 * rot, which is this codebase's most repeated defect.
 *
 * Three of these are guards against a specific way of failing:
 *
 * - **The secrets invariant's visible half.** A variable's value never reaches
 *   the screen. Its searchable half belongs to `useVariableItems.test.ts` - see
 *   the note on that test for why the DOM cannot hold it.
 * - **The cap and its escape.** A corpus larger than the group hands off to the
 *   surface that browses it, and does so *pre-filtered* - the assertions read
 *   the destination's own store, not the palette's.
 * - **Idle typing never errors.** An engine that is down hides the Runs group;
 *   drop the `isError` branch and the group renders rows from `undefined`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { CommandPalette } from "./CommandPalette";
import { useLayoutStore, useTabsStore } from "@/stores";
import { useSettingsStore } from "@/modules/settings/settings-store";
import { useVariablesStore } from "@/modules/variables/variables-store";
import { useHistoryStore } from "@/modules/history/history-store";
import { DEEP_GROUP_LIMIT } from "./types";
import type { Run, RunListResponse } from "@/types";

const COLLECTIONS: {
	id: string;
	name: string;
	parentId?: string;
	variables?: Record<string, { value: string; secret?: boolean }>;
}[] = [
	{
		id: "c1",
		name: "Payments",
		variables: { chargeBaseUrl: { value: "https://pay.example" } },
	},
];

const ENVIRONMENTS: {
	id: string;
	name: string;
	variables: Record<string, { value: string; secret?: boolean }>;
}[] = [
	{
		id: "e1",
		name: "Production",
		// The value below must never reach the palette - see the secrets test.
		variables: { apiToken: { value: "s3cr3t-bearer-value", secret: true } },
	},
];

const GLOBALS = { id: "globals", variables: { retryBudget: { value: "3" } } };

/** Engine `/config` entries, controllable per test. */
let engineEntries: {
	key: string;
	label: string;
	description: string;
	category: string;
	keywords: readonly string[];
}[] = [];

/** What the palette's run search resolves to, and whether it failed. */
let runSearch: { data: RunListResponse | undefined; isError: boolean } = {
	data: undefined,
	isError: false,
};

/** Every query string `useRunSearchQuery` was called with, in order. */
const runSearchCalls: string[] = [];

vi.mock("@/queries", () => ({
	requestDetailOptions: () => ({
		queryKey: ["request"],
		queryFn: async () => undefined,
		enabled: false,
	}),
	runDetailOptions: () => ({ queryKey: ["run"], queryFn: async () => undefined, enabled: false }),
	useCollectionsQuery: () => ({ data: COLLECTIONS }),
	useMultipleCollectionRequests: () => ({ requestsByCollection: new Map(), isLoading: false }),
	useRunsQuery: () => ({ data: { pages: [{ data: [] }] } }),
	flattenRunPages: () => [],
	useConfigQuery: () => ({ data: { entries: engineEntries } }),
	useEnvironmentsQuery: () => ({ data: ENVIRONMENTS }),
	useGlobalsQuery: () => ({ data: GLOBALS }),
	useRunSearchQuery: (q: string) => {
		runSearchCalls.push(q);
		return q === "" ? { data: undefined, isError: false } : runSearch;
	},
	useCreateRequestMutation: () => ({ mutateAsync: vi.fn() }),
	useCreateCollectionMutation: () => ({ mutateAsync: vi.fn() }),
	useStartScenarioRunMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/useVariableResolver", () => ({
	useVariableResolver: () => ({ resolveString: (s: string) => s }),
}));

function renderPalette() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<CommandPalette />
		</QueryClientProvider>
	);
}

function open() {
	act(() => useLayoutStore.getState().setPaletteOpen(true));
}

function input(): HTMLInputElement {
	return screen.getByPlaceholderText(/Search tabs/) as HTMLInputElement;
}

/** Type, then let the run debounce elapse so every source has answered. */
function typeQuery(text: string) {
	fireEvent.change(input(), { target: { value: text } });
	act(() => void vi.advanceTimersByTime(400));
}

/**
 * The visible rows of one group, by its heading.
 *
 * Matched on the heading element, not on the text: "Settings" and "Variables"
 * are each both a group heading and a row in the Views group, so a plain text
 * lookup finds two elements and is ambiguous by construction.
 */
function groupByHeading(heading: string): Element | null {
	const headings = [...document.querySelectorAll("[cmdk-group-heading]")];
	return headings.find((el) => el.textContent === heading)?.closest("[cmdk-group]") ?? null;
}

function rowsUnder(heading: string): string[] {
	const group = groupByHeading(heading);
	if (!group) return [];
	return [...group.querySelectorAll("[cmdk-item]")].map(
		(el) => el.querySelector("span.flex-1")?.textContent ?? ""
	);
}

/**
 * Every result row on screen, in visible order.
 *
 * The unit a group used to be: since the best match is promoted into its own
 * "Top result" section, a row that matched well is deliberately no longer under
 * the heading its kind would put it under.
 */
function resultRows(): string[] {
	return (
		[...document.querySelectorAll("[cmdk-item]")]
			// An escape row is not a result. Its group is the one with no heading,
			// which is what renders it as an aside to the section above it.
			.filter((el) => el.closest("[cmdk-group]")?.querySelector("[cmdk-group-heading]"))
			.map((el) => el.querySelector("span.flex-1")?.textContent ?? "")
	);
}

/** One row's whole element, to read what it prints beside its title. */
function rowByTitle(title: string): Element {
	return screen.getByText(title).closest("[cmdk-item]")!;
}

/** Pick one row by its visible title - `pressEnter` takes whatever cmdk highlighted. */
function pickRow(title: string) {
	fireEvent.click(screen.getByText(title));
}

function runRow(overrides: Partial<Run> = {}): Run {
	return {
		id: "run1",
		type: "design",
		status: "completed",
		startTime: 1_700_000_000_000,
		endTime: 1_700_000_001_000,
		summary: { url: "https://api.example/checkout", method: "POST" },
		...overrides,
	};
}

function runPage(data: Run[], total = data.length): RunListResponse {
	return {
		data,
		pagination: {
			total,
			limit: DEEP_GROUP_LIMIT,
			offset: 0,
			hasMore: false,
			returned: data.length,
		},
	};
}

beforeEach(() => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	Element.prototype.scrollIntoView = vi.fn();
	engineEntries = [];
	runSearch = { data: undefined, isError: false };
	runSearchCalls.length = 0;
	useLayoutStore.setState({ paletteOpen: false, drawerOpen: false, drawerView: "collections" });
	useTabsStore.setState({ openTabs: [], activeTabId: null, tabFocusedAt: {} });
	useSettingsStore.setState({
		selectedCategory: "appearance",
		highlightedKey: null,
		searchQuery: "",
	});
	useVariablesStore.setState({ selectedCategory: null });
	useHistoryStore.getState().resetFilters();
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("settings entries", () => {
	it("finds an engine entry by its key and reveals it in its category", () => {
		engineEntries = [
			{
				key: "dbCacheSize",
				label: "Cache Size",
				description: "SQLite page cache.",
				category: "data_retention",
				keywords: [],
			},
		];
		renderPalette();
		open();

		// The key, not the label - what every doc, log line and MCP call names it.
		typeQuery("dbCacheSize");
		pickRow("Cache Size");

		const settings = useSettingsStore.getState();
		expect(settings.selectedCategory).toBe("data_retention");
		// The anchor is what `useRevealedSetting` scrolls to and outlines.
		expect(settings.highlightedKey).toBe("dbCacheSize");
		expect(useTabsStore.getState().openTabs[0]).toMatchObject({ type: "settings" });
	});

	it("finds an app setting by a word its panel prints but its name does not", () => {
		renderPalette();
		open();

		// "Theme Mode" lives in Appearance; "dark mode" is in its keywords only.
		typeQuery("dark mode");

		// Across the list, not under "Settings": matching this well is exactly
		// what gets a row promoted out of its own section.
		expect(resultRows()).toContain("Theme Mode");
	});

	it("does not list a panel twice - the registry already offers every section", () => {
		renderPalette();
		open();

		typeQuery("Appearance");

		// One row for the Appearance section (the registry's command), and no
		// second one from the index's `panel` entries.
		const appearanceRows = resultRows().filter((row) => row === "Appearance");
		expect(appearanceRows).toHaveLength(1);
	});

	it("caps the group and hands the rest to the sidebar, pre-filtered", () => {
		engineEntries = Array.from({ length: 12 }, (_, i) => ({
			key: `zzTimeoutSetting${i}`,
			label: `Zz Timeout Setting ${i}`,
			description: "A timeout.",
			category: "general_engine",
			keywords: [],
		}));
		renderPalette();
		open();

		typeQuery("zzTimeoutSetting");

		// The cap is on what the source contributes, so it is counted across the
		// list: the best of the seven is promoted into "Top result" and the
		// other six stay under "Settings".
		expect(resultRows()).toHaveLength(DEEP_GROUP_LIMIT);
		expect(rowsUnder("Settings")).toHaveLength(DEEP_GROUP_LIMIT - 1);
		// The escape row is not a result: it is never promoted, never counted,
		// and sits in its own group below the section it is a way out of.
		const escape = screen.getByText(/^Search settings for/);
		expect(escape).toBeInTheDocument();

		fireEvent.click(escape);

		// The destination opens already filtered - the palette finds, the
		// sidebar browses.
		expect(useSettingsStore.getState().searchQuery).toBe("zzTimeoutSetting");
		expect(useLayoutStore.getState().drawerView).toBe("settings");
		expect(useLayoutStore.getState().drawerOpen).toBe(true);
	});

	it("offers no escape row when the group already shows everything", () => {
		engineEntries = [
			{
				key: "zzOnlyOne",
				label: "Zz Only One",
				description: "Alone.",
				category: "general_engine",
				keywords: [],
			},
		];
		renderPalette();
		open();

		typeQuery("zzOnlyOne");

		expect(screen.queryByText(/^Search settings for/)).not.toBeInTheDocument();
	});
});

describe("variables", () => {
	it("finds a variable key and opens the Variables tab on the scope that defines it", () => {
		renderPalette();
		open();

		typeQuery("apiToken");
		pickRow("apiToken");

		expect(useVariablesStore.getState().selectedCategory).toEqual({
			type: "environment",
			environmentId: "e1",
		});
		expect(useTabsStore.getState().openTabs[0]).toMatchObject({ type: "variables" });
	});

	it("finds a globals key, and says which scope it came from", () => {
		renderPalette();
		open();

		typeQuery("retryBudget");

		const row = rowByTitle("retryBudget");
		expect(row.textContent).toContain("Globals");
	});

	it("finds an environment by its own name", () => {
		renderPalette();
		open();

		typeQuery("Production");
		pickRow("Production");

		expect(useVariablesStore.getState().selectedCategory).toEqual({
			type: "environment",
			environmentId: "e1",
		});
	});

	it("shows a key without ever printing what it holds", () => {
		renderPalette();
		open();

		typeQuery("apiToken");

		expect(screen.getByText("apiToken")).toBeInTheDocument();
		expect(document.body.textContent).not.toContain("s3cr3t-bearer-value");
		// The searchable half of this invariant cannot be asserted here - the
		// palette ranks the rendered list, so an indexed value would be
		// invisible on screen and still be in the items. `useVariableItems.test.ts`
		// holds that half, against what the source returns.
	});
});

describe("runs", () => {
	it("waits for typing to stop before asking the engine", () => {
		renderPalette();
		open();

		fireEvent.change(input(), { target: { value: "check" } });
		// Mid-word: the palette has asked for nothing but the empty query.
		expect(runSearchCalls.every((q) => q === "")).toBe(true);

		act(() => void vi.advanceTimersByTime(400));
		expect(runSearchCalls).toContain("check");
	});

	it("lists a matching run and opens its tab", () => {
		runSearch = { data: runPage([runRow()]), isError: false };
		renderPalette();
		open();

		typeQuery("checkout");
		expect(resultRows()).toEqual(["https://api.example/checkout"]);

		pickRow("https://api.example/checkout");
		expect(useTabsStore.getState().openTabs[0]).toMatchObject({
			type: "run",
			entityId: "run1",
		});
	});

	it("names a collection run by its collection, which has no url to print", () => {
		runSearch = {
			data: runPage([
				runRow({
					id: "run2",
					type: "scenario",
					summary: { scenario: { collectionId: "c1", stepCount: 3 } },
				}),
			]),
			isError: false,
		};
		renderPalette();
		open();

		typeQuery("Payments");
		expect(rowsUnder("Runs")).toEqual(["Payments"]);
	});

	it("hides the group when the engine is down, without erroring", () => {
		// With a page still in hand, as TanStack leaves it after a failed
		// refetch - so the group can only disappear because of `isError`.
		runSearch = { data: runPage([runRow()]), isError: true };
		renderPalette();
		open();

		typeQuery("checkout");

		expect(groupByHeading("Runs")).toBeNull();
		// Idle typing must not raise anything the user has to dismiss.
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("hands the rest to History, pre-filtered and unfiltered by anything else", () => {
		useHistoryStore.getState().setFilterType("load");
		runSearch = { data: runPage([runRow()], 42), isError: false };
		renderPalette();
		open();

		typeQuery("checkout");
		fireEvent.click(screen.getByText(/^Search runs for/));

		const history = useHistoryStore.getState();
		expect(history.searchQuery).toBe("checkout");
		// The stale type filter would have hidden the design run the palette
		// just promised, so the escape resets it.
		expect(history.filterType).toBe("all");
		expect(useLayoutStore.getState().drawerView).toBe("history");
		expect(useLayoutStore.getState().drawerOpen).toBe(true);
	});
});

describe("the empty query", () => {
	it("contributes nothing from the deep sources", () => {
		engineEntries = [
			{
				key: "dbCacheSize",
				label: "Cache Size",
				description: "SQLite page cache.",
				category: "data_retention",
				keywords: [],
			},
		];
		runSearch = { data: runPage([runRow()]), isError: false };
		renderPalette();
		open();
		act(() => void vi.advanceTimersByTime(400));

		// Settings still renders - the registry's twelve sections - but none of
		// its entries, and the two server-shaped groups are absent entirely.
		expect(rowsUnder("Settings")).not.toContain("Cache Size");
		expect(groupByHeading("Variables")).toBeNull();
		expect(groupByHeading("Runs")).toBeNull();
		// And nothing was asked of the engine for a palette nobody typed into.
		expect(runSearchCalls.every((q) => q === "")).toBe(true);
	});
});
