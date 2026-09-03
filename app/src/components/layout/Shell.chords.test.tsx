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
 * The Shell's fourteen chords, from the outside.
 *
 * They had no coverage at all (#938) while being hand-rolled comparisons
 * against `e.key` behind a raw `e.metaKey || e.ctrlKey` - which is how two
 * misfires lived there unnoticed:
 *
 * - **AltGr.** On many European Windows layouts AltGr reports Ctrl+Alt, so
 *   typing `@`, `€` or `\` pressed Save, closed the tab, toggled the drawer.
 * - **The digit row.** ⌘1-9 compared `e.key` to "1".."9". On AZERTY the
 *   unshifted row produces `&é"'(-è_çà` and the shifted press that does say "1"
 *   was consumed by the shifted-chord branch first, so both spellings were dead.
 *
 * Each case drives the real store and asserts the state the chord changes, not
 * that a handler ran: what broke was users' tabs and drawers, not a call count.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Shell from "./Shell";
import { useTabsStore, useLayoutStore, useSaveStore } from "@/stores";
import { REQUEST_URL_INPUT_ID } from "@/constants/dom-ids";
import { REGION_ATTRIBUTE } from "./region-focus";

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

/*
 * The new-request flow itself is `useNewRequest`'s, and it is covered where it
 * lives. What ⌘N owes is that it reaches that flow rather than a second copy of
 * it, so the hook is stubbed and the chord's job is to call it.
 */
const newRequest = vi.fn();
vi.mock("@/hooks/useNewRequest", () => ({
	useNewRequest: () => ({
		newRequest: () => newRequest(),
		pickerProps: { open: false, onOpenChange: () => {}, collections: [], onSelect: () => {} },
	}),
}));
vi.mock("@/modules/welcome/components/CollectionPicker", () => ({
	CollectionPicker: () => <div data-testid="collection-picker" />,
}));

function renderShell() {
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<Shell />
		</QueryClientProvider>
	);
}

interface Press {
	key: string;
	/** `KeyboardEvent.code`, which is what the digit chords match on. */
	code?: string;
	shift?: boolean;
	alt?: boolean;
	/** The primary modifier. F6 is the one chord here that carries none. */
	mod?: boolean;
}

const press = ({ key, code = "", shift = false, alt = false, mod = true }: Press) =>
	fireEvent.keyDown(document.body, {
		key,
		code,
		ctrlKey: mod,
		shiftKey: shift,
		altKey: alt,
		bubbles: true,
	});

const FIRST = "tab-1";
const SECOND = "tab-2";
const THIRD = "tab-3";

const triggerSave = vi.fn();

