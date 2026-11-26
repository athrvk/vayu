/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The settings categories in two sections: App Settings (the client-side panels of the app-panels
 * registry) and Engine Settings (the category registry, filled by `/config`).
 *
 * Plus the search spanning both, so an entry is found without guessing which category owns it:
 * typing filters the shared settings index (`useSettingsIndex`, over `lib/settings-index.ts`) by
 * labels, descriptions and engine keys, and picking a result selects the owning category and asks
 * the main view to reveal the entry.
 *
 * The box's text lives in `settings-store`, so the command palette's "Search settings for …" row
 * can hand its query over and land the user on an already-filtered sidebar. Category rows share one
 * selected treatment (the `--primary` accent), no per-category colour.
 */

import { useDrawerItemOpened } from "@/components/layout/drawer-item-opened";
import { useMemo } from "react";
import { pluralize } from "@/modules/dashboard/utils/format";
import { useSettingsStore } from "@/modules/settings/settings-store";
import { useTabsStore } from "@/stores";
import { DrawerPanel, EmptyState, ErrorState } from "@/components/shared";
import { useConfigQuery } from "@/queries";
import type { SettingsCategory } from "@/types";
import type { LucideIcon } from "lucide-react";
import { Search, Settings, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button, Input, Skeleton, TooltipIconButton, type IconMotion } from "@/components/ui";
import { APP_SETTINGS_PANELS } from "@/modules/settings/main/app-panels";
import { ENGINE_SETTINGS_CATEGORIES } from "@/modules/settings/engine-categories";
import { useSettingsIndex } from "@/modules/settings/useSettingsIndex";
import { searchSettings } from "@/lib/settings-index";
import { Eyebrow } from "@/components/ui/eyebrow";

interface CategoryMeta {
	label: string;
	icon: LucideIcon;
	/**
	 * The named icon motion this row's glyph answers its own hover with (#1707), read from
	 * whichever registry owns the category, not mapped here: a category row is a navigation
	 * affordance like a rail entry, and the tree draws fifteen glyphs generically (`ActivityRail`
	 * makes the same argument).
	 *
	 * Optional so the unreachable fallback below can omit it: React drops an undefined attribute,
	 * and an empty `data-icon-motion` would still match the block's default-duration rule.
	 */
	motion?: IconMotion;
}

function categoryMeta(category: SettingsCategory): CategoryMeta {
	const app = APP_SETTINGS_PANELS.find((p) => p.id === category);
	if (app) return { label: app.label, icon: app.icon, motion: app.motion };
	const engine = ENGINE_SETTINGS_CATEGORIES.find((c) => c.id === category);
	// Every category in this tree comes from one of the two registries, so the
	// fallback is unreachable by construction - it exists so a future category
	// added to the union renders as itself rather than crashing the drawer.
	return engine ?? { label: category, icon: Settings };
}

function SectionHeading({ children, icon: Icon }: { children: string; icon?: LucideIcon }) {
	return (
		<div className="px-3 py-2 mb-1">
			<Eyebrow className="flex items-center gap-2">
				{Icon && <Icon className="size-icon-sm" />}
				{children}
			</Eyebrow>
		</div>
	);
}

