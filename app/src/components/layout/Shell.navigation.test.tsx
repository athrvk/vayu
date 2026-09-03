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
 * Back and Forward reaching the store from the keyboard and the mouse (#1245).
 *
 * The chords are built from their own `Chord` definitions rather than spelled
 * out here, so this file asserts the same binding the app listens for on
 * whichever platform it runs on - the definitions themselves are pinned per
 * platform in `constants/shortcuts.platform.test.ts`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Shell from "./Shell";
import { useTabsStore, useLayoutStore, useSaveStore } from "@/stores";
import { GO_BACK_CHORD, GO_FORWARD_CHORD } from "@/constants/shortcuts";
import type { Chord } from "@/lib/platform";
import { resetNavigationEcho } from "@/lib/navigate-history";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui";

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
vi.mock("@/hooks/useNewRequest", () => ({
	useNewRequest: () => ({
		newRequest: () => {},
		pickerProps: { open: false, onOpenChange: () => {}, collections: [], onSelect: () => {} },
	}),
}));
vi.mock("@/modules/welcome/components/CollectionPicker", () => ({
	CollectionPicker: () => <div data-testid="collection-picker" />,
}));

/** Shell, optionally with a real dialog open beside it - as the app has. */
function renderShell(withDialog = false) {
	return render(
		<QueryClientProvider client={new QueryClient()}>
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

/** Press a chord exactly as it is declared, on `target`. */
function pressChord(chord: Chord, target: Element = document.body) {
	return fireEvent.keyDown(target, {
		key: chord.key,
		code: chord.code ?? "",
		ctrlKey: !!chord.mod,
		metaKey: false,
		shiftKey: !!chord.shift,
		altKey: !!chord.alt,
		bubbles: true,
	});
}

const FIRST = "tab-1";
const SECOND = "tab-2";

/** Which request the active tab is showing. */
function activeEntity(): string | null | undefined {
	const { openTabs, activeTabId } = useTabsStore.getState();
	return openTabs.find((t) => t.id === activeTabId)?.entityId;
}

describe("navigating with the keyboard", () => {
	beforeEach(() => {
		resetNavigationEcho();
		useSaveStore.setState({ triggerSave: vi.fn() });
		useLayoutStore.setState({ drawerOpen: false, contextBarOpen: false });
		useTabsStore.setState({
			openTabs: [
				{ id: FIRST, type: "request", entityId: "req-1" },
				{ id: SECOND, type: "request", entityId: "req-2" },
			],
			activeTabId: SECOND,
			tabFocusedAt: {},
			navHistory: [
				{ type: "request", entityId: "req-1" },
				{ type: "request", entityId: "req-2" },
			],
			navIndex: 1,
		});
	});

	it("goes back on its chord, and forward again on the other", () => {
		renderShell();

		pressChord(GO_BACK_CHORD);
		expect(activeEntity()).toBe("req-1");

		pressChord(GO_FORWARD_CHORD);
		expect(activeEntity()).toBe("req-2");
	});

	it("leaves the chord to a code editor, where it indents", () => {
		// Monaco binds CtrlCmd+[ and +] to outdent and indent, which is the macOS
		// chord exactly. The editor keeps them; nothing navigates.
		const { container } = renderShell();
		const editor = document.createElement("div");
		editor.className = "monaco-editor";
		const textarea = document.createElement("textarea");
		editor.appendChild(textarea);
		container.appendChild(editor);

		pressChord(GO_BACK_CHORD, textarea);

		expect(activeEntity()).toBe("req-2");
	});

	it("still navigates from a plain field, the way a browser does", () => {
		// The URL bar is an input, and Back from it is exactly what a user
		// pressing this chord there means - neither chord edits text in a field.
		const { container } = renderShell();
		const input = document.createElement("input");
		container.appendChild(input);
		input.focus();

		pressChord(GO_BACK_CHORD, input);

		expect(activeEntity()).toBe("req-1");
	});

	it("does not fire when a handler nearer the key has stopped the event", () => {
		// What the collection tree does with Alt+Arrow: its own reorder takes the
		// key and stops it at the tree, so this window listener never sees it.
		const { container } = renderShell();
		const tree = document.createElement("div");
		tree.addEventListener("keydown", (e) => e.stopPropagation());
		container.appendChild(tree);

		pressChord(GO_BACK_CHORD, tree);
		expect(activeEntity()).toBe("req-2");

		// The control, without which this case would pass against a Shell that
		// listens for nothing at all: the same press, not stopped, navigates.
		pressChord(GO_BACK_CHORD);
		expect(activeEntity()).toBe("req-1");
	});

	it("stays put while a dialog is open, which the chord would unmount", () => {
		renderShell(true);

		pressChord(GO_BACK_CHORD);

		expect(activeEntity()).toBe("req-2");
	});
});

describe("navigating with the mouse", () => {
	beforeEach(() => {
		resetNavigationEcho();
		useSaveStore.setState({ triggerSave: vi.fn() });
		useTabsStore.setState({
			openTabs: [
				{ id: FIRST, type: "request", entityId: "req-1" },
				{ id: SECOND, type: "request", entityId: "req-2" },
			],
			activeTabId: SECOND,
			tabFocusedAt: {},
			navHistory: [
				{ type: "request", entityId: "req-1" },
				{ type: "request", entityId: "req-2" },
			],
			navIndex: 1,
		});
	});

	it("goes back on the thumb button, and forward on the other", () => {
		renderShell();

		fireEvent.mouseUp(document.body, { button: 3, bubbles: true });
		expect(activeEntity()).toBe("req-1");

		fireEvent.mouseUp(document.body, { button: 4, bubbles: true });
		expect(activeEntity()).toBe("req-2");
	});

	it("stays put while a dialog is open", () => {
		// A dialog is visually on top but portalled into `document.body`, and it
		// stops nothing: the press reaches this window listener like any other.
		renderShell(true);

		fireEvent.mouseUp(document.body, { button: 3, bubbles: true });

		expect(activeEntity()).toBe("req-2");
	});

	it("ignores an ordinary click", () => {
		renderShell();

		fireEvent.mouseUp(document.body, { button: 0, bubbles: true });
		fireEvent.mouseUp(document.body, { button: 1, bubbles: true });

		expect(activeEntity()).toBe("req-2");
		expect(useTabsStore.getState().navIndex).toBe(1);
	});
});
