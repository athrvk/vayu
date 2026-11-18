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
 * The Dock's bottom panel button (#3635, named Console by #3634): the one
 * control in the right cluster that is not per-tab. Mutation check: gate it on
 * the request tab, as the
 * response-position button is, and every case below but the request one fails;
 * point its `onClick` anywhere but `toggleBottomPanel` and the toggle cases do.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useEngineStore, useLayoutStore, useTabsStore, type TabType } from "@/stores";
import { BOTTOM_PANEL_LABEL } from "@/constants/layout";
import { baseCommandContext } from "@/lib/commands/context";
import { commandById } from "@/lib/commands/registry";
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

/** Every tab type, exhaustive by the compiler: a new type fails here until listed. */
const TAB_TYPES = Object.keys({
	welcome: true,
	request: true,
	collection: true,
	dashboard: true,
	run: true,
	variables: true,
	settings: true,
	inbox: true,
	"mock-server": true,
} satisfies Record<TabType, true>) as TabType[];

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

const button = () => screen.getByRole("button", { name: BOTTOM_PANEL_LABEL });

beforeEach(() => {
	cleanup();
	useEngineStore.setState({ engineStatus: "connected", engineError: null });
	useLayoutStore.setState({
		bottomPanelOpen: false,
		responsePosition: "beside",
		autoResponseArrangement: "beside",
	});
});

describe("the Dock's bottom panel button", () => {
	it.each(TAB_TYPES)("is present with a %s tab active", (type) => {
		renderDockOn(type);
		expect(button()).toBeInTheDocument();
	});

	it("is present with no tab open", () => {
		renderDockOn(null);
		expect(button()).toBeInTheDocument();
	});

	it("is an icon named by the panel's one label, Console", () => {
		renderDockOn("settings");
		expect(button()).toHaveAccessibleName("Console");
		expect(button()).toHaveTextContent("");
		// A console's prompt, not a panel glyph beside the response position's.
		expect(button().querySelector("svg.lucide-square-terminal")).not.toBeNull();
	});

	it("leads the right cluster, before the request tab's response-position button", () => {
		renderDockOn("request");
		const responsePosition = screen.getByRole("button", { name: /^Response (below|beside)$/ });
		expect(
			button().compareDocumentPosition(responsePosition) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
	});

	it("is pressed exactly while the panel is open", () => {
		renderDockOn("settings");
		expect(button()).toHaveAttribute("aria-pressed", "false");

		fireEvent.click(button());
		expect(button()).toHaveAttribute("aria-pressed", "true");

		fireEvent.click(button());
		expect(button()).toHaveAttribute("aria-pressed", "false");
	});

	it("shares one store field with the palette row: either flips what the other shows", () => {
		renderDockOn("settings");

		fireEvent.click(button());
		expect(useLayoutStore.getState().bottomPanelOpen).toBe(true);

		// The palette's row acts on the same field, and the button follows it.
		act(() => commandById("toggle-bottom-panel").perform(baseCommandContext()));
		expect(useLayoutStore.getState().bottomPanelOpen).toBe(false);
		expect(button()).toHaveAttribute("aria-pressed", "false");
	});
});
