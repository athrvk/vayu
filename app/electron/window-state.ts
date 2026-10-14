/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Window State Manager
 * Persists and restores window size, position, and maximized / full-screen state
 */

import { createJsonStore } from "./json-store.js";
import { BrowserWindow, screen } from "electron";
import { WINDOW_STATE_SAVE_DEBOUNCE_MS } from "./constants.js";

interface WindowState {
	x?: number;
	y?: number;
	width: number;
	height: number;
	isMaximized: boolean;
	isFullScreen: boolean;
}

interface WindowStateOptions {
	defaultWidth: number;
	defaultHeight: number;
}

/*
 * Read before the window is built, which is before `app.whenReady` resolves on
 * a cold launch - so a corrupt window-state.json must be an empty store rather
 * than a throw, or Electron shows "A JavaScript error occurred in the main
 * process" and the app never starts, on every launch until the user finds and
 * deletes a hidden file. `createJsonStore` answers every unreadable file that
 * way; starting over is the right failure mode for a file whose only job is
 * window geometry.
 */
const store = createJsonStore<{ windowState: WindowState }>("window-state");

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/**
 * What `store.get` returns is JSON off disk, not a `WindowState` - the type
 * parameter describes what we wrote, not what is there now. A hand edit or a
 * half-finished write can leave any shape at all, and every field here is passed
 * straight to the `BrowserWindow` constructor, so `width: "abc"` reaches Electron.
 *
 * Each field falls back on its own: a default is a perfectly good value for any
 * one of them, and nothing about the geometry couples them. The exception is the
 * position, which BrowserWindow honours as a pair or not at all - so one bad axis
 * drops both and the window is centred.
 */
function sanitizeWindowState(saved: unknown, defaults: WindowState): WindowState {
	if (typeof saved !== "object" || saved === null || Array.isArray(saved)) {
		return { ...defaults };
	}

	const { x, y, width, height, isMaximized, isFullScreen } = saved as Record<string, unknown>;

	const state: WindowState = {
		width: isFiniteNumber(width) && width > 0 ? width : defaults.width,
		height: isFiniteNumber(height) && height > 0 ? height : defaults.height,
		isMaximized: typeof isMaximized === "boolean" ? isMaximized : defaults.isMaximized,
		isFullScreen: typeof isFullScreen === "boolean" ? isFullScreen : defaults.isFullScreen,
	};

	if (isFiniteNumber(x) && isFiniteNumber(y)) {
		state.x = x;
		state.y = y;
	}

	return state;
}

export function loadWindowState(options: WindowStateOptions): WindowState {
	const defaultState: WindowState = {
		width: options.defaultWidth,
		height: options.defaultHeight,
		isMaximized: false,
		isFullScreen: false,
	};

	const savedState = store.get("windowState");
	if (!savedState) {
		return defaultState;
	}

	const state = sanitizeWindowState(savedState, defaultState);

	// Validate that the saved position is still on a visible display
	if (state.x !== undefined && state.y !== undefined) {
		const displays = screen.getAllDisplays();
		const isOnDisplay = displays.some((display) => {
			const { x, y, width, height } = display.bounds;
			return state.x! >= x && state.x! < x + width && state.y! >= y && state.y! < y + height;
		});

		if (!isOnDisplay) {
			// Position is off-screen, reset to center
			delete state.x;
			delete state.y;
		}
	}

	return state;
}

function saveWindowState(window: BrowserWindow): void {
	const isFullScreen = window.isFullScreen();
	const isMaximized = window.isMaximized();
	const bounds = window.getBounds();

	if (!isFullScreen && !isMaximized) {
		store.set("windowState", {
			isMaximized: false,
			isFullScreen: false,
			x: bounds.x,
			y: bounds.y,
			width: bounds.width,
			height: bounds.height,
		});
		return;
	}

	// A maximized or full-screen window reports the display's bounds, which would
	// restore as a window the size of the screen with nothing to un-maximize back
	// to. Keep the previous normal bounds instead. They come off disk, so they get
	// the same scrubbing a load does - otherwise this re-persists whatever garbage
	// was already in the file.
	const existingState = sanitizeWindowState(store.get("windowState"), {
		width: bounds.width,
		height: bounds.height,
		isMaximized,
		isFullScreen,
	});
	store.set("windowState", {
		isMaximized,
		isFullScreen,
		x: existingState.x,
		y: existingState.y,
		width: existingState.width,
		height: existingState.height,
	});
}

export function trackWindowState(window: BrowserWindow): void {
	// Debounce resize/move to avoid excessive writes
	let saveTimeout: NodeJS.Timeout | null = null;
	const debouncedSave = () => {
		if (saveTimeout) clearTimeout(saveTimeout);
		saveTimeout = setTimeout(() => saveWindowState(window), WINDOW_STATE_SAVE_DEBOUNCE_MS);
	};

	window.on("resize", debouncedSave);
	window.on("move", debouncedSave);
	window.on("close", () => {
		if (saveTimeout) clearTimeout(saveTimeout);
		saveWindowState(window);
	});
}
