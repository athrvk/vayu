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

import { Download, Play, Plus, Settings, SunMoon, X } from "lucide-react";
import { useImportModalStore, useTabsStore } from "@/stores";
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
		id: "close-tab",
		title: (ctx) => (ctx.activeTabLabel ? `Close "${ctx.activeTabLabel}"` : "Close tab"),
		keywords: ["dismiss", "shut"],
		group: "action",
		icon: X,
		available: (ctx) => ctx.activeTab !== null,
		perform: (ctx) => {
			if (ctx.activeTab) useTabsStore.getState().closeTab(ctx.activeTab.id);
		},
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
		perform: openSettingsTab,
	},
];

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
export const COMMANDS: readonly Command[] = [...ACTION_COMMANDS, ...SETTINGS_COMMANDS];

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
