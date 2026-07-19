/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * App settings registry
 *
 * The client-side (app) settings panels, declared as data — mirroring how the
 * engine settings side is driven by the `/config` API. The sidebar tree renders
 * `label`/`icon` from here, and `SettingsMain` looks up `Component` instead of
 * branching on a category string. Adding an app category is one entry + one
 * panel file.
 */

import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import { Palette, Code2, LayoutDashboard, Plug, Info } from "lucide-react";
import type { ClientSettingsCategory, SettingsCategory } from "@/types";
import AppearancePanel from "./panels/AppearancePanel";
import EditorPanel from "./panels/EditorPanel";
import DashboardPanel from "./panels/DashboardPanel";
import McpSettingsPanel from "./panels/McpSettingsPanel";
import GeneralPanel from "./panels/GeneralPanel";

export interface AppSettingsPanel {
	id: ClientSettingsCategory;
	label: string;
	/** Shown under the panel header. */
	description: string;
	icon: LucideIcon;
	Component: ComponentType;
}

export const APP_SETTINGS_PANELS: readonly AppSettingsPanel[] = [
	{
		id: "appearance",
		label: "Appearance",
		description: "Customize the look and feel of the application",
		icon: Palette,
		Component: AppearancePanel,
	},
	{
		id: "editor",
		label: "Editor",
		description: "Code-editor behavior across scripts and request/response bodies",
		icon: Code2,
		Component: EditorPanel,
	},
	{
		id: "dashboard",
		label: "Dashboard",
		description: "How live test dashboards and charts behave",
		icon: LayoutDashboard,
		Component: DashboardPanel,
	},
	{
		id: "mcp",
		label: "MCP (AI Agents)",
		description: "Expose Vayu to AI agents like Claude Code, and set the safety guardrails",
		icon: Plug,
		Component: McpSettingsPanel,
	},
	{
		id: "general",
		label: "General",
		description: "Storage locations and application info",
		icon: Info,
		Component: GeneralPanel,
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
