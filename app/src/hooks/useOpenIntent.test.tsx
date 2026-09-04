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
import { renderHook } from "@testing-library/react";
import { useTabsStore, useImportModalStore } from "@/stores";
import type { OpenIntent } from "@/types/electron";

const performSpy = vi.fn();
const BASE_CTX = { marker: "base-ctx" };

vi.mock("@/lib/commands", () => ({
	baseCommandContext: () => BASE_CTX,
	commandById: vi.fn(() => ({ perform: performSpy })),
}));

import { commandById } from "@/lib/commands";
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
	performSpy.mockClear();
	vi.mocked(commandById).mockClear();
});

describe("useOpenIntent", () => {
	it("runs the new-request command through the registry, not a second way", () => {
		// Through the command rather than a store call of its own - the same
		// reasoning `useNotificationActivation` gives for opening Settings - so
		// the palette, the menu and this cannot drift apart on what "new
		// request" means.
		const { open } = mounted();

		open({ kind: "newRequest" });

		expect(commandById).toHaveBeenCalledWith("new-request");
		expect(performSpy).toHaveBeenCalledWith(BASE_CTX);
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
