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
 * The history list mounts a window of the runs it has loaded, not all of them
 * (#2980, item 3 of #2549).
 *
 * "Load older runs" pages the list in fifty at a time with no ceiling, so a
 * long-lived install holds thousands of loaded rows, and every filter or store
 * change used to reconcile all of them. The rows vary in height, so this is
 * `useGrowingWindow` rather than a virtual list.
 *
 * The rows are stubbed: what is under test is how many the list mounts and
 * what moves the window, and 2,000 real rows would only slow the file down.
 * jsdom has no `IntersectionObserver` and the hook then shows everything, so
 * the cases stub one that fires only when a case says so.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { GROWING_WINDOW_STEP } from "@/hooks/useGrowingWindow";
import { useHistoryStore } from "@/modules/history/history-store";
import { useTabsStore } from "@/stores";
import HistoryList from "./HistoryList";
import { groupRunsByDay } from "./group-runs-by-day";

const queryState = { rows: [] as FixtureRun[], hasNextPage: false };

interface FixtureRun {
	id: string;
	type: "load" | "design";
	status: "completed";
	startTime: number;
	baseline: false;
	summary: { url: string };
}

vi.mock("@/queries", () => ({
	useRunsQuery: () => ({
		data: {
			pages: [{ data: queryState.rows, pagination: { total: queryState.rows.length } }],
		},
		isLoading: false,
		isError: false,
		error: null,
		refetch: vi.fn(),
		fetchNextPage: vi.fn(),
		hasNextPage: queryState.hasNextPage,
		isFetchingNextPage: false,
	}),
	useDeleteRunMutation: () => ({ mutateAsync: vi.fn() }),
	useSetRunBaselineMutation: () => ({ mutateAsync: vi.fn() }),
	flattenRunPages: (d: { pages: Array<{ data: unknown[] }> }) => d.pages.flatMap((p) => p.data),
	runsTotal: (d: { pages: Array<{ pagination: { total: number } }> }) =>
		d.pages[0].pagination.total,
	useCollectionsQuery: () => ({ data: [] }),
}));

// A row is one activator button, the contract `useHistoryListFocus` reads.
vi.mock("./RunItem", () => ({
	default: ({ run, isSelected }: { run: { id: string }; isSelected?: boolean }) => (
		<div data-testid="run-row" data-selected={String(!!isSelected)}>
			<button data-history-activate tabIndex={-1}>
				open-{run.id}
			</button>
		</div>
	),
}));

const DAY_MS = 86_400_000;

/** Newest first, one per minute from now: every one of them is "Today". */
function runsToday(count: number, from = 0): FixtureRun[] {
	const now = Date.now();
	return Array.from({ length: count }, (_, i) => ({
		id: `r${from + i}`,
		type: "load" as const,
		status: "completed" as const,
		startTime: now - (from + i) * 60_000,
		baseline: false as const,
		summary: { url: `http://r${from + i}.test/` },
	}));
}

/** The observer the list's sentinel gets, held so a case can reach the end. */
let reachEnd: (() => void) | null = null;

beforeEach(() => {
	reachEnd = null;
	queryState.hasNextPage = false;
	useHistoryStore.getState().resetFilters();
	useTabsStore.setState({ openTabs: [], activeTabId: null });
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			constructor(private readonly callback: IntersectionObserverCallback) {}
			observe() {
				reachEnd = () =>
					this.callback(
						[{ isIntersecting: true } as IntersectionObserverEntry],
						this as unknown as IntersectionObserver
					);
			}
			disconnect() {
				reachEnd = null;
			}
		}
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function renderList() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const ui = () => (
		<QueryClientProvider client={qc}>
			<TooltipProvider>
				<HistoryList />
			</TooltipProvider>
		</QueryClientProvider>
	);
	const view = render(ui());
	return { ...view, rerenderList: () => view.rerender(ui()) };
}

const rows = () => screen.queryAllByTestId("run-row");
const activators = () => screen.queryAllByRole("button", { name: /^open-/ });

describe("the history list's window", () => {
	it("mounts one window of a long loaded list, not every row", () => {
		queryState.rows = runsToday(2_000);
		renderList();

		expect(rows()).toHaveLength(GROWING_WINDOW_STEP);
		expect(screen.getByText(/Showing 200 of 2,000 runs/)).toBeInTheDocument();
	});

	it("lets the browser skip layout for mounted rows that are scrolled past", () => {
		queryState.rows = runsToday(3);
		renderList();

		expect(rows()[0].parentElement).toHaveClass("skip-offscreen");
	});

	it("grows by a step when the end is reached", () => {
		queryState.rows = runsToday(2_000);
		renderList();

		act(() => reachEnd?.());

		expect(rows()).toHaveLength(GROWING_WINDOW_STEP * 2);
	});

	it("holds a grown window while a poll or a page lengthens the same list", () => {
		queryState.rows = runsToday(2_000);
		const { rerenderList } = renderList();
		act(() => reachEnd?.());

		// A new run lands on page one (the 5s poll) and an older page arrives:
		// the same list, longer. Keyed on the length, the window would snap shut.
		queryState.rows = [...runsToday(1, 5_000), ...queryState.rows, ...runsToday(50, 6_000)];
		rerenderList();

		expect(rows()).toHaveLength(GROWING_WINDOW_STEP * 2);
	});

	it("starts over at the top when a filter makes it a different list", () => {
		queryState.rows = runsToday(2_000);
		renderList();
		act(() => reachEnd?.());
		expect(rows()).toHaveLength(GROWING_WINDOW_STEP * 2);

		// Every fixture row is a load run, so the rows are the same: only the
		// question changed.
		act(() => useHistoryStore.getState().setFilterType("load"));

		expect(rows()).toHaveLength(GROWING_WINDOW_STEP);
	});

	it("offers older runs only once every loaded run is mounted", () => {
		queryState.hasNextPage = true;
		queryState.rows = runsToday(GROWING_WINDOW_STEP + 5);
		renderList();

		expect(screen.queryByRole("button", { name: "Load older runs" })).not.toBeInTheDocument();

		act(() => reachEnd?.());

		expect(rows()).toHaveLength(GROWING_WINDOW_STEP + 5);
		expect(screen.getByRole("button", { name: "Load older runs" })).toBeInTheDocument();
		expect(screen.queryByText(/scroll for more/)).not.toBeInTheDocument();
	});

	it("draws each day's header once, whichever side of the window it falls", () => {
		const older = runsToday(10, 0).map((r) => ({ ...r, startTime: r.startTime - 30 * DAY_MS }));
		queryState.rows = [...runsToday(GROWING_WINDOW_STEP + 20), ...older];
		const [today, earlier] = groupRunsByDay(queryState.rows as never).map((g) => g.label);
		renderList();

		// The window ends inside "Today", so the older day has not arrived.
		expect(screen.getAllByText(today)).toHaveLength(1);
		expect(screen.queryByText(earlier)).not.toBeInTheDocument();

		act(() => reachEnd?.());

		expect(screen.getAllByText(today)).toHaveLength(1);
		expect(screen.getAllByText(earlier)).toHaveLength(1);
	});
});

describe("the history list's window and the keyboard", () => {
	it("grows when focus reaches the last mounted row, so ArrowDown has a row to land on", () => {
		queryState.rows = runsToday(GROWING_WINDOW_STEP + 50);
		renderList();

		act(() => activators()[GROWING_WINDOW_STEP - 1].focus());

		expect(rows()).toHaveLength(GROWING_WINDOW_STEP + 50);
		fireEvent.keyDown(activators()[GROWING_WINDOW_STEP - 1], { key: "ArrowDown" });
		expect(activators()[GROWING_WINDOW_STEP]).toHaveFocus();
	});

	it("grows on End, which lands on the last row mounted", () => {
		queryState.rows = runsToday(GROWING_WINDOW_STEP + 50);
		renderList();
		act(() => activators()[0].focus());

		fireEvent.keyDown(activators()[0], { key: "End" });

		expect(activators()[GROWING_WINDOW_STEP - 1]).toHaveFocus();
		expect(rows()).toHaveLength(GROWING_WINDOW_STEP + 50);
	});

	it("leaves the window alone while focus is not at its end", () => {
		queryState.rows = runsToday(GROWING_WINDOW_STEP + 50);
		renderList();

		act(() => activators()[GROWING_WINDOW_STEP - 2].focus());

		expect(rows()).toHaveLength(GROWING_WINDOW_STEP);
	});

	it("marks a selected run that is beyond the window once the window reaches it", () => {
		/*
		 * Selection is the active tab's, not something the list holds, so a row
		 * mounted late is drawn selected like any other. Nothing scrolls the
		 * selected run into view today, loaded beyond the window or not.
		 */
		queryState.rows = runsToday(GROWING_WINDOW_STEP + 50);
		const selected = `r${GROWING_WINDOW_STEP + 10}`;
		useTabsStore.getState().openTab({ type: "run", entityId: selected });
		renderList();

		expect(screen.queryByRole("button", { name: `open-${selected}` })).not.toBeInTheDocument();
		expect(rows().filter((r) => r.dataset.selected === "true")).toHaveLength(0);

		act(() => reachEnd?.());

		const row = screen.getByRole("button", { name: `open-${selected}` }).parentElement;
		expect(row).toHaveAttribute("data-selected", "true");
	});
});
