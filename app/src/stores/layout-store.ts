/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { STORAGE_KEYS } from "@/constants/storage-keys";

export type DrawerView = "collections" | "history" | "variables";

const DEFAULT_DRAWER_WIDTHS: Record<DrawerView, number> = {
	collections: 260,
	history: 320,
	variables: 260,
};

interface LayoutState {
	// Drawer
	drawerOpen: boolean;
	drawerView: DrawerView;
	drawerWidths: Record<DrawerView, number>;

	// Context bar (right panel for request tabs)
	contextBarOpen: boolean;

	// Request / response split ratio (0–1, fraction for the left/request pane)
	requestSplitRatio: number;

	// Actions
	setDrawerOpen: (open: boolean) => void;
	toggleDrawer: () => void;
	setDrawerView: (view: DrawerView) => void;
	/** Open the drawer to a specific view, or toggle it closed if already on that view */
	activateDrawerView: (view: DrawerView) => void;
	setDrawerWidth: (view: DrawerView, width: number) => void;

	setContextBarOpen: (open: boolean) => void;
	toggleContextBar: () => void;

	setRequestSplitRatio: (ratio: number) => void;
}

export const useLayoutStore = create<LayoutState>()(
	persist(
		(set) => ({
			drawerOpen: true,
			drawerView: "collections",
			drawerWidths: { ...DEFAULT_DRAWER_WIDTHS },
			contextBarOpen: false,
			requestSplitRatio: 0.5,

			setDrawerOpen: (open) => set({ drawerOpen: open }),
			toggleDrawer: () => set((s) => ({ drawerOpen: !s.drawerOpen })),
			setDrawerView: (view) => set({ drawerView: view }),
			activateDrawerView: (view) =>
				set((s) => ({
					drawerView: view,
					drawerOpen: s.drawerView === view ? !s.drawerOpen : true,
				})),
			setDrawerWidth: (view, width) =>
				set((s) => ({
					drawerWidths: {
						...s.drawerWidths,
						[view]: Math.max(220, Math.min(480, width)),
					},
				})),

			setContextBarOpen: (open) => set({ contextBarOpen: open }),
			toggleContextBar: () => set((s) => ({ contextBarOpen: !s.contextBarOpen })),

			setRequestSplitRatio: (ratio) =>
				set({ requestSplitRatio: Math.max(0.2, Math.min(0.8, ratio)) }),
		}),
		{
			name: STORAGE_KEYS.LAYOUT_STORE,
			version: 1,
			partialize: (state) => ({
				drawerOpen: state.drawerOpen,
				drawerView: state.drawerView,
				drawerWidths: state.drawerWidths,
				contextBarOpen: state.contextBarOpen,
				requestSplitRatio: state.requestSplitRatio,
			}),
		}
	)
);
