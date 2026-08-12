/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Engine settings category registry
 *
 * The five engine categories, declared once and in sidebar order - mirroring
 * `app-panels.ts` on the client side.
 *
 * This replaces two hand-maintained maps: `ENGINE_CATEGORY_META` in the sidebar
 * tree (label + icon) and `CATEGORY_TITLES` in the settings main view (title +
 * description). They named the same five categories with two independently
 * edited copies of the label, and the sidebar's order was whatever
 * `Object.keys` returned. An array fixes both: one label per category, and the
 * order is written down.
 */

import type { LucideIcon } from "lucide-react";
import { Server, Code, Network, Activity, Database } from "lucide-react";
import type { EngineSettingsCategory } from "@/types";

export interface EngineSettingsCategoryMeta {
	id: EngineSettingsCategory;
	label: string;
	/** Shown under the category title in the settings view header. */
	description: string;
	icon: LucideIcon;
}

export const ENGINE_SETTINGS_CATEGORIES: readonly EngineSettingsCategoryMeta[] = [
	{
		id: "general_engine",
		label: "General & Engine",
		description: "Core settings defining the application's base capacity and threading model",
		icon: Server,
	},
	{
		id: "database_performance",
		label: "Database Performance",
		description:
			"SQLite optimization settings for high-throughput load testing and result storage",
		icon: Database,
	},
	{
		id: "network_performance",
		label: "Network & Connectivity",
		description: "Low-level networking tuning for throughput, DNS, and connection persistence",
		icon: Network,
	},
	{
		id: "scripting_sandbox",
		label: "Scripting Environment",
		description: "Configuration for the QuickJS sandbox execution, limits, and debugging",
		icon: Code,
	},
	{
		id: "observability",
		label: "Observability & Data",
		description:
			"Settings for real-time dashboards (SSE), metrics aggregation, and data parsing limits",
		icon: Activity,
	},
];

/** Look up an engine category (undefined for client categories). */
export function getEngineCategory(category: string | null): EngineSettingsCategoryMeta | undefined {
	return category ? ENGINE_SETTINGS_CATEGORIES.find((c) => c.id === category) : undefined;
}
