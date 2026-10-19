/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Whether an IPC message came from the app window's own top-level document.
 *
 * Every window the app opens carries the preload, and so does every frame
 * inside one, so a channel being reachable says nothing about who used it. The
 * channels that change what a request may read from disk (#2356) accept a
 * message only from the main frame of the main window's `webContents`: not a
 * child window, not an iframe, not a frame the window has since navigated
 * away from.
 *
 * Structural rather than Electron's types, so a test can build both sides; in
 * production `event` is an `IpcMainEvent` or `IpcMainInvokeEvent` and `window`
 * the live `BrowserWindow`. Electron hands out one `WebFrameMain` per frame,
 * so identity is the comparison.
 */

export interface IpcSenderLike {
	sender: unknown;
	/** Null once the frame has navigated or been destroyed. */
	senderFrame?: unknown;
}

export interface AppWindowLike {
	webContents: { mainFrame: unknown };
}

export function isFromAppMainFrame(event: IpcSenderLike, window: AppWindowLike | null): boolean {
	if (!window) return false;
	const frame = event.senderFrame;
	if (frame === null || frame === undefined) return false;
	return event.sender === window.webContents && frame === window.webContents.mainFrame;
}