export default function SettingsCategoryTree() {
	const selectedCategory = useSettingsStore((s) => s.selectedCategory);
	const setSelectedCategory = useSettingsStore((s) => s.setSelectedCategory);
	const query = useSettingsStore((s) => s.searchQuery);
	const setQuery = useSettingsStore((s) => s.setSearchQuery);
	const openTab = useTabsStore((s) => s.openTab);
	const onItemOpened = useDrawerItemOpened();
	const { isLoading, error, refetch } = useConfigQuery();

	// Selecting a category shows its panel in the settings tab. The tree lives in the Drawer, not
	// the settings tab, so it opens or focuses that tab itself, as VariablesCategoryTree does.
	const selectCategory = (category: SettingsCategory, highlightKey?: string) => {
		setSelectedCategory(category, highlightKey);
		openTab({ type: "settings", entityId: null });
		onItemOpened();
	};

	// The same corpus the palette's settings source searches - see
	// `useSettingsIndex`.
	const index = useSettingsIndex();

	const trimmedQuery = query.trim();
	const results = useMemo(
		() => (trimmedQuery === "" ? [] : searchSettings(index, trimmedQuery)),
		[index, trimmedQuery]
	);

	const renderCategory = (category: SettingsCategory) => {
		const { label, icon: Icon, motion } = categoryMeta(category);
		const isSelected = selectedCategory === category;

		return (
			<button
				key={category}
				data-active={isSelected}
				aria-current={isSelected ? "true" : undefined}
				onClick={() => selectCategory(category)}
				className={cn(
					// h-8: the shared drawer row height (see CollectionItem). A stable base plus a
					// `data-active` modifier, not a whole-string ternary: swapping the whole string
					// makes `transition-colors` interpolate between two different class lists
					// rather than one changing value, so the selected state snaps instead of fading
					// (as in `TabStrip.tsx`). `group`: the glyph's motion fires from the `:hover` /
					// `:focus-visible` of a `[data-slot="button"]` or a `.group` ancestor (the
					// `Icon motion` block in `index.css`), and this hand-rolled `<button>` is
					// neither; without it the attribute is dead CSS that looks wired up.
					"group w-full flex h-8 items-center gap-3 px-4 text-left text-sm transition-colors",
					"data-[active=false]:text-foreground data-[active=false]:hover:bg-accent",
					"data-[active=true]:bg-primary-tint data-[active=true]:text-primary data-[active=true]:font-medium"
				)}
			>
				<Icon className="size-icon shrink-0" data-icon-motion={motion} />
				<span className="cap-centred flex-1 truncate">{label}</span>
			</button>
		);
	};

	return (
		<DrawerPanel title="Settings">
			<div className="flex flex-col w-full py-2">
				<div className="px-3 pb-2">
					<div className="relative">
						<Search className="pointer-events-none absolute left-2.5 top-1/2 size-icon-sm -translate-y-1/2 text-muted-foreground" />
						<Input
							size="sm"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Search settings"
							aria-label="Search settings"
							className="pl-8 pr-8 text-sm"
						/>
						{query !== "" && (
							<TooltipIconButton
								size="sm"
								onClick={() => setQuery("")}
								label="Clear search"
								className="absolute right-0.5 top-1/2 size-target -translate-y-1/2 p-0"
								icon={<X className="size-icon-sm" />}
							/>
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
						<SectionHeading>{`${results.length} ${pluralize(results.length, "result")}`}</SectionHeading>
						{results.length === 0 ? (
							<EmptyState
								variant="inline"
								compact
								title={`No settings match “${trimmedQuery}”.`}
								action={
									<Button variant="link" size="sm" onClick={() => setQuery("")}>
										Clear the filter
									</Button>
								}
							/>
						) : (
							<div>
								{results.map((result) => (
									<button
										key={`${result.kind}:${result.id}`}
										onClick={() =>
											selectCategory(result.category, result.anchor)
										}
										className="w-full flex flex-col items-start gap-0.5 px-4 py-1.5 text-left transition-colors text-foreground hover:bg-accent"
									>
										<span className="w-full truncate text-sm">
											{result.label}
										</span>
										<span className="w-full truncate text-xs text-muted-foreground">
											{/* The engine key is part of the subtitle
											    because that is what docs, logs and MCP
											    calls name the setting. An app setting
											    has no such name, so its subtitle is the
											    panel that holds it. */}
											{result.kind === "engine"
												? `${result.categoryLabel} · ${result.id}`
												: result.kind === "app-setting"
													? result.categoryLabel
													: "App settings"}
										</span>
									</button>
								))}
							</div>
						)}
					</>
				) : (
					<>
						<SectionHeading>App settings</SectionHeading>
						<div className="space-y-1 mb-4">
							{APP_SETTINGS_PANELS.map((panel) => renderCategory(panel.id))}
						</div>

						{/* Engine Settings Section - depends on the engine `/config` query, so
					    its loading/error states are scoped here. App Settings above always
					    render (client-side), so Settings stays usable when the engine is down. */}
						<SectionHeading icon={Settings}>Engine settings</SectionHeading>
						{isLoading ? (
							<div className="space-y-2 px-3">
								<Skeleton className="h-9 w-full" />
								<Skeleton className="h-9 w-full" />
								<Skeleton className="h-9 w-full" />
							</div>
						) : error ? (
							/*
							 * A retry, as the engine coming back makes nothing in the sidebar
							 * re-ask: the Variables tree's ErrorState + `refetch`, with that tree's
							 * inline padding so the failure line sits on the left edge like every
							 * other row rather than centring in the pane variant's p-8.
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
