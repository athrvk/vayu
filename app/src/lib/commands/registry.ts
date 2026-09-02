/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The command registry - every action the app offers by name, declared once.
 *
 * Before this, an action's definition was wherever it happened to be invoked
 * from: "open settings" existed in the native-menu bridge, in the Dock, in the
 * settings sidebar and in a keydown case, each a separate spelling of the same
 * intent. Nothing kept them in step, and nothing could enumerate them - which is
 * why the palette could not offer "do Y" at all.
 *
 * The rule this file exists to enforce: **a new user-facing action is declared
 * here, and its surfaces point at it.** A menu item, a tile or a palette row is
 * a way of reaching a command, never a second definition of one.
 *
 * Each `perform` calls the very function the pre-existing surface calls, so a
 * command is a pointer rather than a reimplementation. The settings roster is
 * generated from the two settings registries for the same reason: a category
 * added there appears here without an edit, and cannot be named differently.
 */

// `Zap` is the load-test mark throughout the app - the dashboard tab, a finished
// load run in the strip (`tab-descriptors.ts`). The palette uses the same bolt.
import {
	Download,
	PanelLeft,
	PanelRight,
	Play,
	Plus,
	Save,
	Settings,
	SunMoon,
	X,
	Zap,
} from "lucide-react";
import {
	CLOSE_TAB_CHORD,
	DRAWER_VIEW_CHORDS,
	LOAD_TEST_CHORD,
	NEW_REQUEST_CHORD,
	SAVE_CHORD,
	SETTINGS_CHORD,
	TOGGLE_CONTEXT_BAR_CHORD,
	TOGGLE_DRAWER_CHORD,
} from "@/constants/shortcuts";
import { DRAWER_VIEWS } from "@/constants/drawer-views";
import { useImportModalStore, useLayoutStore, useSaveStore, useTabsStore } from "@/stores";
import { useSettingsStore } from "@/modules/settings/settings-store";
import { APP_SETTINGS_PANELS } from "@/modules/settings/main/app-panels";
import { ENGINE_SETTINGS_CATEGORIES } from "@/modules/settings/engine-categories";
import type { SettingsCategory } from "@/types";
import type { Command, CommandContext } from "./types";

/** Open the Settings tab. The Shell's own effect brings its drawer view with it. */
function openSettingsTab(): void {
	useTabsStore.getState().openTab({ type: "settings", entityId: null });
}

/**
 * Reveal one settings section - the same two calls the sidebar's `selectCategory`
 * makes, in the same order: select first, then open, so the tab renders the
 * asked-for panel rather than the previous selection for one frame.
 */
function revealSettingsCategory(category: SettingsCategory): void {
	useSettingsStore.getState().setSelectedCategory(category);
	openSettingsTab();
}

const ACTION_COMMANDS: readonly Command[] = [
	{
		id: "new-request",
		title: "New request",
		keywords: ["create", "add", "http", "endpoint"],
		group: "action",
		icon: Plus,
		// The Shell's ⌘N runs the same flow from its own host - see `Shell.tsx`.
		shortcut: NEW_REQUEST_CHORD,
		// The flow can need a collection picker, and a picker needs a host to
		// render it - see `CommandSurfaces`.
		available: (ctx) => ctx.surfaces !== undefined,
		perform: (ctx) => ctx.surfaces?.newRequest(),
	},
	{
		id: "import-collection",
		title: "Import collection",
		keywords: ["postman", "openapi", "insomnia", "curl", "har", "file"],
		group: "action",
		icon: Download,
		// The import modal is mounted in the Shell and driven by a store, so this
		// one needs nothing from the caller.
		perform: () => useImportModalStore.getState().open(),
	},
	{
		id: "run-collection",
		// Named, not generic: a palette row that reads "Run collection" makes the
		// user guess which one Enter will start.
		title: (ctx) => `Run "${ctx.activeCollection?.name ?? ""}"`,
		keywords: ["scenario", "sequence", "start", "execute", "folder"],
		group: "action",
		icon: Play,
		available: (ctx) => ctx.surfaces !== undefined && ctx.activeCollection !== null,
		perform: (ctx) => {
			if (ctx.activeCollection) ctx.surfaces?.runCollection(ctx.activeCollection);
		},
	},
	{
		id: "run-load-test",
		// Named like the other contextual commands. The label is the tab strip's,
		// so the row and the tab it acts on cannot read differently.
		title: (ctx) =>
			ctx.activeTabLabel ? `Load test "${ctx.activeTabLabel}"` : "Load test this request",
		keywords: ["load", "benchmark", "stress", "performance", "rps", "throughput", "start"],
		group: "action",
		icon: Zap,
		// The builder's window handler matches this chord and calls the very
		// `startLoadTest` below - the one the mounted builder contributes.
		shortcut: LOAD_TEST_CHORD,
		/*
		 * The one surface no host can mount for itself. Starting a load test needs
		 * the request builder's live draft, so the mounted builder contributes the
		 * handler through `live-surfaces.ts` and this command is available exactly
		 * while that contribution stands - not merely while a request tab is open,
		 * which is true a frame before the builder has finished loading it.
		 */
		available: (ctx) => ctx.surfaces?.startLoadTest !== undefined,
		perform: (ctx) => ctx.surfaces?.startLoadTest?.(),
	},
	{
		id: "close-tab",
		title: (ctx) => (ctx.activeTabLabel ? `Close "${ctx.activeTabLabel}"` : "Close tab"),
		keywords: ["dismiss", "shut"],
		group: "action",
		icon: X,
		// The Shell's handler closes the same active tab on this chord.
		shortcut: CLOSE_TAB_CHORD,
		available: (ctx) => ctx.activeTab !== null,
		perform: (ctx) => {
			if (ctx.activeTab) useTabsStore.getState().closeTab(ctx.activeTab.id);
		},
	},
	{
		id: "save",
		title: (ctx) => (ctx.activeTabLabel ? `Save "${ctx.activeTabLabel}"` : "Save"),
		keywords: ["write", "persist", "store", "commit"],
		group: "action",
		icon: Save,
		// The Shell's handler raises the same flag on this chord: the mounted
		// surface owns what saving means, and both routes ask it the same way.
		shortcut: SAVE_CHORD,
		available: (ctx) => ctx.activeTab !== null,
		perform: () => useSaveStore.getState().triggerSave(),
	},
	{
		id: "toggle-drawer",
		title: "Show or hide the drawer",
		keywords: ["sidebar", "panel", "left", "collapse", "expand"],
		group: "action",
		icon: PanelLeft,
		shortcut: TOGGLE_DRAWER_CHORD,
		perform: () => useLayoutStore.getState().toggleDrawer(),
	},
	{
		id: "toggle-context-bar",
		title: "Show or hide the context bar",
		keywords: ["sidebar", "panel", "right", "collapse", "expand"],
		group: "action",
		icon: PanelRight,
		shortcut: TOGGLE_CONTEXT_BAR_CHORD,
		perform: () => useLayoutStore.getState().toggleContextBar(),
	},
	{
		id: "toggle-theme",
		title: "Toggle theme mode",
		keywords: ["dark", "light", "appearance", "colour", "color"],
		group: "action",
		icon: SunMoon,
		available: (ctx) => ctx.surfaces !== undefined,
		perform: (ctx) => ctx.surfaces?.toggleThemeMode(),
	},
	{
		id: "open-settings",
		title: "Open settings",
		keywords: ["preferences", "options", "config"],
		group: "action",
		icon: Settings,
		// The Shell's handler opens the same tab on ⌘, - see `openSettingsTab`.
		shortcut: SETTINGS_CHORD,
		perform: openSettingsTab,
	},
];

