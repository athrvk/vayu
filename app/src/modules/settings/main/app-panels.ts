/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * App settings registry
 *
 * The client-side (app) settings panels, declared as data - mirroring how the
 * engine settings side is driven by the `/config` API. The sidebar tree renders
 * `label`/`icon` from here, and `SettingsMain` looks the panel component up in
 * `app-panel-components.ts` instead of branching on a category string. Adding
 * an app category is one entry + one panel file + its line in that map, which
 * the compiler demands.
 *
 * **This file holds no component.** It is imported by the Drawer's category
 * tree and by the command registry, both mounted on every tab, so a static
 * import of the panels here put all eight of them - and everything they pull -
 * in the startup chunk, whatever `Shell` did with `SettingsMain` (#1146). The
 * split is between the data and the components, not between panels: the map is
 * keyed by `ClientSettingsCategory`, so an id without a panel is a type error
 * rather than a second list to keep in step.
 */

import type { LucideIcon } from "lucide-react";
import { Palette, Code2, LayoutDashboard, Gauge, Bell, Plug, Info, Keyboard } from "lucide-react";
import type { ClientSettingsCategory, SettingsCategory } from "@/types";

export interface AppSettingsPanel {
	id: ClientSettingsCategory;
	label: string;
	/** Shown under the panel header. */
	description: string;
	icon: LucideIcon;
	/**
	 * How this panel saves, stated in its header. Three save models coexist in
	 * Settings - these panels autosave, the engine view has an explicit Save
	 * bar, and MCP commits number fields on blur - and nothing on screen used to
	 * say which one you were looking at. Omit for the autosave default.
	 */
	saveNote?: string;
}

/** What a panel's header says when it does not override {@link AppSettingsPanel.saveNote}. */
export const DEFAULT_SAVE_NOTE = "Changes are saved automatically.";

export const APP_SETTINGS_PANELS: readonly AppSettingsPanel[] = [
	{
		id: "general",
		label: "General",
		description: "Storage locations and application info",
		icon: Info,
	},
	{
		id: "appearance",
		label: "Appearance",
		description: "Customize the look and feel of the application",
		icon: Palette,
	},
	{
		id: "editor",
		label: "Editor",
		description: "Code-editor behavior across scripts and request/response bodies",
		icon: Code2,
	},
	{
		id: "dashboard",
		label: "Dashboard",
		description: "How live test dashboards and charts behave",
		icon: LayoutDashboard,
	},
	{
		id: "load-testing",
		label: "Load testing",
		description: "How far the load-test dialog lets you push a run",
		icon: Gauge,
	},
	{
		id: "notifications",
		label: "Notifications",
		description: "Where toasts appear, how long they stay, and which ones are worth showing",
		icon: Bell,
	},
	{
		id: "shortcuts",
		label: "Keyboard shortcuts",
		description: "Every chord the app listens for, drawn for this platform",
		icon: Keyboard,
		// Nothing on this screen is editable, so the autosave note would be
		// answering a question it does not raise.
		saveNote: "Shortcuts are fixed; this screen is a reference.",
	},
	{
		id: "mcp",
		// The sidebar's only unexpanded acronym. "MCP" stays in the parenthetical
		// so it is still findable by eye for someone who arrives knowing the term.
		label: "AI agents (MCP)",
		description: "Expose Vayu to AI agents like Claude Code, and set the safety guardrails",
		icon: Plug,
		saveNote:
			"Switches and hosts are saved as you change them; the caps save when you leave the field. Every change is applied to the running server.",
	},
];

/** Category ids handled client-side, in sidebar order. */
export const APP_CATEGORY_IDS: readonly ClientSettingsCategory[] = APP_SETTINGS_PANELS.map(
	(p) => p.id
);

/** Look up an app panel by category id (undefined for engine categories). */
export function getAppPanel(category: SettingsCategory | null): AppSettingsPanel | undefined {
	return category ? APP_SETTINGS_PANELS.find((p) => p.id === category) : undefined;
}

/** True when the category is rendered by a client panel (vs the engine config view). */
export function isClientCategory(
	category: SettingsCategory | null
): category is ClientSettingsCategory {
	return getAppPanel(category) !== undefined;
}
