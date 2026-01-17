
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Window State Manager
 * Persists and restores window size, position, and maximized state
 */

import Store from "electron-store";
import { BrowserWindow, screen } from "electron";

interface WindowState {
	x?: number;
	y?: number;
	width: number;
	height: number;
	isMaximized: boolean;
}

interface WindowStateOptions {
	defaultWidth: number;
	defaultHeight: number;
}

const store = new Store<{ windowState: WindowState }>({
	name: "window-state",
});

export function loadWindowState(options: WindowStateOptions): WindowState {
	const defaultState: WindowState = {
		width: options.defaultWidth,
		height: options.defaultHeight,
		isMaximized: false,
	};

	const savedState = store.get("windowState");
	if (!savedState) {
		return defaultState;
	}

	// Validate that the saved position is still on a visible display
	if (savedState.x !== undefined && savedState.y !== undefined) {
		const displays = screen.getAllDisplays();
		const isOnDisplay = displays.some((display) => {
			const { x, y, width, height } = display.bounds;
			return (
				savedState.x! >= x &&
				savedState.x! < x + width &&
				savedState.y! >= y &&
				savedState.y! < y + height
			);
		});

		if (!isOnDisplay) {
			// Position is off-screen, reset to center
			delete savedState.x;
			delete savedState.y;
		}
	}

	return { ...defaultState, ...savedState };
}

export function saveWindowState(window: BrowserWindow): void {
	const isMaximized = window.isMaximized();
	const bounds = window.getBounds();

	let state: WindowState;

	if (isMaximized) {
		// When maximized, preserve the previous non-maximized bounds
		const existingState = store.get("windowState");
		state = {
			isMaximized: true,
			x: existingState?.x,
			y: existingState?.y,
			width: existingState?.width ?? bounds.width,
			height: existingState?.height ?? bounds.height,
		};
	} else {
		// Save current bounds when not maximized
		state = {
			isMaximized: false,
			x: bounds.x,
			y: bounds.y,
			width: bounds.width,
			height: bounds.height,
		};
	}

	store.set("windowState", state);
}

export function trackWindowState(window: BrowserWindow): void {
	// Save state on these events
	const events: Array<"resize" | "move" | "close"> = ["resize", "move", "close"];

	// Debounce resize/move to avoid excessive writes
	let saveTimeout: NodeJS.Timeout | null = null;
	const debouncedSave = () => {
		if (saveTimeout) clearTimeout(saveTimeout);
		saveTimeout = setTimeout(() => saveWindowState(window), 500);
	};

	window.on("resize", debouncedSave);
	window.on("move", debouncedSave);
	window.on("close", () => {
		if (saveTimeout) clearTimeout(saveTimeout);
		saveWindowState(window);
	});
}