/**
 * One command per drawer view, generated from the table the Dock's strip is
 * drawn from - so the palette cannot offer a seventh view, name one differently
 * or draw it with another icon.
 *
 * Settings is excluded because it already has `open-settings`, which opens the
 * tab and brings its drawer view along; a second row for the same ⌘, would be
 * two names for one key.
 *
 * `revealDrawerView`, not `activateDrawerView`: the chord toggles, which is
 * right for a switcher pressed twice, and the store's own note says the
 * revealing half is what "a palette result" wants - a row read as "Show
 * history" that hid History because it was already open would be answering a
 * question nobody asked. The chord still appears on the row, because it is the
 * key that shows this view.
 */
const DRAWER_VIEW_COMMANDS: readonly Command[] = DRAWER_VIEWS.filter(
	({ view }) => view !== "settings"
).map(
	({ view, label, icon }): Command => ({
		id: `show-${view}`,
		// The chord's own label ("Show collections"), so the palette row and the
		// Keyboard Shortcuts panel read the same sentence.
		title: DRAWER_VIEW_CHORDS[view].label ?? label,
		keywords: [view, label, "drawer", "sidebar", "show", "view"],
		group: "action",
		icon,
		shortcut: DRAWER_VIEW_CHORDS[view],
		perform: () => useLayoutStore.getState().revealDrawerView(view),
	})
);

/**
 * One command per settings section, generated from the registries the sidebar
 * renders - so the palette cannot offer a section name the screen never shows,
 * nor miss one that was added there.
 */
const SETTINGS_COMMANDS: readonly Command[] = [
	...APP_SETTINGS_PANELS.map(
		(panel): Command => ({
			id: `settings:${panel.id}`,
			title: panel.label,
			// The panel's own description, split into words: it is the sentence
			// the screen prints, so it is also what a user is likely to type.
			keywords: [panel.id, "settings", "preferences", ...panel.description.split(/\s+/)],
			group: "settings",
			icon: panel.icon,
			subtitle: "Settings",
			perform: () => revealSettingsCategory(panel.id),
		})
	),
	...ENGINE_SETTINGS_CATEGORIES.map(
		(category): Command => ({
			id: `settings:${category.id}`,
			title: category.label,
			keywords: [
				category.id,
				"settings",
				"engine",
				"preferences",
				...category.description.split(/\s+/),
			],
			group: "settings",
			icon: category.icon,
			subtitle: "Engine settings",
			perform: () => revealSettingsCategory(category.id),
		})
	),
];

/** Every command the app declares, in palette order. */
export const COMMANDS: readonly Command[] = [
	...ACTION_COMMANDS,
	...DRAWER_VIEW_COMMANDS,
	...SETTINGS_COMMANDS,
];

/** The subset that can run right now. */
export function availableCommands(ctx: CommandContext): Command[] {
	return COMMANDS.filter((command) => command.available?.(ctx) ?? true);
}

/**
 * Look one up by id, for a surface that offers a single named command (the
 * native menu's Preferences… item) rather than the whole roster.
 *
 * Throws on an unknown id: a menu item pointing at a command that no longer
 * exists is a dead menu item, and a silent no-op is exactly how the drift this
 * registry removes got in.
 */
export function commandById(id: string): Command {
	const command = COMMANDS.find((c) => c.id === id);
	if (!command) throw new Error(`Unknown command id: ${id}`);
	return command;
}
