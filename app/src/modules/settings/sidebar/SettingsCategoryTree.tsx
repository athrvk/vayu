/**
 * Settings Category Tree
 *
 * Displays categories for settings in the sidebar:
 * - UI (App Settings)
 * - Server (Engine Settings)
 * - Scripting (Engine Settings)
 * - Performance (Engine Settings)
 */

import { useSettingsStore } from "@/stores";
import { useConfigQuery } from "@/queries";
import type { SettingsCategory } from "@/types";
import { Server, Code, Gauge, Settings, Palette } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge, Skeleton } from "@/components/ui";

const CATEGORY_CONFIG: Record<
	SettingsCategory,
	{ label: string; icon: typeof Server; color: string }
> = {
	ui: {
		label: "Appearance",
		icon: Palette,
		color: "pink",
	},
	server: {
		label: "Server",
		icon: Server,
		color: "blue",
	},
	scripting: {
		label: "Scripting",
		icon: Code,
		color: "purple",
	},
	performance: {
		label: "Performance",
		icon: Gauge,
		color: "green",
	},
};

export default function SettingsCategoryTree() {
	const { selectedCategory, setSelectedCategory } = useSettingsStore();
	const { data: configResponse, isLoading, error } = useConfigQuery();

	// Count entries per category
	const categoryCounts: Record<string, number> = {};
	if (configResponse?.entries) {
		for (const entry of configResponse.entries) {
			categoryCounts[entry.category] = (categoryCounts[entry.category] || 0) + 1;
		}
	}

	const appCategories: SettingsCategory[] = ["ui"];
	const engineCategories: SettingsCategory[] = ["server", "scripting", "performance"];

	if (isLoading) {
		return (
			<div className="flex flex-col h-full w-full py-2 px-3 space-y-2">
				<Skeleton className="h-10 w-full" />
				<Skeleton className="h-10 w-full" />
				<Skeleton className="h-10 w-full" />
			</div>
		);
	}

	if (error) {
		return (
			<div className="flex flex-col h-full w-full py-4 px-3">
				<div className="text-sm text-destructive">Failed to load settings</div>
				<div className="text-xs text-muted-foreground mt-1">
					{error instanceof Error ? error.message : "Unknown error"}
				</div>
			</div>
		);
	}

	const renderCategory = (category: SettingsCategory, showCount = true) => {
		const config = CATEGORY_CONFIG[category];
		const Icon = config.icon;
		const count = categoryCounts[category] || 0;
		const isSelected = selectedCategory === category;

		const colorClasses: Record<string, string> = {
			pink: isSelected
				? "bg-pink-50 text-pink-700 dark:bg-pink-950/50 dark:text-pink-300 hover:bg-pink-100 dark:hover:bg-pink-950/70"
				: "",
			blue: isSelected
				? "bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-950/70"
				: "",
			purple: isSelected
				? "bg-purple-50 text-purple-700 dark:bg-purple-950/50 dark:text-purple-300 hover:bg-purple-100 dark:hover:bg-purple-950/70"
				: "",
			green: isSelected
				? "bg-green-50 text-green-700 dark:bg-green-950/50 dark:text-green-300 hover:bg-green-100 dark:hover:bg-green-950/70"
				: "",
		};

		const badgeClasses: Record<string, string> = {
			pink: "bg-pink-100 text-pink-600 dark:bg-pink-950 dark:text-pink-300",
			blue: "bg-blue-100 text-blue-600 dark:bg-blue-950 dark:text-blue-300",
			purple: "bg-purple-100 text-purple-600 dark:bg-purple-950 dark:text-purple-300",
			green: "bg-green-100 text-green-600 dark:bg-green-950 dark:text-green-300",
		};

		return (
			<button
				key={category}
				onClick={() => setSelectedCategory(category)}
				className={cn(
					"w-full flex items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-accent transition-colors",
					colorClasses[config.color]
				)}
			>
				<Icon className="w-4 h-4 shrink-0" />
				<span className="flex-1 truncate">{config.label}</span>
				{showCount && count > 0 && (
					<Badge
						variant="secondary"
						className={cn(
							"text-xs px-1.5 py-0 shrink-0",
							isSelected && badgeClasses[config.color]
						)}
					>
						{count}
					</Badge>
				)}
			</button>
		);
	};

	return (
		<div className="flex flex-col h-full w-full py-2">
			{/* App Settings Section */}
			<div className="px-3 py-2 mb-1">
				<div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
					App Settings
				</div>
			</div>
			<div className="space-y-1 mb-4">
				{appCategories.map((category) => renderCategory(category, false))}
			</div>

			{/* Engine Settings Section */}
			<div className="px-3 py-2 mb-1">
				<div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
					<Settings className="w-3 h-3" />
					Engine Settings
				</div>
			</div>
			<div className="space-y-1">
				{engineCategories.map((category) => renderCategory(category))}
			</div>
		</div>
	);
}
