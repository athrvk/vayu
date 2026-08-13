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
 * Moving the tab strip into the content column must not remount tab content.
 *
 * The strip now lives in a column over main + context, with the drawer as that
 * column's flex sibling - which means drawer state (open, width) is upstream of
 * the element tree the active tab renders into. That is exactly the shape where
 * a plausible-looking `key={drawerOpen}` or a wrapper mounted only when the
 * drawer is closed throws away everything React was holding for the tab: an
 * unsaved request body, a scroll position, a Monaco model. The GraphQL body's
 * keyed-siblings lesson is the same defect one layer down.
 *
 * So the assertion is on identity, not on markup: the same DOM node, and the
 * component state living in it, have to survive collapsing and resizing the
 * drawer. A stateful stub stands in for the request builder - it is what the
 * real editor would be losing.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { useState } from "react";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Shell from "./Shell";
import { useTabsStore, useLayoutStore } from "@/stores";

vi.mock("./Drawer", () => ({
	Drawer: () => <div data-testid="drawer" />,
}));
vi.mock("./Dock", () => ({ Dock: () => <div data-testid="dock" /> }));
vi.mock("./ContextBar", () => ({ ContextBar: () => <div data-testid="context-bar" /> }));
vi.mock("@/modules/collections/ImportModal", () => ({
	ImportModal: () => <div data-testid="import-modal" />,
}));
vi.mock("@/modules/collections/CollectionDetail", () => ({ default: () => null }));
vi.mock("@/modules/dashboard", () => ({ default: () => null }));
vi.mock("@/modules/history/main", () => ({ HistoryDetail: () => null }));
vi.mock("@/modules/welcome/WelcomeScreen", () => ({ default: () => null }));
vi.mock("@/modules/settings", () => ({ SettingsMain: () => null }));
vi.mock("@/modules/variables/main/VariablesMain", () => ({ default: () => null }));

/** Stands in for the request builder, holding the state an unsaved body is. */
vi.mock("@/modules/request-builder", () => ({
	default: function DraftEditor() {
		const [body, setBody] = useState("");
		return (
			<input
				data-testid="draft"
				aria-label="body"
				value={body}
				onChange={(e) => setBody(e.target.value)}
			/>
		);
	},
}));

function renderShell() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<Shell />
		</QueryClientProvider>
	);
}

describe("tab content identity across the drawer", () => {
	beforeEach(() => {
		useTabsStore.setState({
			openTabs: [{ id: "t1", type: "request", entityId: "r1" }],
			activeTabId: "t1",
		});
		useLayoutStore.setState({ drawerOpen: true, drawerWidth: 260 });
	});

	it("survives the drawer collapsing, reopening and resizing", () => {
		renderShell();
		const draft = screen.getByTestId("draft");
		fireEvent.change(draft, { target: { value: '{"unsaved": true}' } });

		act(() => useLayoutStore.getState().setDrawerOpen(false));
		act(() => useLayoutStore.getState().setDrawerOpen(true));
		act(() => useLayoutStore.getState().setDrawerWidth(400));

		// The same node, not merely an equivalent one: a remount would produce a
		// fresh element with a fresh useState, and the value is what proves the
		// difference matters.
		expect(screen.getByTestId("draft")).toBe(draft);
		expect(screen.getByTestId("draft")).toHaveValue('{"unsaved": true}');
	});

	it("puts the tab strip inside the column the drawer sits beside", () => {
		// The geometry claim itself: the strip is a *sibling of main*, under the
		// same column, rather than a row spanning the window. Anything else and
		// its left edge stops tracking the drawer's resize handle.
		renderShell();
		const strip = screen.getByRole("tablist");
		const main = screen.getByRole("main");
		expect(strip.parentElement).toBe(main.parentElement?.parentElement);
		expect(strip.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});
});
