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
 * The Shell's chord map had no target guard of any kind (#935), so ⌘W closed
 * the tab underneath an open dialog and ⌘1-9 switched away from it - unmounting
 * the dialog's owner in the middle of the interaction it was opened for.
 *
 * Every case is a pair: the chord acts with nothing up, and does not act with a
 * real `DialogContent` mounted. The pair is the whole point - a guard that
 * refused the chord always would satisfy the negative half on its own, and it
 * is the half `isModalOpen` is most likely to break by returning `true` too
 * eagerly. The dialog is Radix's, not a hand-written marker, so the attribute
 * the predicate reads is the one the app really stamps.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Shell from "./Shell";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui";
import { useTabsStore, useLayoutStore, useSaveStore } from "@/stores";

vi.mock("./Drawer", () => ({ Drawer: () => <div data-testid="drawer" /> }));
vi.mock("./Dock", () => ({ Dock: () => <div data-testid="dock" /> }));
vi.mock("./ContextBar", () => ({ ContextBar: () => <div data-testid="context-bar" /> }));
vi.mock("./TabStrip", () => ({ TabStrip: () => <div data-testid="tab-strip" /> }));
vi.mock("@/modules/palette", () => ({ CommandPalette: () => <div data-testid="palette" /> }));
vi.mock("@/modules/collections/ImportModal", () => ({
	ImportModal: () => <div data-testid="import-modal" />,
}));
vi.mock("@/modules/request-builder", () => ({
	default: () => <div data-testid="request-builder" />,
}));
vi.mock("@/modules/collections/CollectionDetail", () => ({
	default: () => <div data-testid="collection-detail" />,
}));
vi.mock("@/modules/dashboard", () => ({ default: () => <div data-testid="dashboard" /> }));
vi.mock("@/modules/history/main/HistoryDetail", () => ({
	default: () => <div data-testid="history-detail" />,
}));
vi.mock("@/modules/welcome/WelcomeScreen", () => ({
	default: () => <div data-testid="welcome-screen" />,
}));
vi.mock("@/modules/settings/main/SettingsMain", () => ({
	default: () => <div data-testid="settings-main" />,
}));
vi.mock("@/modules/variables/main/VariablesMain", () => ({
	default: () => <div data-testid="variables-main" />,
}));
vi.mock("@/modules/inbox", () => ({ default: () => <div data-testid="inbox" /> }));

/** Shell, optionally with a real dialog open beside it - as the app has. */
function renderShell(withDialog: boolean) {
	const qc = new QueryClient();
	return render(
		<QueryClientProvider client={qc}>
			<Shell />
			{withDialog && (
				<Dialog open>
					<DialogContent>
						<DialogTitle>A dialog</DialogTitle>
						<DialogDescription>Open over the shell.</DialogDescription>
						<input aria-label="a field" autoFocus />
					</DialogContent>
				</Dialog>
			)}
		</QueryClientProvider>
	);
}

// `code` because the tab chords are bound to the physical digit row, not to
// the character it produces (#938) - see `Shell.chords.test.tsx`.
const chord = (key: string, code = "") =>
	fireEvent.keyDown(document.activeElement ?? document.body, {
		key,
		code,
		ctrlKey: true,
		bubbles: true,
	});

const FIRST = "tab-1";
const SECOND = "tab-2";

describe("Shell chords behind an open modal", () => {
	beforeEach(() => {
		useTabsStore.setState({
			openTabs: [
				{ id: FIRST, type: "request", entityId: "req-1" },
				{ id: SECOND, type: "request", entityId: "req-2" },
			],
			activeTabId: SECOND,
		});
		useLayoutStore.setState({
			drawerOpen: true,
			drawerView: "collections",
			drawerWidth: 300,
			contextBarOpen: false,
			contextBarWidth: 400,
			requestSplitRatio: 0.5,
		});
	});

	it("closes the active tab on mod+W with nothing open", () => {
		renderShell(false);
		chord("w");
		expect(useTabsStore.getState().openTabs.map((t) => t.id)).toEqual([FIRST]);
	});

	it("leaves the tab alone on mod+W while a dialog is open", () => {
		renderShell(true);
		chord("w");
		expect(useTabsStore.getState().openTabs.map((t) => t.id)).toEqual([FIRST, SECOND]);
		expect(useTabsStore.getState().activeTabId).toBe(SECOND);
	});

	it("switches tabs on mod+1 with nothing open, and not while a dialog is open", () => {
		renderShell(false);
		chord("1", "Digit1");
		expect(useTabsStore.getState().activeTabId).toBe(FIRST);

		useTabsStore.setState({ activeTabId: SECOND });
		renderShell(true);
		chord("1", "Digit1");
		expect(useTabsStore.getState().activeTabId).toBe(SECOND);
	});

	it("does not save on mod+S while a dialog is open", () => {
		const triggerSave = vi.fn();
		useSaveStore.setState({ triggerSave });

		renderShell(false);
		chord("s");
		expect(triggerSave).toHaveBeenCalledTimes(1);

		renderShell(true);
		chord("s");
		expect(triggerSave).toHaveBeenCalledTimes(1);
	});

	it("does not toggle the drawer on mod+B while a dialog is open", () => {
		renderShell(true);
		chord("b");
		expect(useLayoutStore.getState().drawerOpen).toBe(true);
	});
});
