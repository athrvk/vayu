/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import WelcomeScreen from "./WelcomeScreen";
import { useTabsStore, useSessionStore, useLayoutStore } from "@/stores";
import { useSettingsStore } from "@/modules/settings/settings-store";
import { DEMO_REQUEST_PRESET } from "./demo-request";
import { DEFAULT_REQUEST_NAME } from "@/constants/request";
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
	// The mock feeds a flat array as `data`; WelcomeScreen pipes it through
	// flattenRunPages, so identity here keeps the flat fixtures unchanged.
	flattenRunPages: (d: Run[] | undefined) => d ?? [],
	useCreateRequestMutation: () => ({ mutateAsync: mocks.createRequest }),
	useCreateCollectionMutation: () => ({ mutateAsync: mocks.createCollection }),
	useMultipleCollectionRequests: () => ({ requestsByCollection: new Map() }),
}));

/**
 * How many tiles the populated Launcher shows. Asserted from both sides - the
 * real grid and the skeleton's - because the skeleton silently drifted a tile
 * behind the Launcher once already, which is the one thing it exists to avoid.
 */
const LAUNCHER_TILES = 6;

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
		useLayoutStore.setState({ paletteOpen: false });
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

		// The demo tile was scoped to the Launcher alone (issue #1694), which
		// meant a truly fresh workspace - no collection yet either - never saw
		// it, only appearing once the user had already created their first
		// collection or request. A workspace this empty creates a collection
		// behind the scenes the same way "New request" does here, so the tile
		// belongs on this screen too.
		it("shows the demo tile, and creates a collection first to hold the preset request", async () => {
			renderScreen();
			expect(screen.getByRole("button", { name: /Open demo API/i })).toBeInTheDocument();

			fireEvent.click(screen.getByRole("button", { name: /Open demo API/i }));
			await waitFor(() => expect(mocks.createCollection).toHaveBeenCalled());
			expect(mocks.createRequest).toHaveBeenCalledWith(
				expect.objectContaining({
					collectionId: "new-col",
					method: DEMO_REQUEST_PRESET.method,
					url: DEMO_REQUEST_PRESET.url,
				})
			);
		});
	});

	// A Postman user looks for curl under Import and concludes it is unsupported
	// (#2196); the empty-workspace tile is the first place that can say otherwise.
	it("says on the New request tile that a curl command can be pasted", () => {
		renderScreen();
		const tile = screen.getByRole("button", { name: /New request/i });
		expect(tile).toHaveTextContent(/paste a cURL command/i);
	});

	describe("connecting a coding agent (issue #2122)", () => {
		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it("opens Settings on the MCP section from the first-run row", () => {
			useSettingsStore.getState().setSelectedCategory("appearance");
			renderScreen();
			fireEvent.click(screen.getByRole("button", { name: /Connect your coding agent/i }));

			expect(useSettingsStore.getState().selectedCategory).toBe("mcp");
			const { openTabs, activeTabId } = useTabsStore.getState();
			expect(openTabs).toHaveLength(1);
			expect(openTabs[0]).toMatchObject({ type: "settings" });
			expect(activeTabId).toBe(openTabs[0].id);
		});

		it("is absent from the Launcher, with or without runs", () => {
			mocks.collections = { data: [{ id: "c1", name: "API" }], isLoading: false };
			for (const runs of [[], [run()]]) {
				mocks.runs = { data: runs, isLoading: false };
				const { unmount } = renderScreen();
				expect(
					screen.queryByRole("button", { name: /Connect your coding agent/i })
				).not.toBeInTheDocument();
				unmount();
			}
		});

		it("links the footer to the MCP docs through the keyed channel", () => {
			const openAppLink = vi.fn();
			vi.stubGlobal("electronAPI", { openAppLink });
			renderScreen();
			fireEvent.click(screen.getByRole("button", { name: /Connect an agent \(MCP\)/i }));
			expect(openAppLink).toHaveBeenCalledExactlyOnceWith("mcp");
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

		/*
		 * The palette's visible half. ⌘K is undiscoverable on its own - nobody
		 * presses it in an app they have not been told has a palette - so the
		 * tile is what teaches the feature exists, and it has to open the same
		 * palette the chord does rather than a second search of its own.
		 */
		it("opens the command palette from the Search tile", () => {
			renderScreen();
			expect(useLayoutStore.getState().paletteOpen).toBe(false);
			fireEvent.click(screen.getByRole("button", { name: /^Search$/i }));
			expect(useLayoutStore.getState().paletteOpen).toBe(true);
		});

		/*
		 * The tiles point at a drawer view, so they must not toggle it: on
		 * `activateDrawerView` a click with the drawer already on that view closed
		 * the list the tile promised to show.
		 */
		it.each([
			["History", "history"],
			["Services", "services"],
		] as const)("the %s tile keeps an open drawer open on that view", (name, view) => {
			useLayoutStore.setState({ drawerOpen: true, drawerView: view });
			renderScreen();
			fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}$`, "i") }));
			expect(useLayoutStore.getState()).toMatchObject({ drawerOpen: true, drawerView: view });
		});

		it.each([
			["History", "history"],
			["Services", "services"],
		] as const)("the %s tile opens a closed drawer on that view", (name, view) => {
			useLayoutStore.setState({ drawerOpen: false, drawerView: "collections" });
			renderScreen();
			fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}$`, "i") }));
			expect(useLayoutStore.getState()).toMatchObject({ drawerOpen: true, drawerView: view });
		});

		it("shows one tile per action, and the skeleton matches", () => {
			const { container } = renderScreen();
			expect(container.querySelectorAll(".grid > button")).toHaveLength(LAUNCHER_TILES);
		});

		it("has no Load test action - a load test needs an existing request", () => {
			renderScreen();
			// Anchored: a recent-run row is named "Open Load test, …", which a
			// loose /Load test/ matches. The claim here is about the action tiles.
			expect(screen.queryByRole("button", { name: /^Load test$/i })).not.toBeInTheDocument();
		});

		it("carries no branding - the title bar already has the logo", () => {
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
		/*
		 * The tile's click must reach `newRequest` with no preset: handed the click
		 * event, the old spread put its circular React internals into the payload and
		 * the encode threw, so the create never left the renderer. Asserted on the
		 * exact payload and on the encode, since a mocked mutation never encodes.
		 */
		function expectBlankPayload(collectionId: string) {
			expect(mocks.createRequest).toHaveBeenCalledTimes(1);
			const payload = mocks.createRequest.mock.calls[0][0];
			expect(payload).toEqual({
				collectionId,
				name: DEFAULT_REQUEST_NAME,
				method: "GET",
				url: "",
			});
			expect(() => JSON.stringify(payload)).not.toThrow();
		}

		const two = [
			{ id: "c1", name: "First" },
			{ id: "c2", name: "Second" },
		];

		it("lands in the remembered collection without asking", async () => {
			mocks.collections = { data: two, isLoading: false };
			useSessionStore.setState({ lastCollectionId: "c2" });
			renderScreen();
			fireEvent.click(screen.getByRole("button", { name: /New request/i }));
			await waitFor(() => expect(mocks.createRequest).toHaveBeenCalled());
			expectBlankPayload("c2");
			expect(screen.queryByText(/Add request to/i)).not.toBeInTheDocument();
		});

		it("uses the only collection without asking", async () => {
			mocks.collections = { data: [{ id: "solo", name: "Solo" }], isLoading: false };
			renderScreen();
			fireEvent.click(screen.getByRole("button", { name: /New request/i }));
			await waitFor(() => expect(mocks.createRequest).toHaveBeenCalled());
			expectBlankPayload("solo");
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
			await waitFor(() => expect(mocks.createRequest).toHaveBeenCalled());
			expectBlankPayload("c2");
		});

		it("creates a collection first on a bare workspace", async () => {
			// empty workspace → FirstRunWelcome; its New request button
			renderScreen();
			fireEvent.click(screen.getByRole("button", { name: /New request/i }));
			await waitFor(() => expect(mocks.createCollection).toHaveBeenCalled());
			await waitFor(() => expect(mocks.createRequest).toHaveBeenCalled());
			expectBlankPayload("new-col");
		});
	});

	describe("the demo tile (issue #1694)", () => {
		beforeEach(() => {
			mocks.collections = { data: [{ id: "c1", name: "API" }], isLoading: false };
		});

		it("shows while no run exists, and creates the preset request", async () => {
			mocks.runs = { data: [], isLoading: false };
			renderScreen();
			fireEvent.click(screen.getByRole("button", { name: /Open demo API/i }));
			await waitFor(() =>
				expect(mocks.createRequest).toHaveBeenCalledWith(
					expect.objectContaining({
						collectionId: "c1",
						method: DEMO_REQUEST_PRESET.method,
						url: DEMO_REQUEST_PRESET.url,
					})
				)
			);
		});

		// The question this tile asks - "have you sent anything yet?" - is
		// answered the moment a run exists, and it retires without a dismiss of
		// its own (the owner's recorded decision on #1694).
		it("is gone once a run exists", () => {
			mocks.runs = { data: [run()], isLoading: false };
			renderScreen();
			expect(
				screen.queryByRole("button", { name: /Open demo API/i })
			).not.toBeInTheDocument();
		});
	});

	// Regression: both queries return [] while loading, which read as an empty
	// workspace and flashed the first-run screen at returning users.
	it("renders neither real state while loading", () => {
		mocks.collections = { data: [], isLoading: true };
		mocks.runs = { data: [], isLoading: true };
		renderScreen();
		expect(
			screen.queryByRole("button", { name: /Import a collection/i })
		).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /New request/i })).not.toBeInTheDocument();
	});

	// ...but not nothing either. Suppressing both states used to leave the
	// screen blank for the length of the load, so the fix for the flash traded
	// a wrong screen for an empty one.
	it("shows a skeleton while loading, not a blank screen", () => {
		mocks.collections = { data: [], isLoading: true };
		mocks.runs = { data: [], isLoading: true };
		const { container } = renderScreen();
		expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
		// Holds the Launcher shape: one skeleton tile per real action tile, so
		// the content lands in place rather than pushing a blank page around.
		expect(container.querySelectorAll(".grid > div")).toHaveLength(LAUNCHER_TILES);
	});

	it("drops the skeleton once the queries settle", () => {
		mocks.collections = { data: [{ id: "c1", name: "demo" }], isLoading: false };
		mocks.runs = { data: [run()], isLoading: false };
		renderScreen();
		expect(screen.queryByRole("status", { name: "Loading" })).not.toBeInTheDocument();
	});
});
