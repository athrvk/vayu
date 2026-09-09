/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The right-edge counterpart to `ActivityRail` (#1615): one icon per section
 * the context bar has for the active tab, so reaching a given section is one
 * click instead of toggle-then-scroll-then-expand.
 *
 * Icons come straight from `CONTEXT_BAR_SECTIONS` (`context-bar/registry.ts`),
 * the same list the bar itself draws from - one registry, so the rail and the
 * bar cannot drift the way two hand-kept lists would.
 *
 * Clicking a section's icon opens the bar if it is closed, expands that
 * section if it is collapsed, and scrolls it into view inside the bar's own
 * scroller with `scrollWithin` (`@/lib/scroll-within`, #1612) - never
 * `Element.scrollIntoView`, which would walk the shell's `overflow: hidden`
 * ancestors the way the settings pane's reveal bug did. Clicking the icon of
 * the section that is the only one expanded collapses the whole bar, which is
 * this rail's answer to a dedicated close button - ⌘I still toggles the bar
 * outright.
 *
 * Present in both `ContextBar` layout modes: below 1200px the bar overlays
 * `main` rather than pushing it, but the rail is a normal flex child beside
 * that overlay (`Shell.tsx`), never inside the positioned box the bar
 * overlays from - so it stays reachable exactly where it always is.
 *
 * No AppRegion of its own, unlike `ActivityRail`: the issue that added this
 * rail names the left one as the F6 cycle's fifth stop and says nothing about
 * this one, and the bar it fronts is already a stop (`region-focus.ts`'s
 * `"context"`).
 */

import { useCallback } from "react";
import { useLayoutStore, useTabsStore } from "@/stores";
import { scrollWithin } from "@/lib/scroll-within";
import { contextBarHasContent } from "./context-bar-content";
import { sectionsForTab } from "./context-bar/registry";
import type { ContextBarSection } from "./context-bar/types";
import { RailButton } from "./RailButton";

export function ContextRail() {
	const {
		contextBarOpen,
		setContextBarOpen,
		contextBarCollapsedSections,
		toggleContextBarSection,
	} = useLayoutStore();
	const { openTabs, activeTabId } = useTabsStore();
	const activeTab = openTabs.find((t) => t.id === activeTabId);

	/**
	 * Scroll to `sectionId` once the DOM has actually caught up.
	 *
	 * The click handler that calls this has just told two zustand stores to
	 * open the bar and expand the section - state updates React has not
	 * committed to the DOM yet at that point in the handler, so a target
	 * queried synchronously would still be missing or collapsed. A
	 * `requestAnimationFrame` runs after the browser's next paint, which is
	 * after React has committed the re-render those `set` calls triggered;
	 * this is deliberately not a `useEffect` keyed on the store state, which
	 * would call `setState` from inside an effect body and cascade another
	 * render for no reason - nothing here is React state to begin with.
	 */
	const scrollToSection = useCallback((sectionId: string) => {
		requestAnimationFrame(() => {
			const container = document.querySelector("[data-context-bar-scroller]");
			const target = document.querySelector(`[data-context-bar-section="${sectionId}"]`);
			if (container && target) scrollWithin(container, target, { block: "nearest" });
		});
	}, []);

	const onSectionClick = useCallback(
		(section: ContextBarSection, sections: readonly ContextBarSection[]) => {
			const wasCollapsed = contextBarCollapsedSections.includes(section.id);
			const expandedIds = sections
				.filter((s) => !contextBarCollapsedSections.includes(s.id))
				.map((s) => s.id);
			const isOnlyExpanded =
				!wasCollapsed && expandedIds.length === 1 && expandedIds[0] === section.id;

			if (contextBarOpen && isOnlyExpanded) {
				setContextBarOpen(false);
				return;
			}
			if (!contextBarOpen) setContextBarOpen(true);
			if (wasCollapsed) toggleContextBarSection(section.id);
			scrollToSection(section.id);
		},
		[
			contextBarOpen,
			contextBarCollapsedSections,
			setContextBarOpen,
			toggleContextBarSection,
			scrollToSection,
		]
	);

	if (!contextBarHasContent(activeTab)) return null;

	const sections = sectionsForTab(activeTab);

	return (
		<nav
			className="flex flex-col items-center gap-1 w-[var(--rail-width)] shrink-0 pt-2 border-l border-border bg-panel"
			aria-label="Context sections"
		>
			{sections.map((section) => {
				const expanded = !contextBarCollapsedSections.includes(section.id);
				const Icon = section.icon;
				return (
					<RailButton
						key={section.id}
						active={contextBarOpen && expanded}
						onClick={() => onSectionClick(section, sections)}
						label={section.title}
						side="right"
						variant="tile"
					>
						<Icon className="w-4 h-4" />
					</RailButton>
				);
			})}
		</nav>
	);
}
