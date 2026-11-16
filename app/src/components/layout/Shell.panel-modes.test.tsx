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
 * The Shell's half of push and overlay (#3494): which mode each side panel is
 * handed at a given window width, and the box the drawer's overlay positions
 * against.
 *
 * The panels are stubbed to print the mode they receive; what each does with
 * it is `Drawer.overlay.test.tsx` and `ContextBar.markup.test.tsx`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useState } from "react";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Shell from "./Shell";
import { useTabsStore, useLayoutStore } from "@/stores";
import { CONTEXT_BAR_PUSH_MIN_WIDTH, DRAWER_PUSH_MIN_WIDTH } from "@/constants/layout";

vi.mock("./Drawer", () => ({
	Drawer: ({ mode }: { mode?: string }) => <div data-testid="drawer" data-mode={mode} />,
}));
vi.mock("./ContextBar", () => ({
	ContextBar: ({ mode }: { mode?: string }) => <div data-testid="context-bar" data-mode={mode} />,
}));
vi.mock("./Dock", () => ({ Dock: () => <div data-testid="dock" /> }));
vi.mock("./ActivityRail", () => ({ ActivityRail: () => <div data-testid="activity-rail" /> }));
vi.mock("./ContextRail", () => ({ ContextRail: () => <div data-testid="context-rail" /> }));
vi.mock("@/modules/collections/ImportModal", () => ({
	ImportModal: () => <div data-testid="import-modal" />,
}));
vi.mock("@/modules/collections/CollectionDetail", () => ({ default: () => null }));
vi.mock("@/modules/dashboard", () => ({ default: () => null }));
vi.mock("@/modules/history/main/HistoryDetail", () => ({ default: () => null }));
vi.mock("@/modules/welcome/WelcomeScreen", () => ({ default: () => null }));
vi.mock("@/modules/settings/main/SettingsMain", () => ({ default: () => null }));
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

function renderShellAt(width: number) {
	vi.stubGlobal("innerWidth", width);
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<Shell />
		</QueryClientProvider>
	);
}

function resizeTo(width: number) {
	vi.stubGlobal("innerWidth", width);
	window.dispatchEvent(new Event("resize"));
}

const drawerMode = () => screen.getByTestId("drawer").dataset.mode;
const contextBarMode = () => screen.getByTestId("context-bar").dataset.mode;

beforeEach(() => {
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "request", entityId: "r1" }],
		activeTabId: "t1",
	});
	useLayoutStore.setState({ drawerOpen: true, drawerWidth: 260 });
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Shell - each side panel's mode from the window width", () => {
	it("pushes both at the context bar's threshold", () => {
		renderShellAt(CONTEXT_BAR_PUSH_MIN_WIDTH);
		expect(drawerMode()).toBe("push");
		expect(contextBarMode()).toBe("push");
	});

	it("overlays only the context bar between the two thresholds", () => {
		// The width that tells the two thresholds apart: a Shell handing both
		// panels the same one fails here, whichever it is.
		renderShellAt(CONTEXT_BAR_PUSH_MIN_WIDTH - 1);
		expect(drawerMode()).toBe("push");
		expect(contextBarMode()).toBe("overlay");
	});

	it("pushes the drawer at its own threshold", () => {
		renderShellAt(DRAWER_PUSH_MIN_WIDTH);
		expect(drawerMode()).toBe("push");
	});

	it("overlays both below the drawer's threshold", () => {
		renderShellAt(DRAWER_PUSH_MIN_WIDTH - 1);
		expect(drawerMode()).toBe("overlay");
		expect(contextBarMode()).toBe("overlay");
	});

	it("follows a resize, and crossing the threshold does not remount the tab", () => {
		renderShellAt(1280);
		const draft = screen.getByTestId("draft");
		fireEvent.change(draft, { target: { value: '{"unsaved": true}' } });

		act(() => resizeTo(512));
		expect(drawerMode()).toBe("overlay");
		act(() => resizeTo(1280));
		expect(drawerMode()).toBe("push");

		// The drawer's positioned box exists in both modes, so only a class list
		// changed: the same node, holding the same state.
		expect(screen.getByTestId("draft")).toBe(draft);
		expect(draft).toHaveValue('{"unsaved": true}');
	});
});

describe("Shell - the box the drawer's overlay positions against", () => {
	it("holds the drawer and the content column, and not the activity rail", () => {
		renderShellAt(512);
		const box = screen.getByTestId("drawer").parentElement as HTMLElement;

		// `relative`, or `absolute left-0` would resolve against something further
		// out and cover the rail that toggles the drawer.
		expect(box.className.split(/\s+/)).toContain("relative");
		expect(box.contains(screen.getByRole("main"))).toBe(true);
		expect(box.contains(screen.getByRole("tablist"))).toBe(true);
		expect(box.contains(screen.getByTestId("activity-rail"))).toBe(false);
	});

	it("keeps the drawer ahead of the content in document order, for F6", () => {
		renderShellAt(512);
		// `cycleRegionFocus` walks regions in document order: rail, drawer, main.
		const drawer = screen.getByTestId("drawer");
		expect(
			screen.getByTestId("activity-rail").compareDocumentPosition(drawer) &
				Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
		expect(
			drawer.compareDocumentPosition(screen.getByRole("main")) &
				Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
	});
});