describe("the Shell's chord map", () => {
	beforeEach(() => {
		triggerSave.mockClear();
		useSaveStore.setState({ triggerSave });
		useTabsStore.setState({
			openTabs: [
				{ id: FIRST, type: "request", entityId: "req-1" },
				{ id: SECOND, type: "request", entityId: "req-2" },
				{ id: THIRD, type: "request", entityId: "req-3" },
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

	it("saves on mod+S", () => {
		renderShell();
		press({ key: "s" });
		expect(triggerSave).toHaveBeenCalledTimes(1);
	});

	it("closes the active tab on mod+W", () => {
		renderShell();
		press({ key: "w" });
		expect(useTabsStore.getState().openTabs.map((t) => t.id)).toEqual([FIRST, THIRD]);
	});

	it("toggles the drawer on mod+B", () => {
		renderShell();
		press({ key: "b" });
		expect(useLayoutStore.getState().drawerOpen).toBe(false);
	});

	it("toggles the context bar on mod+I", () => {
		renderShell();
		press({ key: "i" });
		expect(useLayoutStore.getState().contextBarOpen).toBe(true);
	});

	it("opens the settings tab on mod+comma", () => {
		renderShell();
		press({ key: "," });
		const active = useTabsStore.getState();
		expect(active.openTabs.find((t) => t.id === active.activeTabId)?.type).toBe("settings");
	});

	it.each([
		["e", "collections"],
		["h", "history"],
		["u", "variables"],
		["s", "services"],
	])("activates the %s drawer view on mod+shift", (key, view) => {
		renderShell();
		press({ key, shift: true });
		expect(useLayoutStore.getState().drawerView).toBe(view);
	});

	it("closes the drawer when the chord names the view already showing", () => {
		// `activateDrawerView` toggles rather than re-selecting, which is what the
		// Dock buttons do on a second click. Pinned because the switchers now
		// come from a table and it would be easy to reroute them to `setDrawerView`.
		renderShell();
		expect(useLayoutStore.getState().drawerView).toBe("collections");
		press({ key: "e", shift: true });
		expect(useLayoutStore.getState().drawerOpen).toBe(false);
	});

	it("does not save on mod+shift+S - that pair is Services", () => {
		renderShell();
		press({ key: "s", shift: true });
		expect(triggerSave).not.toHaveBeenCalled();
		expect(useLayoutStore.getState().drawerView).toBe("services");
	});
});

describe("AltGr, which is Ctrl+Alt on European Windows layouts", () => {
	beforeEach(() => {
		triggerSave.mockClear();
		useSaveStore.setState({ triggerSave });
		useTabsStore.setState({
			openTabs: [
				{ id: FIRST, type: "request", entityId: "req-1" },
				{ id: SECOND, type: "request", entityId: "req-2" },
			],
			activeTabId: SECOND,
		});
		useLayoutStore.setState({ drawerOpen: true, drawerView: "collections" });
	});

	it("does not save when the user types an AltGr character over S", () => {
		renderShell();
		press({ key: "s", alt: true });
		expect(triggerSave).not.toHaveBeenCalled();
	});

	it("does not close the tab, or move the drawer", () => {
		renderShell();
		press({ key: "w", alt: true });
		press({ key: "b", alt: true });
		expect(useTabsStore.getState().openTabs).toHaveLength(2);
		expect(useLayoutStore.getState().drawerOpen).toBe(true);
	});
});

describe("mod+1-9 on a shifted-digit layout", () => {
	beforeEach(() => {
		useTabsStore.setState({
			openTabs: [
				{ id: FIRST, type: "request", entityId: "req-1" },
				{ id: SECOND, type: "request", entityId: "req-2" },
				{ id: THIRD, type: "request", entityId: "req-3" },
			],
			activeTabId: SECOND,
		});
		useLayoutStore.setState({ drawerOpen: true, drawerView: "collections" });
	});

	it("focuses the first tab from an AZERTY press, whose key is `&`", () => {
		renderShell();
		press({ key: "&", code: "Digit1" });
		expect(useTabsStore.getState().activeTabId).toBe(FIRST);
	});

	it("focuses the third tab from a QWERTY press, whose key is `3`", () => {
		renderShell();
		press({ key: "3", code: "Digit3" });
		expect(useTabsStore.getState().activeTabId).toBe(THIRD);
	});

	it("does nothing when the index is past the open tabs", () => {
		renderShell();
		press({ key: "9", code: "Digit9" });
		expect(useTabsStore.getState().activeTabId).toBe(SECOND);
	});
});

describe("moving between tabs without counting them", () => {
	beforeEach(() => {
		useTabsStore.setState({
			openTabs: [
				{ id: FIRST, type: "request", entityId: "req-1" },
				{ id: SECOND, type: "request", entityId: "req-2" },
				{ id: THIRD, type: "request", entityId: "req-3" },
			],
			activeTabId: SECOND,
		});
	});

	// Matched on `code`: ⇧] reports `}` on a US layout, and the shifted bracket
	// is a different character again elsewhere. The position is what is stable.
	it("moves to the next tab on mod+shift+]", () => {
		renderShell();
		press({ key: "}", code: "BracketRight", shift: true });
		expect(useTabsStore.getState().activeTabId).toBe(THIRD);
	});

	it("moves to the previous tab on mod+shift+[", () => {
		renderShell();
		press({ key: "{", code: "BracketLeft", shift: true });
		expect(useTabsStore.getState().activeTabId).toBe(FIRST);
	});

	it("wraps off the end to the first tab", () => {
		useTabsStore.setState({ activeTabId: THIRD });
		renderShell();
		press({ key: "}", code: "BracketRight", shift: true });
		expect(useTabsStore.getState().activeTabId).toBe(FIRST);
	});

	it("wraps off the front to the last tab", () => {
		useTabsStore.setState({ activeTabId: FIRST });
		renderShell();
		press({ key: "{", code: "BracketLeft", shift: true });
		expect(useTabsStore.getState().activeTabId).toBe(THIRD);
	});

	it("does nothing with no tabs open", () => {
		useTabsStore.setState({ openTabs: [], activeTabId: null });
		renderShell();
		press({ key: "}", code: "BracketRight", shift: true });
		expect(useTabsStore.getState().activeTabId).toBeNull();
	});
});

/** A stand-in region holding one button, for the F6 case below. */
function band(name: string, buttonId: string): [HTMLElement, HTMLButtonElement] {
	const region = document.createElement("div");
	region.setAttribute(REGION_ATTRIBUTE, name);
	const button = document.createElement("button");
	button.id = buttonId;
	region.append(button);
	return [region, button];
}

describe("the chords that reach past the store", () => {
	beforeEach(() => {
		newRequest.mockClear();
		useTabsStore.setState({
			openTabs: [{ id: FIRST, type: "request", entityId: "req-1" }],
			activeTabId: FIRST,
		});
	});

	it("starts the new-request flow on mod+N", () => {
		renderShell();
		press({ key: "n" });
		expect(newRequest).toHaveBeenCalledTimes(1);
	});

	it("focuses and selects the URL field on mod+L", () => {
		renderShell();
		// Standing in for the mounted request builder, which this suite mocks
		// out - what the chord needs from it is the one id it publishes.
		const url = document.createElement("input");
		url.id = REQUEST_URL_INPUT_ID;
		url.value = "https://api.example.com";
		document.body.append(url);

		press({ key: "l" });

		expect(document.activeElement).toBe(url);
		expect(url.selectionEnd).toBe(url.value.length);
		url.remove();
	});

	/*
	 * The bands themselves are `region-focus.test.ts`'s subject; what this owes
	 * is that F6 reaches the cycle at all - it is the one chord matched before
	 * the handler's `⌘ or Ctrl` gate, so a gate written a line too early kills
	 * it with everything else still working.
	 *
	 * Two stand-in bands either side of the Shell, because the panels that would
	 * fill its own `main` are mocked out to bare divs here - so `main` holds
	 * nothing focusable and is stepped over, which is the skip rule doing its
	 * job in passing.
	 */
	it("cycles focus to the next region on F6, which carries no modifier", () => {
		renderShell();
		const [banner, bannerControl] = band("banner", "banner-control");
		const [context, contextControl] = band("context", "context-control");
		document.body.prepend(banner);
		document.body.append(context);
		bannerControl.focus();

		press({ key: "F6", mod: false });
		expect(document.activeElement).toBe(contextControl);

		press({ key: "F6", mod: false, shift: true });
		expect(document.activeElement).toBe(bannerControl);

		banner.remove();
		context.remove();
	});
});
