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
	CONTEXT_BAR_DEFAULT_COLLAPSED,
	DEFAULT_CONTEXT_BAR_WIDTH,
	DEFAULT_DRAWER_WIDTH,
	DEFAULT_GRAPHQL_VARIABLES_SIZE,
	DEFAULT_SCRIPT_EDITOR_HEIGHT,
	GRAPHQL_VARIABLES_MAX_SIZE,
	GRAPHQL_VARIABLES_MIN_SIZE,
	PANEL_MIN_WIDTH,
	PANEL_MAX_WIDTH,
	RETIRED_CONTEXT_BAR_SECTIONS,
	SCRIPT_EDITOR_MAX_HEIGHT,
	SCRIPT_EDITOR_MIN_HEIGHT,
} from "@/constants/layout";

export type DrawerView =
	"collections" | "history" | "variables" | "services" | "trash" | "settings";

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
	 *
	 * `CONTEXT_BAR_DEFAULT_COLLAPSED` is the one exception to that, and it needs
	 * both halves below to land: it seeds the initial state for a fresh install,
	 * and the v4 migration writes it into an existing blob. Neither alone is
	 * enough - `persist` merges a *missing key* onto the initial state, never a
	 * missing element into an array that is already there, so a user who has ever
	 * collapsed anything has an array that would silently outvote the default.
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
	 * Whether the script editors' snippets list is collapsed to its header.
	 *
	 * One flag for both hosts - the request Script panel and the collection
	 * Script tab - because it answers one question about the person, not about
	 * the surface: whether they want templates on screen while they write. It is
	 * here for the same reason the GraphQL Variables pane's collapse is: the
	 * panel's own memory dies with the Radix unmount every tab switch does.
	 *
	 * Collapsed by default. The editor is what the panel is for, and a list that
	 * opened itself under every script editor would be the wall of prose it
	 * replaced, with a chevron on it.
	 *
	 * This is a *default* the next script row a user opens starts from, not the
	 * live state of every row on screen (issue #1605): the Elements tab can show
	 * a `script.pre` and a `script.post` row on one screen, each with its own
	 * `useState` seeded from this value, so expanding one no longer expands the
	 * other. Each row writes its own toggle back here, which is what makes the
	 * *next* row a user opens start the way they last left one.
	 */
	scriptSnippetsCollapsed: boolean;

	/**
	 * Height (px) of a `script.pre` / `script.post` element's Monaco editor box,
	 * keyed by the element's own id (issue #1643).
	 *
	 * A single shared value here (like `graphqlVariablesSize`, which really is
	 * one pane) used to mean dragging *any* script row's handle silently
	 * resized every other script row too - a request or collection can show a
	 * `script.pre` and a `script.post` card on screen at once, each its own
	 * element. Capped at `SCRIPT_EDITOR_HEIGHTS_MAX` entries, oldest *set*
	 * evicted first (re-setting an id's own entry counts as setting it now, so
	 * it moves to the end): a collection with years of script elements should
	 * not grow this map without bound in localStorage.
	 */
	scriptEditorHeights: Record<string, number>;

	/**
	 * The height a script row with no entry of its own in `scriptEditorHeights`
	 * starts at - the last height the user chose on *any* row. Every write to
	 * the map above updates this too, the same "per-instance state, seeded from
	 * a shared default" shape `scriptSnippetsCollapsed` uses for its own row's
	 * disclosure.
	 */
	scriptEditorHeightDefault: number;

	/**
	 * The last five element kinds added through the Add-element picker, most
	 * recent first - the picker's own "Recently used" group (issue #1604).
	 *
	 * Kind ids, not kind schemas: the catalogue is served fresh from the engine
	 * every session, so a kind the engine no longer registers just drops out
	 * when the picker filters this list against the live catalogue at render
	 * time, rather than this store needing its own migration for it.
	 */
	recentElementKinds: string[];

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

	setScriptSnippetsCollapsed: (collapsed: boolean) => void;
	/** Clamps, records `id`'s own height, and updates the shared default every never-dragged row starts from. */
	setScriptEditorHeight: (id: string, height: number) => void;
	/**
	 * Copies `fromId`'s recorded height onto `toId` - a duplicated script row
	 * (issue #1608) starts at its source's height rather than falling back to
	 * the shared default. A no-op when the source has no entry of its own.
	 * Deliberately leaves `scriptEditorHeightDefault` untouched: copying on
	 * Duplicate is not the user setting a height anywhere.
	 */
	copyScriptEditorHeight: (fromId: string, toId: string) => void;

	/** Moves `kind` to the front of `recentElementKinds`, capped at five. */
	addRecentElementKind: (kind: string) => void;

	setPaletteOpen: (open: boolean) => void;
}

/** Cap for `scriptEditorHeights` - see the field's own comment. */
const SCRIPT_EDITOR_HEIGHTS_MAX = 200;

