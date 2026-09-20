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
 * The Dock's right cluster (issue #1711): per-tab view controls, rendered only
 * while the active tab is a request tab. Mutation check: drop the request-tab
 * gate in `Dock` and the settings and dashboard cases below fail.
 *
 * The button's name is its destination, not the state it shows: "Response
 * below" while the response is beside the request, "Response beside" while it
 * is below - the rule "### Pane Toggles" holds for the `PanelLeft*` pair.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useEngineStore, useLayoutStore, useTabsStore, type TabType } from "@/stores";
import { Dock } from "./Dock";

vi.mock("@/services/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/services/api")>();
	return {
		...actual,
		apiService: {
			...actual.apiService,
			listInboxes: () => Promise.resolve([]),
			listMockIssuers: () => Promise.resolve([]),
			listMockServers: () => Promise.resolve([]),
		},
	};
});

vi.stubGlobal("__VAYU_VERSION__", "0.0.0-test");

function renderDockOn(type: TabType | null) {
	useTabsStore.setState({
		openTabs: type
			? [{ id: "tab-1", type, entityId: type === "request" ? "req-1" : null }]
			: [],
		activeTabId: type ? "tab-1" : null,
	});
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<Dock />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

const button = () => screen.queryByRole("button", { name: /^Response (below|beside)$/ });

beforeEach(() => {
	cleanup();
	useEngineStore.setState({ engineStatus: "connected", engineError: null });
	useLayoutStore.setState({ responsePosition: "beside", autoResponseArrangement: "beside" });
});

describe("the Dock's response-position button", () => {
	it("is present with a request tab active", () => {
		renderDockOn("request");
		expect(button()).toBeInTheDocument();
	});

	it.each(["settings", "dashboard"] as const)("is absent with a %s tab active", (type) => {
		renderDockOn(type);
		expect(button()).not.toBeInTheDocument();
		// The centred status is untouched: the strip on those tabs is today's.
		expect(screen.getByText("Connected")).toBeInTheDocument();
	});

	it("is absent with no tab at all", () => {
		renderDockOn(null);
		expect(button()).not.toBeInTheDocument();
	});

	it("is named for its destination: below while beside, beside while below", () => {
		renderDockOn("request");
		expect(screen.getByRole("button", { name: "Response below" })).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Response below" }));
		expect(useLayoutStore.getState().responsePosition).toBe("below");
		expect(screen.getByRole("button", { name: "Response beside" })).toBeInTheDocument();
	});

	it("shows auto's current pick, and a click makes the choice explicit", () => {
		useLayoutStore.setState({ responsePosition: "auto", autoResponseArrangement: "below" });
		renderDockOn("request");
		// Auto has stacked the response, so the destination on offer is beside.
		fireEvent.click(screen.getByRole("button", { name: "Response beside" }));
		expect(useLayoutStore.getState().responsePosition).toBe("beside");
	});
});
