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
	DEFAULT_GRAPHQL_VARIABLES_SIZE,
	GRAPHQL_VARIABLES_MAX_SIZE,
	GRAPHQL_VARIABLES_MIN_SIZE,
	PANEL_MIN_WIDTH,
	PANEL_MAX_WIDTH,
} from "@/constants/layout";

export type DrawerView = "collections" | "history" | "variables" | "services" | "settings";

interface LayoutState {
	// Drawer
	drawerOpen: boolean;
	drawerView: DrawerView;
	/** One width for every view - see DEFAULT_DRAWER_WIDTH. */
	drawerWidth: number;

	// Context bar (right panel for request tabs)
	contextBarOpen: boolean;
	contextBarWidth: number;
	/**
	 * Section ids the user has collapsed, by exception - a section not named
	 * here is expanded.
	 *
	 * An array rather than a Set because `persist` serializes with JSON, which
	 * writes a Set as `{}` and reads it back as one, so every collapse would
	 * survive exactly until the next launch. Storing the collapsed ones rather
	 * than the expanded ones also means a section added in a later release
	 * ships expanded for existing users instead of invisible.
	 */
	contextBarCollapsedSections: string[];

	// Request / response split ratio (0–1, fraction for the left/request pane)
	requestSplitRatio: number;

	/**
	 * Whether the GraphQL body's Variables pane is collapsed to its header, and
	 * the height (percent of the editor stack) to give it back when it reopens.
	 *
	 * Here rather than in `explorer-store` for the reason that store states about
	 * itself: an expansion set describes a schema that may not exist next launch,
	 * so it is deliberately in memory only. How tall a user wants their variables
	 * pane is a layout preference like every other one in this file, and it has
	 * to survive both a relaunch and the Radix unmount the Body tab does on every
	 * glance at Headers.
	 */
	graphqlVariablesCollapsed: boolean;
	graphqlVariablesSize: number;

	/**
	 * Whether the ⌘K command palette is showing.
	 *
	 * Here rather than as local state in the palette because the two things that
	 * open it are in different subtrees: the chord handler in `Shell`, and the
	 * title bar's search bar. Deliberately absent from `partialize` - a dialog
	 * that reopened itself on every launch is not a layout preference.
	 */
	paletteOpen: boolean;

	// Actions
	setDrawerOpen: (open: boolean) => void;
	toggleDrawer: () => void;
	setDrawerView: (view: DrawerView) => void;
	/** Open the drawer to a specific view, or toggle it closed if already on that view */
	activateDrawerView: (view: DrawerView) => void;
	/**
	 * Show a view, never hide it - the non-toggling half of the pair above.
	 *
	 * `activateDrawerView` toggles when the drawer is already on that view,
	 * which is right for a switcher pressed twice and wrong for anything that
	 * *points at* a view: a palette result, or an ambient status chip that says
	 * something is running. Both of those had hand-rolled the pair
	 * (`setDrawerOpen(true)` then `setDrawerView`), and the Dock's
	 * running-services indicator had not - so clicking it with the drawer
	 * already on Services closed the one surface that could act on them.
	 */
	revealDrawerView: (view: DrawerView) => void;
	setDrawerWidth: (width: number) => void;

	setContextBarOpen: (open: boolean) => void;
	toggleContextBar: () => void;
	setContextBarWidth: (width: number) => void;
	toggleContextBarSection: (id: string) => void;

	setRequestSplitRatio: (ratio: number) => void;

	setGraphqlVariablesCollapsed: (collapsed: boolean) => void;
	setGraphqlVariablesSize: (size: number) => void;

	setPaletteOpen: (open: boolean) => void;
}

export const useLayoutStore = create<LayoutState>()(
	persist(
		(set) => ({
			drawerOpen: true,
			drawerView: "collections",
			drawerWidth: DEFAULT_DRAWER_WIDTH,
			contextBarOpen: false,
			contextBarWidth: DEFAULT_CONTEXT_BAR_WIDTH,
			contextBarCollapsedSections: [],
			requestSplitRatio: 0.5,
			graphqlVariablesCollapsed: false,
			graphqlVariablesSize: DEFAULT_GRAPHQL_VARIABLES_SIZE,
			paletteOpen: false,

			setDrawerOpen: (open) => set({ drawerOpen: open }),
			toggleDrawer: () => set((s) => ({ drawerOpen: !s.drawerOpen })),
			setDrawerView: (view) => set({ drawerView: view }),
			activateDrawerView: (view) =>
				set((s) => ({
					drawerView: view,
					drawerOpen: s.drawerView === view ? !s.drawerOpen : true,
				})),
			revealDrawerView: (view) => set({ drawerView: view, drawerOpen: true }),
			setDrawerWidth: (width) =>
				set({ drawerWidth: Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, width)) }),

			setContextBarOpen: (open) => set({ contextBarOpen: open }),
			toggleContextBar: () => set((s) => ({ contextBarOpen: !s.contextBarOpen })),
			setContextBarWidth: (width) =>
				set({
					contextBarWidth: Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, width)),
				}),
			toggleContextBarSection: (id) =>
				set((s) => ({
					contextBarCollapsedSections: s.contextBarCollapsedSections.includes(id)
						? s.contextBarCollapsedSections.filter((s2) => s2 !== id)
						: [...s.contextBarCollapsedSections, id],
				})),

			setRequestSplitRatio: (ratio) =>
				set({ requestSplitRatio: Math.max(0.2, Math.min(0.8, ratio)) }),

			setGraphqlVariablesCollapsed: (collapsed) =>
				set({ graphqlVariablesCollapsed: collapsed }),
			/*
			 * Clamped to the pane's own bounds, so a size recorded while the pane
			 * was mid-collapse cannot come back as a height the panel refuses.
			 */
			setGraphqlVariablesSize: (size) =>
				set({
					graphqlVariablesSize: Math.max(
						GRAPHQL_VARIABLES_MIN_SIZE,
						Math.min(GRAPHQL_VARIABLES_MAX_SIZE, size)
					),
				}),

			setPaletteOpen: (open) => set({ paletteOpen: open }),
		}),
		{
			name: STORAGE_KEYS.LAYOUT_STORE,
			version: 3,
			migrate: (persisted, version) => {
				const state = persisted as LayoutState & {
					drawerWidths?: Record<string, number>;
				};
				// v1 could persist a skewed split ratio while panel sizes were
				// misparsed as pixels - reset to an even split
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
				contextBarCollapsedSections: state.contextBarCollapsedSections,
				requestSplitRatio: state.requestSplitRatio,
				graphqlVariablesCollapsed: state.graphqlVariablesCollapsed,
				graphqlVariablesSize: state.graphqlVariablesSize,
			}),
		}
	)
);
