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

import { useCallback, useEffect, useRef } from "react";
import { useLayoutStore, useTabsStore, type Tab } from "@/stores";
import { scrollWithin } from "@/lib/scroll-within";
import { contextBarHasContent } from "./context-bar-content";
import { sectionsForTab } from "./context-bar/registry";
import type { ContextBarSection, SectionRelevance } from "./context-bar/types";
import { RailButton } from "./RailButton";

/** A section that declares no relevance hook has content by definition - the
 *  same fallback `ContextBarSectionSlot` (`ContextBar.tsx`) uses, duplicated
 *  rather than imported: it is a one-line stand-in, and importing a component
 *  file's internal here for it would be the bigger coupling. */
function useAlwaysContent(): SectionRelevance {
	return "content";
}

/**
 * Calls one section's relevance hook and reports the verdict up, without
 * rendering anything of its own.
 *
 * A component of its own, not a loop over `sections` in `ContextRail` itself,
 * for the same rules-of-hooks reason `ContextBarSectionSlot` is: the
 * applicable section list changes with the tab, so a hook called at list
 * position N in one render and position N in a differently-shaped list next
 * render is not the same hook call. Keyed by `section.id` (stable, unique -
 * `registry.test.tsx` pins it), every instance keeps its own hook identity
 * across a section list that grows, shrinks or reorders.
 *
 * Calling the same relevance hook a second time (once here, once in
 * `ContextBarSectionSlot`) is not a second query: `SectionRelevanceHook`'s own
 * contract (`types.ts`) is to read the same cache entry the section component
 * reads, which is the whole point of it being a hook rather than a plain
 * function.
 */
function RelevanceReporter({
	section,
	tab,
	onRelevance,
}: {
	section: ContextBarSection;
	tab: Tab;
	onRelevance: (id: string, relevance: SectionRelevance) => void;
}) {
	const useRelevance = section.useRelevance ?? useAlwaysContent;
	const relevance = useRelevance(tab);
	useEffect(() => {
		onRelevance(section.id, relevance);
	}, [section.id, relevance, onRelevance]);
	return null;
}

export function ContextRail() {
	const {
		contextBarOpen,
		setContextBarOpen,
		contextBarCollapsedSections,
		toggleContextBarSection,
	} = useLayoutStore();
	const { openTabs, activeTabId } = useTabsStore();
	const activeTab = openTabs.find((t) => t.id === activeTabId);

	// Read by `onSectionClick` only, never for rendering - a ref rather than
	// state, so a relevance answer settling does not itself cost a render.
	const relevanceRef = useRef<Map<string, SectionRelevance>>(new Map());
	const onRelevance = useCallback((id: string, relevance: SectionRelevance) => {
		relevanceRef.current.set(id, relevance);
	}, []);

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
			// A section whose relevance is `"hidden"` or `{ empty }` renders
			// `ContextBarSectionEmptyHeader` (`Section.tsx`) - a plain header with
			// no trigger - rather than `ContextBarSectionFrame`'s real collapse
			// chrome. It never enters `contextBarCollapsedSections`, because there
			// is no toggle to add it with, so counting every section id not in
			// that list (the old check) treated it as permanently "expanded": on a
			// tab where any section has nothing to say, `expandedIds.length` could
			// never fall back to 1, and a rail click could open sections but never
			// close the bar. `relevanceRef` (`RelevanceReporter` above) is the real
			// signal; a section this rail has not heard from yet (relevance still
			// unsettled, or the map genuinely has nothing for it) defaults to
			// `"content"` rather than being excluded - the same reason
			// `SectionRelevanceHook`'s own contract picks `"content"` for "not
			// known yet" (`types.ts`): treating an unsettled section as expanded
			// is the safer failure (a click that scrolls to it instead of closing
			// the bar), not the other way around.
			const expandedIds = sections
				.filter((s) => {
					if (contextBarCollapsedSections.includes(s.id)) return false;
					return (relevanceRef.current.get(s.id) ?? "content") === "content";
				})
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

	// Non-null past the guard above: `contextBarHasContent` is false without
	// one, the same reasoning `ContextBar.tsx`'s identical guard uses.
	const tab = activeTab!;
	const sections = sectionsForTab(activeTab);

	return (
		<nav
			className="flex flex-col items-center gap-1 w-[var(--rail-width)] shrink-0 pt-2 border-l border-border bg-panel"
			aria-label="Context sections"
		>
			{/* Relevance probes, not rendered chrome - `onSectionClick` is the only
			    reader, and it needs nothing while the bar is closed (opening it
			    never depends on which sections currently have content). */}
			{contextBarOpen &&
				sections.map((section) => (
					<RelevanceReporter
						key={section.id}
						section={section}
						tab={tab}
						onRelevance={onRelevance}
					/>
				))}
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
