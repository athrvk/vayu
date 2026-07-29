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
 * A run tab must name the run it holds, not read "Run".
 *
 * Every past design run and load test opened as a `type: "run"` tab with the
 * literal label "Run", so a row of them was indistinguishable. The label now
 * comes from the run's stored snapshot - the method and path that actually ran -
 * matching how a request tab reads. Reverting to `label = "Run"` fails these.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TabStrip } from "./TabStrip";
import { useTabsStore } from "@/stores";

const state = vi.hoisted(() => ({ run: undefined as unknown }));

vi.mock("@/queries", () => ({
	/*
	 * TabStrip resolves every tab's label in one `useQueries` call rather than a
	 * hook per tab, so these are the *options* the strip feeds it, not the old
	 * `useRequestQuery` / `useRunQuery` wrappers. `initialData` keeps the data
	 * synchronous, which is what a render-and-assert test needs.
	 */
	requestDetailOptions: (id: string | null) => ({
		queryKey: ["request", id],
		queryFn: async () => undefined,
		initialData: undefined,
		enabled: false,
	}),
	runDetailOptions: (id: string | null) => ({
		queryKey: ["run", id, state.run],
		queryFn: async () => state.run,
		initialData: state.run,
		enabled: false,
	}),
	useCollectionsQuery: () => ({ data: [] }),
}));

vi.mock("@/hooks/useVariableResolver", () => ({
	useVariableResolver: () => ({ resolveString: (s: string) => s }),
}));

function renderWithRunTab() {
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "run", entityId: "run_1" }],
		activeTabId: "t1",
	});
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<TabStrip />
		</QueryClientProvider>
	);
}

describe("run tab title", () => {
	beforeEach(() => {
		state.run = undefined;
		useTabsStore.setState({ openTabs: [], activeTabId: null });
	});

	it("names a design run by its method and path, not 'Run'", () => {
		state.run = {
			id: "run_1",
			type: "design",
			status: "completed",
			startTime: 0,
			endTime: 0,
			configSnapshot: { method: "POST", url: "https://api.example.test/users?page=2" },
		};
		renderWithRunTab();

		const tab = screen.getByRole("tab");
		expect(tab.textContent).toContain("/users");
		expect(tab.textContent).not.toBe("Run");
		/*
		 * The method is a 2px colour rail, not the word "POST". It used to be mono
		 * text costing 18px for GET and 36px for DELETE, which made a tab's width
		 * depend on its verb; the colour was always what carried the meaning. So
		 * the assertion is that the rail is painted with the method's colour, and
		 * that the word is still reachable in the tooltip.
		 */
		const rail = tab.querySelector<HTMLElement>("[aria-hidden='true']");
		expect(rail, "no method rail rendered").not.toBeNull();
		expect(rail!.style.background).toContain("hsl(");
		expect(tab.getAttribute("title")).toBe("Design run: POST /users");
	});

	it("marks a load run as a Load test in the tooltip", () => {
		state.run = {
			id: "run_1",
			type: "load",
			status: "completed",
			startTime: 0,
			endTime: 0,
			configSnapshot: { method: "GET", url: "https://api.example.test/search" },
		};
		renderWithRunTab();

		expect(screen.getByRole("tab").getAttribute("title")).toBe("Load test: GET /search");
	});

	it("falls back to 'Run' only while the run is still loading", () => {
		state.run = undefined; // query not settled yet
		renderWithRunTab();
		expect(screen.getByRole("tab").getAttribute("title")).toBe("Run");
	});
});
