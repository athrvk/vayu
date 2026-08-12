/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useEffect } from "react";
import { useAppearanceStore } from "@/stores";
import { baseCommandContext, commandById } from "@/lib/commands";

/**
 * Bridges native menu items (Preferences… / Settings, View → zoom) to in-app
 * state. No-op outside Electron.
 *
 * Preferences… points at the `open-settings` command rather than repeating its
 * two lines, so the menu and the palette cannot drift into opening settings
 * differently - the whole reason `lib/commands` exists.
 *
 * Zoom lives here rather than in `useAppearance` because this hook is mounted
 * exactly once, in `App`: `useAppearance` runs in the Appearance panel too, and
 * a second subscription would move the scale two steps per keypress.
 */
export function useMenuActions(): void {
	useEffect(() => {
		// Optional-chain the call too: an older preload build may not expose
		// onOpenSettings yet, and `?.` on electronAPI alone wouldn't guard that.
		return window.electronAPI?.onOpenSettings?.(() =>
			commandById("open-settings").perform(baseCommandContext())
		);
	}, []);

	useEffect(() => {
		// The menu no longer zooms Chromium itself - it nudges the persisted
		// interface-scale setting, which then applies the zoom. That is what
		// keeps a keyboard zoom across a restart and stops the Appearance panel
		// from describing a size the window is not drawn at.
		return window.electronAPI?.onZoomCommand?.((command) => {
			const { nudgeScale, resetScale } = useAppearanceStore.getState();
			if (command === "reset") resetScale();
			else nudgeScale(command === "in" ? 1 : -1);
		});
	}, []);
}
