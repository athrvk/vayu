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
	ArrowLeft,
	ArrowRight,
	CheckCheck,
	ChevronsRight,
	Download,
	PanelLeft,
	PanelRight,
	Play,
	Plus,
	Save,
	Send,
	Settings,
	SunMoon,
	X,
	XCircle,
	Zap,
} from "lucide-react";
import {
	CLOSE_TAB_CHORD,
	DRAWER_VIEW_CHORDS,
	GO_BACK_CHORD,
	GO_FORWARD_CHORD,
	LOAD_TEST_CHORD,
	NEW_REQUEST_CHORD,
	SAVE_CHORD,
	SEND_CHORD,
	SETTINGS_CHORD,
	TOGGLE_CONTEXT_BAR_CHORD,
	TOGGLE_DRAWER_CHORD,
} from "@/constants/shortcuts";
import { DRAWER_VIEWS } from "@/constants/drawer-views";
import {
	canGoBack,
	canGoForward,
	useImportModalStore,
	useLayoutStore,
	useSaveStore,
	useTabsStore,
} from "@/stores";
import { useSettingsStore } from "@/modules/settings/settings-store";
import { APP_SETTINGS_PANELS } from "@/modules/settings/main/app-panels";
import { ENGINE_SETTINGS_CATEGORIES } from "@/modules/settings/engine-categories";
import type { SettingsCategory } from "@/types";
import { navigateHistory } from "@/lib/navigate-history";
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
		id: "send-request",
		// Named like the other contextual commands, and for the same reason: the
		// row says which request Enter puts on the wire.
		title: (ctx) => (ctx.activeTabLabel ? `Send "${ctx.activeTabLabel}"` : "Send this request"),
		keywords: ["execute", "fire", "call", "http", "request", "run"],
		group: "action",
		// The app has no send mark of its own - the URL bar's Send is a text
		// button - so the palette takes lucide's, which is the glyph the action
		// already reads as everywhere else.
		icon: Send,
		// The builder's window handler matches this chord and calls the very
		// `sendRequest` below.
		shortcut: SEND_CHORD,
		/*
		 * Contributed by the mounted builder, like the load test under it - and
		 * withdrawn while sending is not possible. Send is Stop for the whole of
		 * an open stream (#574) and does nothing with an empty URL, so a row that
		 * stayed on screen there would be one the palette offers and the app
		 * refuses: `canSendRequest` is the single predicate both routes ask.
		 */
		available: (ctx) => ctx.surfaces?.sendRequest !== undefined,
		perform: (ctx) => ctx.surfaces?.sendRequest?.(),
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
	/*
	 * The strip's bulk closes (#1360). Declared here because the rule at the top
	 * of this file is what it says: the tab menu is a way of reaching them, not
	 * a second definition. The menu and these differ only in which tab they name
	 * - it acts on the tab under the pointer, a palette row can only mean the
	 * one on screen - and both call the same store action, which is where the
	 * action itself lives.
	 *
	 * No chord for any of them: they are deliberate, occasional operations, and
	 * a chord that closes several tabs at once is a keystroke away from losing a
	 * strip full of work.
	 */
	{
		id: "close-other-tabs",
		title: (ctx) =>
			ctx.activeTabLabel
				? `Close all tabs except "${ctx.activeTabLabel}"`
				: "Close other tabs",
		keywords: ["others", "dismiss", "shut", "clean"],
		group: "action",
		icon: XCircle,
		available: (ctx) => ctx.activeTab !== null && useTabsStore.getState().openTabs.length > 1,
		perform: (ctx) => {
			if (ctx.activeTab) useTabsStore.getState().closeOtherTabs(ctx.activeTab.id);
		},
	},
	{
		id: "close-tabs-to-right",
		title: "Close tabs to the right",
		keywords: ["dismiss", "shut", "clean", "trailing"],
		group: "action",
		icon: ChevronsRight,
		available: (ctx) => {
			if (!ctx.activeTab) return false;
			const { openTabs } = useTabsStore.getState();
			return openTabs.findIndex((t) => t.id === ctx.activeTab?.id) < openTabs.length - 1;
		},
		perform: (ctx) => {
			if (ctx.activeTab) useTabsStore.getState().closeTabsToRight(ctx.activeTab.id);
		},
	},
	{
		id: "close-saved-tabs",
		title: "Close saved tabs",
		keywords: ["dismiss", "shut", "clean", "unsaved", "dirty"],
		group: "action",
		icon: CheckCheck,
		available: () => useTabsStore.getState().openTabs.length > 0,
		perform: () => useTabsStore.getState().closeSavedTabs(),
	},
	{
		id: "go-back",
		title: "Go back",
		keywords: ["previous", "history", "navigate", "return"],
		group: "action",
		icon: ArrowLeft,
		// Through the same funnel the chord, the title bar's buttons, the View
		// menu and the mouse go through - see `lib/navigate-history.ts`.
		shortcut: GO_BACK_CHORD,
		available: () => canGoBack(useTabsStore.getState()),
		perform: () => navigateHistory("back", "ui"),
	},
	{
		id: "go-forward",
		title: "Go forward",
		keywords: ["next", "history", "navigate"],
		group: "action",
		icon: ArrowRight,
		shortcut: GO_FORWARD_CHORD,
		available: () => canGoForward(useTabsStore.getState()),
		perform: () => navigateHistory("forward", "ui"),
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
).map(({ view, label, icon }): Command => ({
	id: `show-${view}`,
	// The chord's own label ("Show collections"), so the palette row and the
	// Keyboard Shortcuts panel read the same sentence.
	title: DRAWER_VIEW_CHORDS[view].label ?? label,
	keywords: [view, label, "drawer", "sidebar", "show", "view"],
	group: "action",
	icon,
	shortcut: DRAWER_VIEW_CHORDS[view],
	perform: () => useLayoutStore.getState().revealDrawerView(view),
}));

/**
 * One command per settings section, generated from the registries the sidebar
 * renders - so the palette cannot offer a section name the screen never shows,
 * nor miss one that was added there.
 */
const SETTINGS_COMMANDS: readonly Command[] = [
	...APP_SETTINGS_PANELS.map((panel): Command => ({
		id: `settings:${panel.id}`,
		title: panel.label,
		// The panel's own description, split into words: it is the sentence
		// the screen prints, so it is also what a user is likely to type.
		keywords: [panel.id, "settings", "preferences", ...panel.description.split(/\s+/)],
		group: "settings",
		icon: panel.icon,
		subtitle: "Settings",
		perform: () => revealSettingsCategory(panel.id),
	})),
	...ENGINE_SETTINGS_CATEGORIES.map((category): Command => ({
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
	})),
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
