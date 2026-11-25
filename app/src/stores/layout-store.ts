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
	BOTTOM_PANEL_MAX_HEIGHT,
	BOTTOM_PANEL_MIN_HEIGHT,
	CONTEXT_BAR_DEFAULT_COLLAPSED,
	DEFAULT_BOTTOM_PANEL_HEIGHT,
	DEFAULT_BOTTOM_PANEL_TAB,
	DEFAULT_CONTEXT_BAR_WIDTH,
	DEFAULT_DRAWER_WIDTH,
	DEFAULT_GRAPHQL_VARIABLES_SIZE,
	DEFAULT_REQUEST_SPLIT_RATIO,
	DEFAULT_SCRIPT_EDITOR_HEIGHT,
	GRAPHQL_VARIABLES_MAX_SIZE,
	GRAPHQL_VARIABLES_MIN_SIZE,
	PANEL_MIN_WIDTH,
	PANEL_MAX_WIDTH,
	REQUEST_SPLIT_RATIO_MAX,
	REQUEST_SPLIT_RATIO_MIN,
	RETIRED_CONTEXT_BAR_SECTIONS,
	SCRIPT_EDITOR_MAX_HEIGHT,
	SCRIPT_EDITOR_MIN_HEIGHT,
	type BottomPanelTab,
} from "@/constants/layout";

export type DrawerView =
	"collections" | "history" | "variables" | "services" | "trash" | "settings";

/**
 * Where the response pane sits relative to the request (#1711). `beside` and `below` are the two
 * arrangements the builder draws; `auto` picks one from the builder's own width
 * (`useResolvedResponsePosition`). Never "horizontal" or "vertical": Postman and
 * `react-resizable-panels` use those words for opposite things, so a reader could not tell which
 * side a comment meant.
 */
export type ResponsePosition = "beside" | "below" | "auto";

