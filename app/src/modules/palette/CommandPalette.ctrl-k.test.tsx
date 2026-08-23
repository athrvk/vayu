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
 * ⌘K opens the palette on macOS; Ctrl+K there belongs to the text field.
 *
 * This listener is on the capture phase - deliberately, because Monaco eats the
 * key on the bubble - and it matched *either* modifier, so on macOS it took
 * Ctrl+K out of every input and editor in the app before the focused control
 * saw it (#938). Ctrl+K on macOS is Cocoa's kill-to-end-of-line, implemented by
 * every native text field and by Monaco as `deleteAllRight`; a user deleting to
 * end of line got a palette instead, and lost their caret.
 *
 * Both branches, per the repo rule. `isMac` is decided at import, so each case
 * resets the module registry and re-imports the palette with Electron's
 * reported platform stubbed - the same authority the real renderer reads.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("./PaletteResults", () => ({ PaletteResults: () => <div data-testid="results" /> }));
vi.mock("./useCommandSurfaces", () => ({
	useCommandSurfaces: () => ({
		surfaces: {},
		pickerProps: { open: false, onOpenChange: () => {} },
		runTarget: null,
		dismissRunDialog: () => {},
	}),
}));
vi.mock("@/hooks/useCommandContext", () => ({ useCommandContext: () => ({}) }));
vi.mock("@/modules/collections/RunCollectionDialog", () => ({ default: () => null }));
vi.mock("@/modules/welcome/components/CollectionPicker", () => ({
	CollectionPicker: () => null,
}));

/** Mount the palette fresh, with the platform Electron reports forced. */
async function mountOn(platform: "darwin" | "linux") {
	vi.resetModules();
	// Only `platform` is read here, so the stub is that one field cast in -
	// `ElectronAPI` is 35 methods this listener never touches.
	(window as unknown as { electronAPI: { platform: string } }).electronAPI = { platform };
	const { CommandPalette } = await import("./CommandPalette");
	const { useLayoutStore } = await import("@/stores");
	useLayoutStore.setState({ paletteOpen: false });
	const view = render(
		<QueryClientProvider client={new QueryClient()}>
			<CommandPalette />
			<input aria-label="a field" defaultValue="type here" autoFocus />
		</QueryClientProvider>
	);
	return { view, useLayoutStore, field: view.getByLabelText("a field") };
}

/** Returns whether the palette's capture listener claimed the press. */
function pressK(target: Element, mods: { meta?: boolean; ctrl?: boolean }) {
	return !fireEvent.keyDown(target, {
		key: "k",
		code: "KeyK",
		metaKey: !!mods.meta,
		ctrlKey: !!mods.ctrl,
		bubbles: true,
	});
}

afterEach(() => {
	cleanup();
	delete (window as Window & { electronAPI?: unknown }).electronAPI;
	vi.resetModules();
});

describe("on macOS", () => {
	it("opens on ⌘K", async () => {
		const { useLayoutStore, field } = await mountOn("darwin");
		expect(pressK(field, { meta: true })).toBe(true);
		expect(useLayoutStore.getState().paletteOpen).toBe(true);
	});

	it("lets Ctrl+K through to the field, where it is kill-to-end-of-line", async () => {
		const { useLayoutStore, field } = await mountOn("darwin");
		expect(pressK(field, { ctrl: true })).toBe(false);
		expect(useLayoutStore.getState().paletteOpen).toBe(false);
	});
});

describe("off macOS", () => {
	it("opens on Ctrl+K", async () => {
		const { useLayoutStore, field } = await mountOn("linux");
		expect(pressK(field, { ctrl: true })).toBe(true);
		expect(useLayoutStore.getState().paletteOpen).toBe(true);
	});

	it("leaves Super+K to the window manager", async () => {
		const { useLayoutStore, field } = await mountOn("linux");
		expect(pressK(field, { meta: true })).toBe(false);
		expect(useLayoutStore.getState().paletteOpen).toBe(false);
	});
});
