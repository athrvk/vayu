/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The context bar: a frame, and a list of sections for the active tab.
 *
 * It used to be one section - a variables quick-editor - hardcoded into this
 * file and rendered for request tabs only. The sections now come from a
 * registry (`context-bar/registry.ts`); this file owns the landmark, the resize
 * handle, the header, the scroll container and the per-section collapse state,
 * and nothing about what any section shows.
 *
 * A section's component is mounted only while its section is expanded, so a
 * collapsed section runs no queries - see `Section.tsx`. Collapse state is
 * persisted per section id in `layout-store`, beside `contextBarWidth`.
 *
 * What each section says it has to say - `useRelevance` - is read here too, in
 * `ContextBarSectionSlot` below, which is the only part of the bar that knows a
 * section can be quiet or absent.
 */

import { Suspense } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { PanelResizeHandle } from "./PanelResizeHandle";
import { useLayoutStore, useTabsStore } from "@/stores";
import { DEFAULT_CONTEXT_BAR_WIDTH } from "@/constants/layout";
import { TooltipIconButton } from "@/components/ui";
import { contextBarHasContent } from "./context-bar-content";
import { regionProps } from "./region-focus";
import { sectionsForTab } from "./context-bar/registry";
import {
	ContextBarSectionEmptyHeader,
	ContextBarSectionFrame,
	SectionLoading,
} from "./context-bar/Section";
import type { ContextBarSection, SectionRelevance } from "./context-bar/types";
import type { Tab } from "@/stores";

interface ContextBarProps {
	mode?: "push" | "overlay";
}

/**
 * The relevance of a section that declares none: it always has content.
 *
 * A hook rather than a constant so that the one call site below stays
 * unconditional.
 */
function useAlwaysContent(): SectionRelevance {
	return "content";
}

interface ContextBarSectionSlotProps {
	section: ContextBarSection;
	tab: Tab;
	expanded: boolean;
	onToggle: () => void;
}

/**
 * One section's slot: what it has to say, and the frame that goes with the
 * answer.
 *
 * The `useRelevance` call lives in a component of its own rather than in the
 * loop above it because the applicable section list changes with the tab, and a
 * hook called once per member of a list whose length changes is the rules of
 * hooks broken. A component per section, keyed by the section id - unique, and
 * pinned so by `registry.test.tsx` - gives every hook a mount of its own:
 * React unmounts the slot when its id leaves the list, so no instance ever ends
 * up calling a different section's hook in the same position.
 */
function ContextBarSectionSlot({ section, tab, expanded, onToggle }: ContextBarSectionSlotProps) {
	// A section that declares no relevance has content by definition. The
	// fallback is itself a hook so that this call is unconditional; which hook it
	// is cannot change for the life of the slot, because the id it is keyed by
	// cannot.
	const useRelevance = section.useRelevance ?? useAlwaysContent;
	const relevance = useRelevance(tab);

	if (relevance === "hidden") return null;
	if (relevance !== "content") {
		return <ContextBarSectionEmptyHeader title={section.title} note={relevance.empty} />;
	}

	const { Component } = section;
	return (
		<ContextBarSectionFrame title={section.title} expanded={expanded} onToggle={onToggle}>
			{/* Per section, not around the list: a section whose code is still
			    arriving must not blank the ones already on screen. `SectionLoading`
			    is what a section shows while its own query is in flight, so a
			    loading chunk reads the same as loading data - which, to the reader,
			    it is. */}
			<Suspense fallback={<SectionLoading />}>
				<Component tab={tab} />
			</Suspense>
		</ContextBarSectionFrame>
	);
}

export function ContextBar({ mode = "push" }: ContextBarProps) {
	const {
		contextBarOpen,
		setContextBarOpen,
		contextBarWidth,
		setContextBarWidth,
		contextBarCollapsedSections,
		toggleContextBarSection,
	} = useLayoutStore();
	const { openTabs, activeTabId } = useTabsStore();
	const activeTab = openTabs.find((t) => t.id === activeTabId);

	if (!contextBarOpen || !contextBarHasContent(activeTab)) return null;

	// `activeTab` is non-null here: `contextBarHasContent` is false without one.
	const sections = sectionsForTab(activeTab);
	const tab = activeTab!;

	return (
		/* <aside>, so the bar is a landmark a screen reader can jump to, the same
		   way the Drawer facing it across the window already is. It was an
		   anonymous <div>, so the left panel could be reached by landmark
		   navigation and the right one could not.

		   No `border-l` here: the resize handle paints its own 1px hairline, and
		   the two together drew a doubled 2px edge - the Drawer's identical handle
		   is what the single line should look like. */
		<aside
			className={cn(
				"flex flex-col shrink-0 bg-panel",
				mode === "overlay" ? "absolute right-0 top-0 bottom-0 shadow-lg z-10" : "relative"
			)}
			style={{ width: contextBarWidth }}
			aria-label="Context sidebar"
			// A stop in the F6 cycle - see `region-focus.ts`.
			{...regionProps("context")}
		>
			<PanelResizeHandle
				side="left"
				width={contextBarWidth}
				setWidth={setContextBarWidth}
				defaultWidth={DEFAULT_CONTEXT_BAR_WIDTH}
				label="Resize context bar"
			/>

			{/* Header */}
			<div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
				<span className="text-xs font-medium text-foreground">Context</span>
				<TooltipIconButton
					label="Close context bar"
					icon={<X className="w-3.5 h-3.5" />}
					className="h-6 w-6"
					tooltipSide="bottom"
					onClick={() => setContextBarOpen(false)}
				/>
			</div>

			{/* The sections.

			    The scroll lives here rather than on the root. With it on the root,
			    the root was both the scroll container and the handle's positioning
			    context, so scrolling the list carried the drag strip, the header
			    and the close button out of view and left the lower edge
			    un-draggable - `Drawer.tsx` puts the overflow on an inner wrapper
			    for exactly this reason. `min-h-0` because a flex child's default
			    `min-height: auto` refuses to shrink below its content, which would
			    push the overflow back up to the root. */}
			<div className="flex-1 min-h-0 overflow-y-auto px-3 py-1 divide-y divide-border">
				{sections.map((section) => (
					<ContextBarSectionSlot
						key={section.id}
						section={section}
						tab={tab}
						expanded={!contextBarCollapsedSections.includes(section.id)}
						onToggle={() => toggleContextBarSection(section.id)}
					/>
				))}
			</div>
		</aside>
	);
}