/** One of the two arrangements `auto` resolves to. */
export type ResponseArrangement = Exclude<ResponsePosition, "auto">;

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
	 * Section ids the user collapsed, by exception: a section not named here is expanded. An array,
	 * not a Set: `persist` serializes with JSON, which writes a Set as `{}`, so every collapse
	 * would last only until the next launch. Storing the collapsed ones means a section added in a
	 * later release ships expanded for existing users, not invisible.
	 *
	 * `CONTEXT_BAR_DEFAULT_COLLAPSED` is the one exception, and it needs both halves: it seeds the
	 * initial state for a fresh install, and the v4 migration writes it into an existing blob.
	 * `persist` merges a missing key onto the initial state, never a missing element into an array
	 * already there, so a user who has ever collapsed anything has an array that would silently
	 * outvote the default.
	 */
	contextBarCollapsedSections: string[];

	/**
	 * `beside` by default: it is what every existing user has and what the other tools default to,
	 * so `auto` is an explicit third choice, not the new normal.
	 */
	responsePosition: ResponsePosition;

	/**
	 * What `auto` resolves to now, written by the builder's measurement
	 * (`useResolvedResponsePosition`) and read by the Dock button and `toggleResponsePosition`,
	 * which need the arrangement on screen while the setting says `auto`. Not in `partialize`: it
	 * derives from a width that does not survive a relaunch, and a stale pick would flash the wrong
	 * arrangement for the first frame.
	 */
	autoResponseArrangement: ResponseArrangement;

	/**
	 * Request / response split ratio (0-1, the request pane's share), one per arrangement: the
	 * width share a request wants beside its response is not the height share it wants above it,
	 * and one number for both made every flip undo the drag before it.
	 */
	requestSplitRatioBeside: number;
	requestSplitRatioBelow: number;

	/**
	 * Whether the GraphQL body's Variables pane is collapsed to its header, and the height (percent
	 * of the editor stack) it gets back on reopen. Here, not in `explorer-store`: that store is in
	 * memory only because an expansion set describes a schema that may not exist next launch, while
	 * this height is a layout preference that must survive a relaunch and the Radix unmount the
	 * Body tab does on every glance at Headers.
	 */
	graphqlVariablesCollapsed: boolean;
	graphqlVariablesSize: number;

	/**
	 * Whether the script editors' snippets list is collapsed to its header. One flag for both hosts
	 * (the request Script panel and the collection Script tab), because it answers one question
	 * about the person, not the surface: whether they want templates on screen while they write.
	 * Here for the GraphQL Variables pane's reason: the panel's own memory dies with the Radix
	 * unmount every tab switch does.
	 *
	 * Collapsed by default: the editor is what the panel is for, and a list open under every script
	 * editor would be the wall of prose it replaced.
	 *
	 * A default the next script row a user opens starts from, not the live state of every row on
	 * screen (#1605): the Elements tab can show a `script.pre` and a `script.post` row at once,
	 * each with its own `useState` seeded from this, so expanding one does not expand the other.
	 * Each row writes its toggle back here, so the next row starts the way the user last left one.
	 */
	scriptSnippetsCollapsed: boolean;

	/**
	 * Height (px) of a `script.pre` / `script.post` element's Monaco editor box, keyed by the
	 * element's own id (#1643): a request or collection can show both cards at once, and one shared
	 * value (like `graphqlVariablesSize`, which really is one pane) would make dragging any row's
	 * handle resize every other row. Capped at `SCRIPT_EDITOR_HEIGHTS_MAX` entries, oldest set
	 * evicted first (re-setting an id's entry moves it to the end), so years of script elements do
	 * not grow this map in localStorage without bound.
	 */
	scriptEditorHeights: Record<string, number>;

	/**
	 * Where a script row with no entry in `scriptEditorHeights` starts: the last height the user
	 * chose on any row. Every write to that map updates this too, the same "per-instance state,
	 * seeded from a shared default" shape `scriptSnippetsCollapsed` uses.
	 */
	scriptEditorHeightDefault: number;

	/**
	 * The last five element kinds added through the Add-element picker, most recent first: the
	 * picker's "Recently used" group (#1604). Kind ids, not kind schemas: the engine serves the
	 * catalogue fresh each session, so a kind it no longer registers drops out when the picker
	 * filters this list against the live catalogue at render time, with no migration here.
	 */
	recentElementKinds: string[];

	/**
	 * The bottom panel (#3635): whether it is open, how tall the user made it, and which tab shows.
	 * Closed by default: a user reaches for it, and not every window should give up height to it.
	 *
	 * `bottomPanelHeight` is the user's choice, held to the absolute bounds here; the
	 * half-the-window cap needs a window the store does not know, so the panel applies it when it
	 * draws (`clampBottomPanelHeight`) and the stored value survives a briefly small window.
	 */
	bottomPanelOpen: boolean;
	bottomPanelHeight: number;
	bottomPanelTab: BottomPanelTab;

	/**
	 * Whether the ⌘K command palette is showing. Here, not palette state, because its two openers
	 * are in different subtrees (the chord handler in `Shell`, the title bar's search bar). Not in
	 * `partialize`: a dialog that reopened on every launch is not a layout preference.
	 */
	paletteOpen: boolean;

	// Actions
	setDrawerOpen: (open: boolean) => void;
	toggleDrawer: () => void;
	setDrawerView: (view: DrawerView) => void;
	/** Open the drawer to a specific view, or toggle it closed if already on that view */
	activateDrawerView: (view: DrawerView) => void;
	/**
	 * Show a view, never hide it. `activateDrawerView` toggles when the drawer is already on that
	 * view: right for a switcher pressed twice, wrong for anything that points at a view (a palette
	 * result, a welcome tile, a status chip saying something is running). Such a caller uses this,
	 * never `activateDrawerView` or a hand-written open-then-select pair.
	 */
	revealDrawerView: (view: DrawerView) => void;
	setDrawerWidth: (width: number) => void;

	setContextBarOpen: (open: boolean) => void;
	toggleContextBar: () => void;
	setContextBarWidth: (width: number) => void;
	toggleContextBarSection: (id: string) => void;

	setResponsePosition: (position: ResponsePosition) => void;
	/**
	 * Beside <-> below. From `auto` it writes the opposite of the resolved arrangement: the user
	 * chose, so Auto is over until they pick it again in Settings.
	 */
	toggleResponsePosition: () => void;
	/** Records what `auto` resolves to right now - see `autoResponseArrangement`. */
	setAutoResponseArrangement: (arrangement: ResponseArrangement) => void;
	/** Clamped, into the ratio for the arrangement that was dragged. */
	setRequestSplitRatio: (arrangement: ResponseArrangement, ratio: number) => void;

	setGraphqlVariablesCollapsed: (collapsed: boolean) => void;
	setGraphqlVariablesSize: (size: number) => void;

	setScriptSnippetsCollapsed: (collapsed: boolean) => void;
	/** Clamps, records `id`'s own height, and updates the shared default every never-dragged row starts from. */
	setScriptEditorHeight: (id: string, height: number) => void;
	/**
	 * Copies `fromId`'s recorded height onto `toId`, so a duplicated script row (#1608) starts at
	 * its source's height, not the shared default. A no-op when the source has no entry. Leaves
	 * `scriptEditorHeightDefault` alone: copying on Duplicate is not the user setting a height.
	 */
	copyScriptEditorHeight: (fromId: string, toId: string) => void;

	/** Moves `kind` to the front of `recentElementKinds`, capped at five. */
	addRecentElementKind: (kind: string) => void;

	setBottomPanelOpen: (open: boolean) => void;
	/** The one write the Dock button, the chord and the palette row all make. */
	toggleBottomPanel: () => void;
	setBottomPanelHeight: (height: number) => void;
	setBottomPanelTab: (tab: BottomPanelTab) => void;

	setPaletteOpen: (open: boolean) => void;
}

