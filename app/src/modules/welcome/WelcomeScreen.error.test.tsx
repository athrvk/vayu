/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A failed load must not look like a fresh workspace.
 *
 * Both queries here are destructured as `{ data = [] }` and nothing sets
 * `throwOnError`, so a query that settles as an error never reaches the
 * ErrorBoundary - it resolves to `[]`. `isEmpty` then went true and the screen
 * rendered the branded first-run pitch: it told a user who already has
 * collections and runs that they are brand new, and invited them to import
 * collections they already have.
 *
 * The error render is gated on there being nothing to show, because TanStack
 * keeps the last good data through a failed background refetch. This file
 * guards both halves - that the failure is named, and that it does not
 * displace data that is still good.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import WelcomeScreen from "./WelcomeScreen";
import { useTabsStore, useSessionStore } from "@/stores";
import type { Run } from "@/types";

const refetchCollections = vi.fn();
const refetchRuns = vi.fn();

const queryState = {
	collections: {
		data: [] as { id: string; name: string }[],
		isLoading: false,
		isError: false,
		error: null as Error | null,
		refetch: refetchCollections,
	},
	runs: {
		data: [] as Run[],
		isLoading: false,
		isError: false,
		error: null as Error | null,
		refetch: refetchRuns,
	},
};

// vi.mock replaces the whole module, so the full surface the screen pulls has
// to be here - a missing hook is `undefined()` at mount.
vi.mock("@/queries", () => ({
	useCollectionsQuery: () => queryState.collections,
	useRunsQuery: () => queryState.runs,
	useCreateRequestMutation: () => ({ mutateAsync: vi.fn() }),
	useCreateCollectionMutation: () => ({ mutateAsync: vi.fn() }),
	useMultipleCollectionRequests: () => ({ requestsByCollection: new Map() }),
}));

function run(over: Partial<Run> = {}): Run {
	return {
		id: "run-1",
		type: "load",
		status: "completed",
		startTime: Date.now() - 60_000,
		endTime: Date.now(),
		...over,
	} as Run;
}

function renderScreen() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<WelcomeScreen />
		</QueryClientProvider>
	);
}

function failed<T>(data: T) {
	return { data, isLoading: false, isError: true, error: new Error("Failed to fetch") };
}

beforeEach(() => {
	refetchCollections.mockReset();
	refetchRuns.mockReset();
	queryState.collections = {
		data: [],
		isLoading: false,
		isError: false,
		error: null,
		refetch: refetchCollections,
	};
	queryState.runs = {
		data: [],
		isLoading: false,
		isError: false,
		error: null,
		refetch: refetchRuns,
	};
	useTabsStore.setState({ openTabs: [], activeTabId: null });
	useSessionStore.setState({ lastCollectionId: null });
});

describe("WelcomeScreen when the workspace fails to load", () => {
	it("says the load failed instead of greeting the user as new", () => {
		queryState.collections = { ...failed([]), refetch: refetchCollections };
		queryState.runs = { ...failed([] as Run[]), refetch: refetchRuns };
		renderScreen();

		expect(screen.getByText(/couldn't load your workspace/i)).toBeInTheDocument();
		expect(screen.getByText(/failed to fetch/i)).toBeInTheDocument();
		// The dangerous half: the first-run pitch aimed at someone who is not new.
		expect(
			screen.queryByText(/Send API requests, script them, and load test them/i)
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Import a collection/i })
		).not.toBeInTheDocument();
	});

	it("retries the screen, not one query", () => {
		queryState.collections = { ...failed([]), refetch: refetchCollections };
		queryState.runs = { ...failed([] as Run[]), refetch: refetchRuns };
		renderScreen();

		screen.getByRole("button", { name: /try again/i }).click();
		expect(refetchCollections).toHaveBeenCalled();
		expect(refetchRuns).toHaveBeenCalled();
	});

	it("keeps the Launcher when a failed refetch left good data behind", () => {
		// Collections failed, but runs are still cached. An error pane here would
		// discard real run history to report a fetch that has a stale answer.
		queryState.collections = { ...failed([]), refetch: refetchCollections };
		queryState.runs = {
			data: [run()],
			isLoading: false,
			isError: false,
			error: null,
			refetch: refetchRuns,
		};
		renderScreen();

		expect(screen.getByText(/Recent runs/i)).toBeInTheDocument();
		expect(screen.queryByText(/couldn't load your workspace/i)).not.toBeInTheDocument();
	});

	it("still shows the first-run screen when the workspace is genuinely empty", () => {
		renderScreen();

		expect(
			screen.getByText(/Send API requests, script them, and load test them/i)
		).toBeInTheDocument();
		expect(screen.queryByText(/couldn't load your workspace/i)).not.toBeInTheDocument();
	});
});
