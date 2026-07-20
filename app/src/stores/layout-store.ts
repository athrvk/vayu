/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { STORAGE_KEYS } from "@/constants/storage-keys";
import {
	DEFAULT_CONTEXT_BAR_WIDTH,
	DEFAULT_DRAWER_WIDTH,
	PANEL_MIN_WIDTH,
	PANEL_MAX_WIDTH,
} from "@/constants/layout";

export type DrawerView = "collections" | "history" | "variables" | "settings";

interface LayoutState {
	// Drawer
	drawerOpen: boolean;
	drawerView: DrawerView;
	/** One width for every view — see DEFAULT_DRAWER_WIDTH. */
	drawerWidth: number;

	// Context bar (right panel for request tabs)
	contextBarOpen: boolean;
	contextBarWidth: number;

	// Request / response split ratio (0–1, fraction for the left/request pane)
	requestSplitRatio: number;

	// Actions
	setDrawerOpen: (open: boolean) => void;
	toggleDrawer: () => void;
	setDrawerView: (view: DrawerView) => void;
	/** Open the drawer to a specific view, or toggle it closed if already on that view */
	activateDrawerView: (view: DrawerView) => void;
	setDrawerWidth: (width: number) => void;

	setContextBarOpen: (open: boolean) => void;
	toggleContextBar: () => void;
	setContextBarWidth: (width: number) => void;

	setRequestSplitRatio: (ratio: number) => void;
}

export const useLayoutStore = create<LayoutState>()(
	persist(
		(set) => ({
			drawerOpen: true,
			drawerView: "collections",
			drawerWidth: DEFAULT_DRAWER_WIDTH,
			contextBarOpen: false,
			contextBarWidth: DEFAULT_CONTEXT_BAR_WIDTH,
			requestSplitRatio: 0.5,

			setDrawerOpen: (open) => set({ drawerOpen: open }),
			toggleDrawer: () => set((s) => ({ drawerOpen: !s.drawerOpen })),
			setDrawerView: (view) => set({ drawerView: view }),
			activateDrawerView: (view) =>
				set((s) => ({
					drawerView: view,
					drawerOpen: s.drawerView === view ? !s.drawerOpen : true,
				})),
			setDrawerWidth: (width) =>
				set({ drawerWidth: Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, width)) }),

			setContextBarOpen: (open) => set({ contextBarOpen: open }),
			toggleContextBar: () => set((s) => ({ contextBarOpen: !s.contextBarOpen })),
			setContextBarWidth: (width) =>
				set({
					contextBarWidth: Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, width)),
				}),

			setRequestSplitRatio: (ratio) =>
				set({ requestSplitRatio: Math.max(0.2, Math.min(0.8, ratio)) }),
		}),
		{
			name: STORAGE_KEYS.LAYOUT_STORE,
			version: 3,
			migrate: (persisted, version) => {
				const state = persisted as LayoutState & {
					drawerWidths?: Record<string, number>;
				};
				// v1 could persist a skewed split ratio while panel sizes were
				// misparsed as pixels — reset to an even split
				if (version < 2) state.requestSplitRatio = 0.5;
				// v2 stored a width per drawer view, which made the main content
				// resize when switching views. Collapse to a single width, keeping
				// whatever the user had set for collections (the default view).
				if (version < 3) {
					state.drawerWidth =
						state.drawerWidths?.collections ??
						state.drawerWidths?.variables ??
						DEFAULT_DRAWER_WIDTH;
					delete state.drawerWidths;
				}
				return state;
			},
			partialize: (state) => ({
				drawerOpen: state.drawerOpen,
				drawerView: state.drawerView,
				drawerWidth: state.drawerWidth,
				contextBarOpen: state.contextBarOpen,
				contextBarWidth: state.contextBarWidth,
				requestSplitRatio: state.requestSplitRatio,
			}),
		}
	)
);