/** Cap for `scriptEditorHeights` - see the field's own comment. */
const SCRIPT_EDITOR_HEIGHTS_MAX = 200;

function clampSplitRatio(ratio: number): number {
	return Math.max(REQUEST_SPLIT_RATIO_MIN, Math.min(REQUEST_SPLIT_RATIO_MAX, ratio));
}

/**
 * The arrangement on screen: the setting itself, or what `auto` resolves to now. A selector, not a
 * stored field, so the two cannot disagree.
 */
export function resolveResponseArrangement(
	state: Pick<LayoutState, "responsePosition" | "autoResponseArrangement">
): ResponseArrangement {
	return state.responsePosition === "auto"
		? state.autoResponseArrangement
		: state.responsePosition;
}

function clampScriptEditorHeight(height: number): number {
	return Math.max(SCRIPT_EDITOR_MIN_HEIGHT, Math.min(SCRIPT_EDITOR_MAX_HEIGHT, height));
}

/**
 * Sets `id`'s entry to `height`, moving it to the end of insertion order (the most recently set,
 * the last an eviction reaches) and evicting the oldest entry once the map would exceed
 * `SCRIPT_EDITOR_HEIGHTS_MAX`. Key order is insertion order only because element ids are `el_...`
 * strings: integer-like keys sort numerically first in JS whatever the insertion order.
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
			responsePosition: "beside",
			autoResponseArrangement: "beside",
			requestSplitRatioBeside: DEFAULT_REQUEST_SPLIT_RATIO,
			requestSplitRatioBelow: DEFAULT_REQUEST_SPLIT_RATIO,
			graphqlVariablesCollapsed: false,
			graphqlVariablesSize: DEFAULT_GRAPHQL_VARIABLES_SIZE,
			scriptSnippetsCollapsed: true,
			scriptEditorHeights: {},
			scriptEditorHeightDefault: DEFAULT_SCRIPT_EDITOR_HEIGHT,
			recentElementKinds: [],
			bottomPanelOpen: false,
			bottomPanelHeight: DEFAULT_BOTTOM_PANEL_HEIGHT,
			bottomPanelTab: DEFAULT_BOTTOM_PANEL_TAB,
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

			setResponsePosition: (position) => set({ responsePosition: position }),
			toggleResponsePosition: () =>
				set((s) => ({
					responsePosition:
						resolveResponseArrangement(s) === "beside" ? "below" : "beside",
				})),
			setAutoResponseArrangement: (arrangement) =>
				set({ autoResponseArrangement: arrangement }),
			setRequestSplitRatio: (arrangement, ratio) =>
				set(
					arrangement === "beside"
						? { requestSplitRatioBeside: clampSplitRatio(ratio) }
						: { requestSplitRatioBelow: clampSplitRatio(ratio) }
				),

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

			setBottomPanelOpen: (open) => set({ bottomPanelOpen: open }),
			toggleBottomPanel: () => set((s) => ({ bottomPanelOpen: !s.bottomPanelOpen })),
			setBottomPanelHeight: (height) =>
				set({
					bottomPanelHeight: Math.max(
						BOTTOM_PANEL_MIN_HEIGHT,
						Math.min(BOTTOM_PANEL_MAX_HEIGHT, height)
					),
				}),
			setBottomPanelTab: (tab) => set({ bottomPanelTab: tab }),

			setPaletteOpen: (open) => set({ paletteOpen: open }),
		}),
		{
			name: STORAGE_KEYS.LAYOUT_STORE,
			version: 7,
			migrate: (persisted, version) => {
				const state = persisted as LayoutState & {
					drawerWidths?: Record<string, number>;
					scriptEditorHeight?: number;
					requestSplitRatio?: number;
				};
				// v1 could persist a skewed split ratio while panel sizes were
				// misparsed as pixels - reset to an even split
				if (version < 2) state.requestSplitRatio = 0.5;
				// v2 stored a width per drawer view, so the main content resized on a view switch.
				// One width now, kept from collections (the default view).
				if (version < 3) {
					state.drawerWidth =
						state.drawerWidths?.collections ??
						state.drawerWidths?.variables ??
						DEFAULT_DRAWER_WIDTH;
					delete state.drawerWidths;
				}
				// v3 opened every section on every request tab. `code` composes a snippet over the
				// network on mount, a round trip per tab nobody asked for, so it starts collapsed
				// and composes when opened. Written into the array, not left to the initial state,
				// because `persist` merges a missing key, not a missing element (see the field).
				// `environment` goes too: its section is gone, and an id for a section that does
				// not exist should not outlive it.
				if (version < 4) {
					const collapsed = Array.isArray(state.contextBarCollapsedSections)
						? state.contextBarCollapsedSections
						: [];
					state.contextBarCollapsedSections = [
						...collapsed.filter((id) => !RETIRED_CONTEXT_BAR_SECTIONS.includes(id)),
						...CONTEXT_BAR_DEFAULT_COLLAPSED.filter((id) => !collapsed.includes(id)),
					];
				}
				// v4 kept one scriptEditorHeight for every script row (#1643), so dragging one
				// row's handle resized them all. Split into a per-id map plus the shared default a
				// never-dragged row starts from: the old value becomes that default (clamped, as a
				// stale blob can predate today's bounds), and the map starts empty, since one
				// number cannot say which element it was set on.
				if (version < 5) {
					state.scriptEditorHeightDefault =
						typeof state.scriptEditorHeight === "number"
							? clampScriptEditorHeight(state.scriptEditorHeight)
							: DEFAULT_SCRIPT_EDITOR_HEIGHT;
					state.scriptEditorHeights = {};
					delete state.scriptEditorHeight;
				}
				// v5 had one split ratio and one arrangement (#1711). The user's ratio was set
				// beside, so it becomes the Beside ratio; Below starts even, and the position stays
				// Beside: an upgrade must not re-arrange the builder under anyone.
				if (version < 6) {
					state.requestSplitRatioBeside =
						typeof state.requestSplitRatio === "number"
							? clampSplitRatio(state.requestSplitRatio)
							: DEFAULT_REQUEST_SPLIT_RATIO;
					state.requestSplitRatioBelow = DEFAULT_REQUEST_SPLIT_RATIO;
					state.responsePosition = "beside";
					delete state.requestSplitRatio;
				}
				// v6 had no bottom panel (#3635). `persist` would fill the missing keys from the
				// initial state; writing them here keeps every step stating what it adds.
				if (version < 7) {
					state.bottomPanelOpen = false;
					state.bottomPanelHeight = DEFAULT_BOTTOM_PANEL_HEIGHT;
					state.bottomPanelTab = DEFAULT_BOTTOM_PANEL_TAB;
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
				responsePosition: state.responsePosition,
				requestSplitRatioBeside: state.requestSplitRatioBeside,
				requestSplitRatioBelow: state.requestSplitRatioBelow,
				graphqlVariablesCollapsed: state.graphqlVariablesCollapsed,
				graphqlVariablesSize: state.graphqlVariablesSize,
				scriptSnippetsCollapsed: state.scriptSnippetsCollapsed,
				scriptEditorHeights: state.scriptEditorHeights,
				scriptEditorHeightDefault: state.scriptEditorHeightDefault,
				recentElementKinds: state.recentElementKinds,
				bottomPanelOpen: state.bottomPanelOpen,
				bottomPanelHeight: state.bottomPanelHeight,
				bottomPanelTab: state.bottomPanelTab,
			}),
		}
	)
);
