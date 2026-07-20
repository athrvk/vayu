import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import WelcomeScreen from "./WelcomeScreen";
import { useTabsStore } from "@/stores";
import type { Run } from "@/types";

const mocks = vi.hoisted(() => ({
	collections: { data: [] as unknown[], isLoading: false },
	runs: { data: [] as Run[], isLoading: false },
}));

vi.mock("@/queries", () => ({
	useCollectionsQuery: () => mocks.collections,
	useRunsQuery: () => mocks.runs,
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
	const qc = new QueryClient();
	return render(
		<QueryClientProvider client={qc}>
			<WelcomeScreen />
		</QueryClientProvider>
	);
}

describe("WelcomeScreen", () => {
	beforeEach(() => {
		mocks.collections = { data: [], isLoading: false };
		mocks.runs = { data: [], isLoading: false };
		useTabsStore.setState({ openTabs: [], activeTabId: null });
	});

	describe("empty workspace", () => {
		it("leads with import", () => {
			renderScreen();
			expect(
				screen.getByRole("button", { name: /Import a collection/i })
			).toBeInTheDocument();
			expect(screen.getByText(/Postman, Insomnia, or OpenAPI/i)).toBeInTheDocument();
		});

		it("drops the marketing sections the redesign removed", () => {
			renderScreen();
			expect(screen.queryByText(/Key Features/i)).not.toBeInTheDocument();
			expect(screen.queryByText(/50k\+/)).not.toBeInTheDocument();
			expect(screen.queryByText(/Requests per second/i)).not.toBeInTheDocument();
		});
	});

	describe("populated workspace", () => {
		beforeEach(() => {
			mocks.collections = { data: [{ id: "c1", name: "API" }], isLoading: false };
			mocks.runs = { data: [run()], isLoading: false };
		});

		it("shows the action row and recent runs", () => {
			renderScreen();
			expect(screen.getByRole("button", { name: /New request/i })).toBeInTheDocument();
			expect(screen.getByRole("button", { name: /Load test/i })).toBeInTheDocument();
			expect(screen.getByText(/Recent runs/i)).toBeInTheDocument();
		});

		it("carries no branding — the title bar already has the logo", () => {
			renderScreen();
			expect(screen.queryByText("Vayu")).not.toBeInTheDocument();
		});

		it("counts collections and runs", () => {
			renderScreen();
			expect(screen.getByText(/1 collection · 1 run/)).toBeInTheDocument();
		});

		// Regression: rows used to call activateDrawerView("history"), opening the
		// drawer instead of the run that was clicked.
		it("opens the clicked run in its own tab", () => {
			renderScreen();
			fireEvent.click(screen.getByRole("button", { name: /Completed/i }));
			const { openTabs } = useTabsStore.getState();
			expect(openTabs).toHaveLength(1);
			expect(openTabs[0]).toMatchObject({ type: "run", entityId: "run-1" });
		});

		// Regression: runs.sort() sorted the TanStack Query cache array in place.
		it("does not mutate the runs array from the query", () => {
			const older = run({ id: "old", startTime: 1000 });
			const newer = run({ id: "new", startTime: 2000 });
			mocks.runs = { data: [older, newer], isLoading: false };
			renderScreen();
			expect(mocks.runs.data.map((r) => r.id)).toEqual(["old", "new"]);
		});
	});

	// Regression: both queries return [] while loading, which read as an empty
	// workspace and flashed the first-run screen at returning users.
	it("renders neither state while loading", () => {
		mocks.collections = { data: [], isLoading: true };
		mocks.runs = { data: [], isLoading: true };
		renderScreen();
		expect(
			screen.queryByRole("button", { name: /Import a collection/i })
		).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /New request/i })).not.toBeInTheDocument();
	});
});
