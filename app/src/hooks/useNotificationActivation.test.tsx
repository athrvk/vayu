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
 * A click on a system notification opens what it was about (#1358).
 *
 * The main process has already brought the window back by the time this runs;
 * what is under test is the half it cannot do, because the app's surfaces are
 * the renderer's own.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useNotificationActivation } from "./useNotificationActivation";
import { useTabsStore } from "@/stores";
import type { SystemNotificationActivation } from "@/types/electron";

type Bridge = NonNullable<Window["electronAPI"]>;

/**
 * Put a partial preload bridge on the window, or take it away with `null`.
 *
 * Through `unknown`, because `Window.electronAPI` is declared as the whole
 * `ElectronAPI` and this case needs the one method under test - a full stub
 * would be forty methods of noise around one.
 */
function bridged(api: Partial<Bridge> | null): void {
	const host = window as unknown as { electronAPI?: Partial<Bridge> };
	if (api === null) delete host.electronAPI;
	else host.electronAPI = api;
}

/**
 * Mount the hook against a stubbed bridge and hand back the callback main
 * would invoke, plus the unsubscribe the effect must return.
 */
function mounted(): {
	activate: (event: SystemNotificationActivation) => void;
	unsubscribe: ReturnType<typeof vi.fn>;
	unmount: () => void;
} {
	let activate: ((event: SystemNotificationActivation) => void) | null = null;
	const unsubscribe = vi.fn();
	// Assigned onto the real `window` rather than stubbed over it: jsdom's window
	// carries the storage the tab store persists through, and a plain object in
	// its place takes that away along with everything else.
	bridged({
		onNotificationActivated: (callback: (event: SystemNotificationActivation) => void) => {
			activate = callback;
			return unsubscribe;
		},
	});
	const { unmount } = renderHook(() => useNotificationActivation());
	if (!activate) throw new Error("the hook subscribed to nothing");
	return { activate, unsubscribe, unmount };
}

afterEach(() => {
	useTabsStore.setState({ openTabs: [], activeTabId: null });
	bridged(null);
	vi.restoreAllMocks();
});

describe("useNotificationActivation", () => {
	it("opens the run a finished run's notification was about", () => {
		const { activate } = mounted();

		activate({ kind: "load-run-finished", target: { view: "run", runId: "run_7" } });

		const tabs = useTabsStore.getState().openTabs;
		expect(tabs).toHaveLength(1);
		expect(tabs[0]).toMatchObject({ type: "run", entityId: "run_7" });
	});

	it("opens the inbox a capture notification was about", () => {
		// Mutation check: drop the `inbox` branch and the click falls through to
		// the `app` case - the window comes back showing whatever was already
		// there, not the inbox that captured (#1388).
		const { activate } = mounted();

		activate({ kind: "inbox-captured", target: { view: "inbox", inboxId: "inbox_a" } });

		const tabs = useTabsStore.getState().openTabs;
		expect(tabs).toHaveLength(1);
		expect(tabs[0]).toMatchObject({ type: "inbox", entityId: "inbox_a" });
	});

	it("opens Settings for an update notification", () => {
		const { activate } = mounted();

		activate({ kind: "update-ready", target: { view: "settings" } });

		// Through the `open-settings` command rather than two lines of its own,
		// so the menu, the palette and this cannot drift.
		expect(useTabsStore.getState().openTabs[0]).toMatchObject({ type: "settings" });
	});

	it("opens nothing for a notification with no place to go", () => {
		const { activate } = mounted();

		// The sign-in case: the user is already on the request they left, so
		// bringing the window back is the whole of it. Opening a tab here would
		// move them away from what they came back for.
		activate({ kind: "signed-in", target: { view: "app" } });

		expect(useTabsStore.getState().openTabs).toHaveLength(0);
	});

	it("unsubscribes on unmount", () => {
		const { unsubscribe, unmount } = mounted();

		unmount();

		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});

	it("is a no-op outside Electron", () => {
		bridged(null);

		expect(() => renderHook(() => useNotificationActivation())).not.toThrow();
	});
});