function clampScriptEditorHeight(height: number): number {
	return Math.max(SCRIPT_EDITOR_MIN_HEIGHT, Math.min(SCRIPT_EDITOR_MAX_HEIGHT, height));
}

/**
 * Sets `id`'s entry to `height`, moving it to the end of insertion order (the
 * "least recently set" position an eviction should spare) and evicting the
 * oldest entry once the map would exceed `SCRIPT_EDITOR_HEIGHTS_MAX`. Object
 * key order is insertion order here only because element ids are `el_...`
 * strings, never integer-like - integer-like keys sort numerically first in
 * JS regardless of insertion order.
 */
function withScriptEditorHeight(
	heights: Record<string, number>,
	id: string,
	height: number
): Record<string, number> {
	const next = { ...heights };
	delete next[id];
	next[id] = height;
	const keys = Object.keys(next);
	if (keys.length > SCRIPT_EDITOR_HEIGHTS_MAX) delete next[keys[0]];
	return next;
}

export const useLayoutStore = create<LayoutState>()(
	persist(
		(set) => ({
			drawerOpen: true,
			drawerView: "collections",
			drawerWidth: DEFAULT_DRAWER_WIDTH,
			contextBarOpen: false,
			contextBarWidth: DEFAULT_CONTEXT_BAR_WIDTH,
			contextBarCollapsedSections: [...CONTEXT_BAR_DEFAULT_COLLAPSED],
			requestSplitRatio: 0.5,
			graphqlVariablesCollapsed: false,
			graphqlVariablesSize: DEFAULT_GRAPHQL_VARIABLES_SIZE,
			scriptSnippetsCollapsed: true,
			scriptEditorHeights: {},
			scriptEditorHeightDefault: DEFAULT_SCRIPT_EDITOR_HEIGHT,
			recentElementKinds: [],
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

			setScriptSnippetsCollapsed: (collapsed) => set({ scriptSnippetsCollapsed: collapsed }),
			setScriptEditorHeight: (id, height) =>
				set((s) => {
					const clamped = clampScriptEditorHeight(height);
					return {
						scriptEditorHeights: withScriptEditorHeight(
							s.scriptEditorHeights,
							id,
							clamped
						),
						scriptEditorHeightDefault: clamped,
					};
				}),
			copyScriptEditorHeight: (fromId, toId) =>
				set((s) => {
					const source = s.scriptEditorHeights[fromId];
					return source === undefined
						? {}
						: {
								scriptEditorHeights: withScriptEditorHeight(
									s.scriptEditorHeights,
									toId,
									source
								),
							};
				}),

			addRecentElementKind: (kind) =>
				set((s) => ({
					recentElementKinds: [
						kind,
						...s.recentElementKinds.filter((k) => k !== kind),
					].slice(0, 5),
				})),

			setPaletteOpen: (open) => set({ paletteOpen: open }),
		}),
		{
			name: STORAGE_KEYS.LAYOUT_STORE,
			version: 5,
			migrate: (persisted, version) => {
				const state = persisted as LayoutState & {
					drawerWidths?: Record<string, number>;
					scriptEditorHeight?: number;
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
				// v3 opened every section on every request tab. `code` composes a
				// snippet over the network as soon as it mounts, so the bar spent a
				// round trip per tab on something nobody had asked to see; it now
				// starts collapsed and composes when it is opened. Written into the
				// array rather than left to the initial state because `persist`
				// merges a missing key, not a missing element - see the field's own
				// comment. `environment` goes at the same time: the section is gone,
				// and an id for a section that does not exist should not outlive it.
				if (version < 4) {
					const collapsed = Array.isArray(state.contextBarCollapsedSections)
						? state.contextBarCollapsedSections
						: [];
					state.contextBarCollapsedSections = [
						...collapsed.filter((id) => !RETIRED_CONTEXT_BAR_SECTIONS.includes(id)),
						...CONTEXT_BAR_DEFAULT_COLLAPSED.filter((id) => !collapsed.includes(id)),
					];
				}
				// v4 kept one scriptEditorHeight for every script row (issue #1643):
				// dragging any one row's resize handle silently resized every other
				// one too. Split into a per-id map plus the shared default a
				// never-dragged row starts from; the one old value becomes that
				// default (clamped - a stale blob could predate today's bounds), and
				// the map starts empty since a single old number cannot say which of
				// a user's script elements they had set it while looking at.
				if (version < 5) {
					state.scriptEditorHeightDefault =
						typeof state.scriptEditorHeight === "number"
							? clampScriptEditorHeight(state.scriptEditorHeight)
							: DEFAULT_SCRIPT_EDITOR_HEIGHT;
					state.scriptEditorHeights = {};
					delete state.scriptEditorHeight;
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
				scriptSnippetsCollapsed: state.scriptSnippetsCollapsed,
				scriptEditorHeights: state.scriptEditorHeights,
				scriptEditorHeightDefault: state.scriptEditorHeightDefault,
				recentElementKinds: state.recentElementKinds,
			}),
		}
	)
);
