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
 * Something the OS asked Vayu to open (#1364) - a document dropped on the icon,
 * a collection picked off the Dock menu or a Jump List task, or New Request
 * from either.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTabsStore, useImportModalStore, useLayoutStore } from "@/stores";
import { matchesChord, NEW_REQUEST_CHORD } from "@/constants/shortcuts";
import type { OpenIntent } from "@/types/electron";

import { useOpenIntent } from "./useOpenIntent";

type Bridge = NonNullable<Window["electronAPI"]>;

/** Same pattern `useNotificationActivation.test.tsx` uses for a partial bridge. */
function bridged(api: Partial<Bridge> | null): void {
	const host = window as unknown as { electronAPI?: Partial<Bridge> };
	if (api === null) delete host.electronAPI;
	else host.electronAPI = api;
}

function mounted(): {
	open: (intent: OpenIntent) => void;
	unsubscribe: ReturnType<typeof vi.fn>;
	unmount: () => void;
} {
	let open: ((intent: OpenIntent) => void) | null = null;
	const unsubscribe = vi.fn();
	bridged({
		onOpenIntent: (callback: (intent: OpenIntent) => void) => {
			open = callback;
			return unsubscribe;
		},
	});
	const { unmount } = renderHook(() => useOpenIntent());
	if (!open) throw new Error("the hook subscribed to nothing");
	return { open, unsubscribe, unmount };
}

afterEach(() => {
	useTabsStore.setState({ openTabs: [], activeTabId: null });
	useImportModalStore.setState({ isOpen: false, pendingPath: null });
	bridged(null);
});

describe("useOpenIntent", () => {
	/*
	 * Not `commandById("new-request").perform(baseCommandContext())`, which is
	 * what `useNotificationActivation` does for Settings and what this hook
	 * first did: that command declares `available: (ctx) => ctx.surfaces !==
	 * undefined`, because the flow can need a collection picker and a picker
	 * needs a mounted host. `baseCommandContext()` carries no `surfaces` by
	 * design - `registry.test.ts` pins exactly that - so `perform` there is
	 * `ctx.surfaces?.newRequest()`, a silent no-op and a Dock menu entry that
	 * opens nothing.
	 *
	 * Mutation check: go back to the command call and no keydown is dispatched,
	 * so this reddens on the assertion below rather than passing on a mock.
	 */
	it("hands New Request to the one window handler as a real chord press", () => {
		const seen: KeyboardEvent[] = [];
		const listener = (event: Event) => seen.push(event as KeyboardEvent);
		window.addEventListener("keydown", listener);
		const { open } = mounted();

		open({ kind: "newRequest" });
		window.removeEventListener("keydown", listener);

		// It has to reach `window`, where `Shell` binds the chord, and it has to
		// be the chord `Shell` matches - a keydown that bubbles nowhere or
		// carries the wrong modifier would satisfy neither half.
		expect(seen).toHaveLength(1);
		expect(matchesChord(seen[0], NEW_REQUEST_CHORD)).toBe(true);
	});

	/*
	 * #3404: `Shell` drops the chord while a dialog is up, so an OS request
	 * that arrives then used to vanish. Mutation check: dispatch the chord
	 * immediately and the first assertion (nothing yet) reddens.
	 */
	it("holds New Request until the open dialog closes, then runs it once", async () => {
		const seen: KeyboardEvent[] = [];
		const listener = (event: Event) => seen.push(event as KeyboardEvent);
		window.addEventListener("keydown", listener);
		const dialog = document.createElement("div");
		dialog.setAttribute("data-slot", "dialog-content");
		dialog.setAttribute("data-state", "open");
		document.body.appendChild(dialog);
		const { open } = mounted();

		open({ kind: "newRequest" });
		expect(seen).toHaveLength(0);

		await act(async () => {
			dialog.setAttribute("data-state", "closed");
			await Promise.resolve();
		});
		window.removeEventListener("keydown", listener);
		dialog.remove();

		expect(seen).toHaveLength(1);
		expect(matchesChord(seen[0], NEW_REQUEST_CHORD)).toBe(true);
	});

	it("closes the palette first, and runs New Request once it is gone", async () => {
		const seen: KeyboardEvent[] = [];
		const listener = (event: Event) => seen.push(event as KeyboardEvent);
		window.addEventListener("keydown", listener);
		const palette = document.createElement("div");
		palette.setAttribute("data-slot", "dialog-content");
		palette.setAttribute("data-state", "open");
		document.body.appendChild(palette);
		useLayoutStore.setState({ paletteOpen: true });
		const { open } = mounted();

		open({ kind: "newRequest" });
		expect(useLayoutStore.getState().paletteOpen).toBe(false);
		expect(seen).toHaveLength(0);

		await act(async () => {
			palette.remove();
			await Promise.resolve();
		});
		window.removeEventListener("keydown", listener);

		expect(seen).toHaveLength(1);
	});

	it("drops a held New Request when the hook unmounts", async () => {
		const seen: KeyboardEvent[] = [];
		const listener = (event: Event) => seen.push(event as KeyboardEvent);
		window.addEventListener("keydown", listener);
		const dialog = document.createElement("div");
		dialog.setAttribute("data-slot", "dialog-content");
		dialog.setAttribute("data-state", "open");
		document.body.appendChild(dialog);
		const { open, unmount } = mounted();

		open({ kind: "newRequest" });
		unmount();
		await act(async () => {
			dialog.remove();
			await Promise.resolve();
		});
		window.removeEventListener("keydown", listener);

		expect(seen).toHaveLength(0);
	});

	it("opens the collection tab for a collection intent", () => {
		// Mutation check: swap `collection` for `type: "collection", entityId:
		// null` and the tab retargets instead of opening the asked-for one.
		const { open } = mounted();

		open({ kind: "collection", collectionId: "col_1" });

		const tabs = useTabsStore.getState().openTabs;
		expect(tabs).toHaveLength(1);
		expect(tabs[0]).toMatchObject({ type: "collection", entityId: "col_1" });
	});

	it("queues an import intent's path on the import modal store", () => {
		// Mutation check: call `open()` instead of `openWithFile()` and the
		// dialog opens with nothing pending, silently dropping the dropped file.
		const { open } = mounted();

		open({ kind: "import", path: "/tmp/spec.yaml" });

		const state = useImportModalStore.getState();
		expect(state.isOpen).toBe(true);
		expect(state.pendingPath).toBe("/tmp/spec.yaml");
	});

	it("unsubscribes on unmount", () => {
		const { unsubscribe, unmount } = mounted();

		unmount();

		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});

	it("is a no-op outside Electron", () => {
		bridged(null);

		expect(() => renderHook(() => useOpenIntent())).not.toThrow();
	});
});
