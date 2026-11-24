/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The right-edge counterpart to `ActivityRail` (#1615): one icon per section the context bar has
 * for the active tab, so reaching a section is one click instead of toggle, scroll, expand.
 *
 * Icons come from `CONTEXT_BAR_SECTIONS` (`context-bar/registry.ts`), the list the bar draws from,
 * so the rail and the bar cannot drift.
 *
 * A click opens the bar if closed, expands the section if collapsed, and scrolls it into view
 * inside the bar's scroller with `scrollWithin` (`@/lib/scroll-within`, #1612), never
 * `Element.scrollIntoView`, which would walk the shell's `overflow: hidden` ancestors. Clicking the
 * only expanded section's icon closes the whole bar, this rail's close button; ⌘I still toggles the
 * bar outright.
 *
 * One Tab stop for the rail, Up/Down between sections, `ActivityRail`'s roving model
 * (`useRovingStop`), so several sections are not several Tab presses to get past.
 *
 * Present in both `ContextBar` modes: below `CONTEXT_BAR_PUSH_MIN_WIDTH` the bar overlays `main`,
 * but the rail is a flex child beside that overlay (`Shell.tsx`), never inside its positioned box,
 * so it stays where it always is.
 */

import { useCallback, useEffect, useRef } from "react";
import { useLayoutStore, useTabsStore, type Tab } from "@/stores";
import { scrollWithin } from "@/lib/scroll-within";
import { contextBarHasContent } from "./context-bar-content";
import { sectionsForTab } from "./context-bar/registry";
import type { ContextBarSection, SectionRelevance } from "./context-bar/types";
import { RailButton } from "./RailButton";
import { regionProps } from "./region-focus";
import { useRovingStop } from "./useRovingStop";

/**
 * No relevance hook means content, as in `ContextBarSectionSlot` (`ContextBar.tsx`); duplicated, as
 * importing a component file's internal for one line is the bigger coupling.
 */
function useAlwaysContent(): SectionRelevance {
	return "content";
}

/**
 * Calls one section's relevance hook and reports the verdict up, rendering nothing.
 *
 * A component per section, not a loop in `ContextRail`, for `ContextBarSectionSlot`'s
 * rules-of-hooks reason: the section list changes with the tab. Keyed by `section.id` (stable,
 * unique, pinned by `registry.test.tsx`), each instance keeps its hook identity as the list grows,
 * shrinks or reorders.
 *
 * Calling the relevance hook here and in `ContextBarSectionSlot` is not a second query: the
 * `SectionRelevanceHook` contract (`types.ts`) is to read the section component's cache entry,
 * which is why it is a hook and not a function.
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
	const contextBarOpen = useLayoutStore((s) => s.contextBarOpen);
	const setContextBarOpen = useLayoutStore((s) => s.setContextBarOpen);
	const contextBarCollapsedSections = useLayoutStore((s) => s.contextBarCollapsedSections);
	const toggleContextBarSection = useLayoutStore((s) => s.toggleContextBarSection);
	const openTabs = useTabsStore((s) => s.openTabs);
	const activeTabId = useTabsStore((s) => s.activeTabId);
	const activeTab = openTabs.find((t) => t.id === activeTabId);
	const sections = sectionsForTab(activeTab);
	const navRef = useRef<HTMLElement>(null);

	// The stop follows the first expanded section, or the first section when all are collapsed: the
	// rail must never have no stop.
	const sectionIds = sections.map((s) => s.id);
	const firstExpanded = sectionIds.find((id) => !contextBarCollapsedSections.includes(id));
	const [rovingSection, setRovingSection] = useRovingStop(
		firstExpanded ?? sectionIds[0] ?? null,
		sectionIds
	);

	/**
	 * Up/Down move focus without activating, as in `ActivityRail`: arrowing past a section must not
	 * toggle it.
	 */
	const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
		if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;

		const buttons = Array.from(navRef.current?.querySelectorAll<HTMLElement>("button") ?? []);
		const current = buttons.findIndex((el) => el === document.activeElement);
		if (current === -1) return;

		const next =
			e.key === "ArrowDown"
				? (current + 1) % buttons.length
				: (current - 1 + buttons.length) % buttons.length;

		e.preventDefault();
		setRovingSection(sectionIds[next]);
		buttons[next].focus();
	};

	// Read only by `onSectionClick`, never to render: a ref, so a settling relevance costs no
	// render.
	const relevanceRef = useRef<Map<string, SectionRelevance>>(new Map());
	const onRelevance = useCallback((id: string, relevance: SectionRelevance) => {
		relevanceRef.current.set(id, relevance);
	}, []);

	/**
	 * Scroll to `sectionId` once the DOM has caught up. The click handler has just told two stores
	 * to open the bar and expand the section, which React has not committed yet, so a synchronous
	 * query would find it missing or collapsed; a `requestAnimationFrame` runs after that commit.
	 * Not a `useEffect` on the store state: that would `setState` inside an effect and cascade a
	 * render, and nothing here is React state.
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
			// Only a section drawing `ContextBarSectionFrame`'s collapse chrome can count as
			// expanded. A `{ empty }` verdict draws `ContextBarSectionEmptyHeader` (`Section.tsx`)
			// and a `"hidden"` one nothing; neither has a toggle, so neither ever enters
			// `contextBarCollapsedSections`, and counting every id not in it would leave
			// `expandedIds.length` unable to reach 1 and a click unable to close the bar.
			// `relevanceRef` is the signal. A section not heard from yet defaults to `"content"`,
			// as the `SectionRelevanceHook` contract does for "not known yet" (`types.ts`): an
			// unsettled section taken as expanded fails safe, a click that scrolls to it instead of
			// closing the bar.
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

	// Non-null past the guard: `contextBarHasContent` is false without one, as in `ContextBar.tsx`.
	const tab = activeTab!;

	return (
		// eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- roving tabindex for Up/Down between the section buttons, the same shape ActivityRail uses on the left edge; the rail is deliberately `role="toolbar"`-free, so this lands on a landmark rather than a widget role
		<nav
			ref={navRef}
			onKeyDown={onKeyDown}
			className="flex flex-col items-center gap-1 w-[var(--rail-width)] shrink-0 pt-2 border-l border-border bg-panel"
			aria-label="Context sections"
			// An F6 stop (`region-focus.ts`) like the activity rail: on screen while the bar it
			// opens is closed.
			{...regionProps("context-rail")}
		>
			{/*
			 * Relevance probes, not chrome, mounted only while the bar is open: `onSectionClick` is
			 * their only reader, and opening a closed bar never depends on which sections have
			 * content.
			 */}
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
						tabIndex={section.id === rovingSection ? 0 : -1}
					>
						<Icon className="size-icon" />
					</RailButton>
				);
			})}
		</nav>
	);
}
