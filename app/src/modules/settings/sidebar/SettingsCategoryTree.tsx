/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Settings Category Tree
 *
 * Sidebar list of settings categories, split into two sections:
 * - App Settings — client-side panels, declared in the app-panels registry.
 * - Engine Settings — data-driven from the engine `/config` API.
 *
 * Category rows share a single selected treatment (the app's `--primary`
 * accent); there is no per-category color.
 */

import { useSettingsStore } from "@/modules/settings/settings-store";
import { useTabsStore } from "@/stores";
import { DrawerPanel } from "@/components/shared";
import { useConfigQuery } from "@/queries";
import type { EngineSettingsCategory, SettingsCategory } from "@/types";
import type { LucideIcon } from "lucide-react";
import { Server, Code, Settings, Network, Activity, Database } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge, Skeleton } from "@/components/ui";
import { APP_SETTINGS_PANELS } from "@/modules/settings/main/app-panels";

interface CategoryMeta {
	label: string;
	icon: LucideIcon;
}

const ENGINE_CATEGORY_META: Record<EngineSettingsCategory, CategoryMeta> = {
	general_engine: { label: "General & Engine", icon: Server },
	database_performance: { label: "Database Performance", icon: Database },
	network_performance: { label: "Network & Connectivity", icon: Network },
	scripting_sandbox: { label: "Scripting Environment", icon: Code },
	observability: { label: "Observability & Data", icon: Activity },
};

const ENGINE_CATEGORIES = Object.keys(ENGINE_CATEGORY_META) as EngineSettingsCategory[];

function categoryMeta(category: SettingsCategory): CategoryMeta {
	const app = APP_SETTINGS_PANELS.find((p) => p.id === category);
	if (app) return { label: app.label, icon: app.icon };
	return ENGINE_CATEGORY_META[category as EngineSettingsCategory];
}

export default function SettingsCategoryTree() {
	const { selectedCategory, setSelectedCategory } = useSettingsStore();
	const { openTab } = useTabsStore();
	const { data: configResponse, isLoading, error } = useConfigQuery();

	// Selecting a category shows its panel in the settings tab. The tree now
	// lives in the Drawer (not inside the settings tab), so it must open/focus
	// that tab itself — mirroring VariablesCategoryTree.
	const selectCategory = (category: SettingsCategory) => {
		setSelectedCategory(category);
		openTab({ type: "settings", entityId: null });
	};

	// Count entries per category (engine categories only carry counts).
	const categoryCounts: Record<string, number> = {};
	if (configResponse?.entries) {
		for (const entry of configResponse.entries) {
			categoryCounts[entry.category] = (categoryCounts[entry.category] || 0) + 1;
		}
	}

	const appCategories = APP_SETTINGS_PANELS.map((p) => p.id);

	const renderCategory = (category: SettingsCategory, showCount = true) => {
		const { label, icon: Icon } = categoryMeta(category);
		const count = categoryCounts[category] || 0;
		const isSelected = selectedCategory === category;

		return (
			<button
				key={category}
				onClick={() => selectCategory(category)}
				className={cn(
					// h-8: shared drawer row height (see CollectionItem).
					"w-full flex h-8 items-center gap-3 px-4 text-left text-sm transition-colors",
					isSelected
						? "bg-primary/10 text-primary font-medium"
						: "text-foreground hover:bg-accent"
				)}
			>
				<Icon className="w-4 h-4 shrink-0" />
				<span className="flex-1 truncate">{label}</span>
				{showCount && count > 0 && (
					<Badge variant="secondary" className="text-xs px-1.5 py-0 shrink-0">
						{count}
					</Badge>
				)}
			</button>
		);
	};

	return (
		<DrawerPanel title="Settings">
			<div className="flex flex-col w-full py-2">
				{/* App Settings Section */}
				<div className="px-3 py-2 mb-1">
					<div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
						App Settings
					</div>
				</div>
				<div className="space-y-1 mb-4">
					{appCategories.map((category) => renderCategory(category, false))}
				</div>

				{/* Engine Settings Section — depends on the engine `/config` query, so
			    its loading/error states are scoped here. App Settings above always
			    render (client-side), so Settings stays usable when the engine is down. */}
				<div className="px-3 py-2 mb-1">
					<div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
						<Settings className="w-3 h-3" />
						Engine Settings
					</div>
				</div>
				{isLoading ? (
					<div className="space-y-2 px-3">
						<Skeleton className="h-9 w-full" />
						<Skeleton className="h-9 w-full" />
						<Skeleton className="h-9 w-full" />
					</div>
				) : error ? (
					<div className="px-4 py-2">
						<div className="text-xs text-destructive">Engine settings unavailable</div>
						<div className="text-xs text-muted-foreground mt-0.5">
							{error instanceof Error
								? error.message
								: "The engine isn't responding."}
						</div>
					</div>
				) : (
					<div className="space-y-1">
						{ENGINE_CATEGORIES.map((category) => renderCategory(category))}
					</div>
				)}
			</div>
		</DrawerPanel>
	);
}
