/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The context bar: a frame, and a list of sections for the active tab.
 *
 * The sections come from a registry (`context-bar/registry.ts`); this file owns the landmark, the
 * resize handle, the header, the scroll container and the per-section collapse state, and nothing
 * about what any section shows.
 *
 * A section's component is mounted only while it is expanded, so a collapsed section runs no
 * queries (`Section.tsx`). Collapse state is persisted per section id in `layout-store`, beside
 * `contextBarWidth`. Each section's `useRelevance` is read in `ContextBarSectionSlot`, the only
 * part of the bar that knows a section can be quiet or absent.
 */

import { Suspense } from "react";
import { X } from "lucide-react";
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import { cn } from "@/lib/utils";
import { PanelResizeHandle } from "./PanelResizeHandle";
import { useLayoutStore, useTabsStore } from "@/stores";
import { DEFAULT_CONTEXT_BAR_WIDTH, type SidePanelMode } from "@/constants/layout";
import { Collapsible, TooltipIconButton } from "@/components/ui";
import { contextBarHasContent } from "./context-bar-content";
import { regionProps } from "./region-focus";
import { useOverlayPanel } from "./useOverlayPanel";
import { sectionsForTab } from "./context-bar/registry";
import {
	ContextBarSectionEmptyHeader,
	ContextBarSectionFrame,
	SectionLoading,
} from "./context-bar/Section";
import type { ContextBarSection, SectionRelevance } from "./context-bar/types";
import type { Tab } from "@/stores";

interface ContextBarProps {
	mode?: SidePanelMode;
	/** The drawer's mode, for the one-overlay-at-a-time rule (`useOverlayPanel`). */
	siblingMode?: SidePanelMode;
}

/**
 * The relevance of a section that declares none. A hook, not a constant, so the call stays
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
 * One section's slot: what it has to say, and the frame for that answer.
 *
 * `useRelevance` is called in a component of its own, not in the loop, because the applicable list
 * changes with the tab and a hook called once per member of a changing list breaks the rules of
 * hooks. Keyed by section id (unique, pinned by `registry.test.tsx`), each slot unmounts when its
 * id leaves the list, so no instance ever calls another section's hook in the same position.
 */
function ContextBarSectionSlot({ section, tab, expanded, onToggle }: ContextBarSectionSlotProps) {
	// Which hook this is cannot change for the slot's life, because the id it is keyed by cannot.
	const useRelevance = section.useRelevance ?? useAlwaysContent;
	const relevance = useRelevance(tab);

	if (relevance === "hidden") return null;
	if (relevance !== "content") {
		return <ContextBarSectionEmptyHeader title={section.title} note={relevance.empty} />;
	}

	const { Component } = section;
	return (
		<ContextBarSectionFrame title={section.title} expanded={expanded} onToggle={onToggle}>
			{/*
			 * Per section, not around the list: a section whose code is still arriving must not
			 * blank the ones on screen. `SectionLoading` is what a section shows while its query is
			 * in flight, so a loading chunk reads as loading data, which to the reader it is.
			 */}
			<Suspense fallback={<SectionLoading />}>
				<Component tab={tab} />
			</Suspense>
		</ContextBarSectionFrame>
	);
}

export function ContextBar({ mode = "push", siblingMode = "push" }: ContextBarProps) {
	const contextBarOpen = useLayoutStore((s) => s.contextBarOpen);
	const setContextBarOpen = useLayoutStore((s) => s.setContextBarOpen);
	const contextBarWidth = useLayoutStore((s) => s.contextBarWidth);
	const setContextBarWidth = useLayoutStore((s) => s.setContextBarWidth);
	const contextBarCollapsedSections = useLayoutStore((s) => s.contextBarCollapsedSections);
	const toggleContextBarSection = useLayoutStore((s) => s.toggleContextBarSection);
	const openTabs = useTabsStore((s) => s.openTabs);
	const activeTabId = useTabsStore((s) => s.activeTabId);
	const activeTab = openTabs.find((t) => t.id === activeTabId);
	const panelRef = useOverlayPanel({ panel: "context", mode, siblingMode });

	// A tab with no applicable section has no bar, unlike closed (below): it never animates, as
	// there is nothing to reveal.
	if (!contextBarHasContent(activeTab)) return null;

	// `activeTab` is non-null here: `contextBarHasContent` is false without one.
	const sections = sectionsForTab(activeTab);
	const tab = activeTab!;

	return (
		// `asChild` on both `Collapsible` and `CollapsibleContent` (used directly, not
		// `collapsible.tsx`'s vertical-only wrapper) means neither renders a node, so the `<aside>`
		// itself is the animated element; closed-and-settled is still nothing in the tree.
		<Collapsible asChild open={contextBarOpen} onOpenChange={setContextBarOpen}>
			<CollapsiblePrimitive.CollapsibleContent asChild className="rail-collapse">
				{/*
				 * <aside>, so the bar is a landmark a screen reader can jump to, like the Drawer
				 * facing it.
				 *
				 * No `border-l`: the resize handle paints its own 1px hairline, and a border beside
				 * it doubles the edge to 2px.
				 */}
				<aside
					ref={panelRef}
					className={cn(
						"flex flex-col shrink-0 bg-panel",
						mode === "overlay"
							? "absolute right-0 top-0 bottom-0 shadow-lg z-10"
							: "relative"
					)}
					style={{ width: contextBarWidth }}
					aria-label="Context sidebar"
					// A stop in the F6 cycle - see `region-focus.ts`.
					{...regionProps("context")}
				>
					<PanelResizeHandle
						side="left"
						size={contextBarWidth}
						setSize={setContextBarWidth}
						defaultSize={DEFAULT_CONTEXT_BAR_WIDTH}
						label="Resize context bar"
					/>

					{/* Header */}
					<div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
						<span className="text-xs font-medium text-foreground">Context</span>
						<TooltipIconButton
							label="Close context bar"
							icon={<X className="size-icon-sm" />}
							tooltipSide="bottom"
							onClick={() => setContextBarOpen(false)}
						/>
					</div>

					{/*
					 * The sections. The scroll lives here, not on the root: the root is the
					 * handle's positioning context, so scrolling it would carry the drag strip, the
					 * header and the close button out of view and leave the lower edge undraggable
					 * (`Drawer.tsx` does the same). `min-h-0` because a flex child's default
					 * `min-height: auto` will not shrink below its content, which would push the
					 * overflow back to the root.
					 */}
					<div
						className="flex-1 min-h-0 overflow-y-auto px-3 py-1 divide-y divide-border"
						// Where the Context Rail's `scrollWithin` scrolls, and nothing above it
						// (app/CLAUDE.md, "Reveal inside the scroller you mean", #1612).
						data-context-bar-scroller
					>
						{sections.map((section) => (
							// The wrapper carries the anchor, not the slot: a "hidden" verdict
							// renders nothing, and an element that may not exist is no scroll
							// target.
							<div key={section.id} data-context-bar-section={section.id}>
								<ContextBarSectionSlot
									section={section}
									tab={tab}
									expanded={!contextBarCollapsedSections.includes(section.id)}
									onToggle={() => toggleContextBarSection(section.id)}
								/>
							</div>
						))}
					</div>
				</aside>
			</CollapsiblePrimitive.CollapsibleContent>
		</Collapsible>
	);
}
