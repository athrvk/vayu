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
 * - App Settings - client-side panels, declared in the app-panels registry.
 * - Engine Settings - the category registry, populated by the `/config` API.
 *
 * Plus the search that spans both: ~45 engine entries and 7 app panels used to
 * be findable only by guessing which category owned them. Typing filters the
 * shared settings index (`lib/settings-index.ts`) over labels, descriptions and
 * engine keys; picking a result selects the owning category and asks the main
 * view to reveal that entry.
 *
 * Category rows share a single selected treatment (the app's `--primary`
 * accent); there is no per-category color.
 */

import { useMemo, useState } from "react";
import { useSettingsStore } from "@/modules/settings/settings-store";
import { useTabsStore } from "@/stores";
import { DrawerPanel, ErrorState } from "@/components/shared";
import { useConfigQuery } from "@/queries";
import type { SettingsCategory } from "@/types";
import type { LucideIcon } from "lucide-react";
import { Search, Settings, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button, Input, Skeleton } from "@/components/ui";
import { APP_SETTINGS_PANELS } from "@/modules/settings/main/app-panels";
import { ENGINE_SETTINGS_CATEGORIES } from "@/modules/settings/engine-categories";
import { buildSettingsIndex, searchSettings } from "@/lib/settings-index";

interface CategoryMeta {
	label: string;
	icon: LucideIcon;
}

function categoryMeta(category: SettingsCategory): CategoryMeta {
	const app = APP_SETTINGS_PANELS.find((p) => p.id === category);
	if (app) return { label: app.label, icon: app.icon };
	const engine = ENGINE_SETTINGS_CATEGORIES.find((c) => c.id === category);
	// Every category in this tree comes from one of the two registries, so the
	// fallback is unreachable by construction - it exists so a future category
	// added to the union renders as itself rather than crashing the drawer.
	return engine ?? { label: category, icon: Settings };
}

function SectionHeading({ children, icon: Icon }: { children: string; icon?: LucideIcon }) {
	return (
		<div className="px-3 py-2 mb-1">
			<div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
				{Icon && <Icon className="w-3 h-3" />}
				{children}
			</div>
		</div>
	);
}

export default function SettingsCategoryTree() {
	const { selectedCategory, setSelectedCategory } = useSettingsStore();
	const { openTab } = useTabsStore();
	const { data: configResponse, isLoading, error, refetch } = useConfigQuery();
	const [query, setQuery] = useState("");

	// Selecting a category shows its panel in the settings tab. The tree now
	// lives in the Drawer (not inside the settings tab), so it must open/focus
	// that tab itself - mirroring VariablesCategoryTree.
	const selectCategory = (category: SettingsCategory, highlightKey?: string) => {
		setSelectedCategory(category, highlightKey);
		openTab({ type: "settings", entityId: null });
	};

	const index = useMemo(
		() =>
			buildSettingsIndex({
				panels: APP_SETTINGS_PANELS,
				engineEntries: configResponse?.entries ?? [],
				engineCategories: ENGINE_SETTINGS_CATEGORIES,
			}),
		[configResponse]
	);

	const trimmedQuery = query.trim();
	const results = useMemo(
		() => (trimmedQuery === "" ? [] : searchSettings(index, trimmedQuery)),
		[index, trimmedQuery]
	);

	const renderCategory = (category: SettingsCategory) => {
		const { label, icon: Icon } = categoryMeta(category);
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
			</button>
		);
	};

	return (
		<DrawerPanel title="Settings">
			<div className="flex flex-col w-full py-2">
				<div className="px-3 pb-2">
					<div className="relative">
						<Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
						<Input
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Search settings"
							aria-label="Search settings"
							className="h-8 pl-8 pr-8 text-sm"
						/>
						{query !== "" && (
							<Button
								variant="ghost"
								size="sm"
								onClick={() => setQuery("")}
								aria-label="Clear search"
								className="absolute right-0.5 top-1/2 h-7 w-7 -translate-y-1/2 p-0"
							>
								<X className="h-3.5 w-3.5" />
							</Button>
						)}
					</div>
				</div>

				{trimmedQuery !== "" ? (
					/*
					 * Searching replaces the two sections rather than filtering them in
					 * place: a match is an *entry*, and an entry has no row of its own in
					 * the normal tree - only its category does. Showing the entries is
					 * the whole point of typing.
					 */
					<>
						<SectionHeading>{`${results.length} result${results.length === 1 ? "" : "s"}`}</SectionHeading>
						{results.length === 0 ? (
							<p className="px-4 py-2 text-xs text-muted-foreground">
								No settings match “{trimmedQuery}”.
							</p>
						) : (
							<div>
								{results.map((result) => (
									<button
										key={`${result.kind}:${result.id}`}
										onClick={() =>
											selectCategory(
												result.category,
												result.kind === "engine" ? result.id : undefined
											)
										}
										className="w-full flex flex-col items-start gap-0.5 px-4 py-1.5 text-left transition-colors text-foreground hover:bg-accent"
									>
										<span className="w-full truncate text-sm">
											{result.label}
										</span>
										<span className="w-full truncate text-xs text-muted-foreground">
											{result.kind === "engine"
												? `${result.categoryLabel} · ${result.id}`
												: "App settings"}
										</span>
									</button>
								))}
							</div>
						)}
					</>
				) : (
					<>
						<SectionHeading>App Settings</SectionHeading>
						<div className="space-y-1 mb-4">
							{APP_SETTINGS_PANELS.map((panel) => renderCategory(panel.id))}
						</div>

						{/* Engine Settings Section - depends on the engine `/config` query, so
					    its loading/error states are scoped here. App Settings above always
					    render (client-side), so Settings stays usable when the engine is down. */}
						<SectionHeading icon={Settings}>Engine Settings</SectionHeading>
						{isLoading ? (
							<div className="space-y-2 px-3">
								<Skeleton className="h-9 w-full" />
								<Skeleton className="h-9 w-full" />
								<Skeleton className="h-9 w-full" />
							</div>
						) : error ? (
							/*
							 * Was a hand-rolled two-line notice with no way out: the engine
							 * comes back and nothing in the sidebar re-asks, so the only
							 * recovery was reloading the app. Same ErrorState + `refetch` the
							 * Variables tree uses for its own section failures, with that
							 * tree's inline padding so the failure line sits on the left edge
							 * like every other row rather than centring in the pane variant's
							 * p-8.
							 */
							<ErrorState
								variant="inline"
								className="justify-start px-3 py-2 text-xs"
								title="Couldn't load engine settings"
								onRetry={() => void refetch()}
							/>
						) : (
							<div className="space-y-1">
								{ENGINE_SETTINGS_CATEGORIES.map((category) =>
									renderCategory(category.id)
								)}
							</div>
						)}
					</>
				)}
			</div>
		</DrawerPanel>
	);
}
