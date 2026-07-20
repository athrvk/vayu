import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import WelcomeScreen from "./WelcomeScreen";
import { useTabsStore, useSessionStore } from "@/stores";
import type { Run } from "@/types";

const mocks = vi.hoisted(() => ({
	collections: { data: [] as { id: string; name: string }[], isLoading: false },
	runs: { data: [] as Run[], isLoading: false },
	createRequest: vi.fn(),
	createCollection: vi.fn(),
}));

vi.mock("@/queries", () => ({
	useCollectionsQuery: () => mocks.collections,
	useRunsQuery: () => mocks.runs,
	useCreateRequestMutation: () => ({ mutateAsync: mocks.createRequest }),
	useCreateCollectionMutation: () => ({ mutateAsync: mocks.createCollection }),
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
		mocks.createRequest = vi.fn().mockResolvedValue({ id: "new-req" });
		mocks.createCollection = vi.fn().mockResolvedValue({ id: "new-col" });
		useTabsStore.setState({ openTabs: [], activeTabId: null });
		useSessionStore.setState({ lastCollectionId: null });
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
			expect(screen.getByRole("button", { name: /^History$/i })).toBeInTheDocument();
			expect(screen.getByText(/Recent runs/i)).toBeInTheDocument();
		});

		it("has no Load test action — a load test needs an existing request", () => {
			renderScreen();
			expect(screen.queryByRole("button", { name: /Load test/i })).not.toBeInTheDocument();
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

	describe("new request targeting", () => {
		const two = [
			{ id: "c1", name: "First" },
			{ id: "c2", name: "Second" },
		];

		it("lands in the remembered collection without asking", async () => {
			mocks.collections = { data: two, isLoading: false };
			useSessionStore.setState({ lastCollectionId: "c2" });
			renderScreen();
			fireEvent.click(screen.getByRole("button", { name: /New request/i }));
			await waitFor(() =>
				expect(mocks.createRequest).toHaveBeenCalledWith(
					expect.objectContaining({ collectionId: "c2" })
				)
			);
			expect(screen.queryByText(/Add request to/i)).not.toBeInTheDocument();
		});

		it("uses the only collection without asking", async () => {
			mocks.collections = { data: [{ id: "solo", name: "Solo" }], isLoading: false };
			renderScreen();
			fireEvent.click(screen.getByRole("button", { name: /New request/i }));
			await waitFor(() =>
				expect(mocks.createRequest).toHaveBeenCalledWith(
					expect.objectContaining({ collectionId: "solo" })
				)
			);
		});

		it("asks when there are several collections and no memory", async () => {
			mocks.collections = { data: two, isLoading: false };
			renderScreen();
			fireEvent.click(screen.getByRole("button", { name: /New request/i }));
			// Picker opens; nothing created yet
			expect(await screen.findByText(/Add request to/i)).toBeInTheDocument();
			expect(mocks.createRequest).not.toHaveBeenCalled();
			// Picking a collection creates the request there
			fireEvent.click(screen.getByRole("button", { name: /Second/i }));
			await waitFor(() =>
				expect(mocks.createRequest).toHaveBeenCalledWith(
					expect.objectContaining({ collectionId: "c2" })
				)
			);
		});

		it("creates a collection first on a bare workspace", async () => {
			// empty workspace → EmptyState; its New request button
			renderScreen();
			fireEvent.click(screen.getByRole("button", { name: /New request/i }));
			await waitFor(() => expect(mocks.createCollection).toHaveBeenCalled());
			expect(mocks.createRequest).toHaveBeenCalledWith(
				expect.objectContaining({ collectionId: "new-col" })
			);
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
