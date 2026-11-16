/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The application menu's labels, by platform (#3500).
 *
 * One template serves two surfaces: the menu bar macOS draws at the top of the
 * screen, which follows the platform's Title Case, and the menu popped from the
 * title-bar icon on Windows and Linux, which is an in-app surface and follows
 * the app's sentence case (`docs/ux-writing.md`, "Case"). `createMenu` in
 * main.ts takes every label that differs between the two from `menuLabels`.
 *
 * Kept free of Electron types for the reason `menu-accelerators.ts` gives.
 */

/** What `createMenu` labels, by the menu item that carries it. */
export interface MenuLabels {
	checkForUpdates: string;
	/** One destination, one name: macOS itself calls it Settings now. */
	settings: string;
	actualSize: string;
	zoomIn: string;
	zoomOut: string;
	scriptingGuide: string;
	reportIssue: string;
}

/** The labels for a platform (`process.platform`). */
export function menuLabels(platform: string): MenuLabels {
	if (platform === "darwin") {
		return {
			checkForUpdates: "Check for Updates…",
			settings: "Settings…",
			actualSize: "Actual Size",
			zoomIn: "Zoom In",
			zoomOut: "Zoom Out",
			scriptingGuide: "Scripting Guide",
			reportIssue: "Report an Issue",
		};
	}
	return {
		checkForUpdates: "Check for updates…",
		settings: "Settings…",
		actualSize: "Actual size",
		zoomIn: "Zoom in",
		zoomOut: "Zoom out",
		scriptingGuide: "Scripting guide",
		reportIssue: "Report an issue",
	};
}
