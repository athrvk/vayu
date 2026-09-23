/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One tab in `TabStrip`, in its own module so `TabStrip.render-count.test.tsx`
 * can `vi.mock` it: the real implementation (`TabItemImpl`) is exported
 * alongside the memoized default so a test can wrap it in its own counting
 * `memo` rather than the component carrying render-counting instrumentation
 * itself (#1714). The comparator lives in `tab-item-props-equal.ts`, not
 * here - see that file for why.
 */

import { memo } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTabsStore, type Tab } from "@/stores";
import { ICON_MOTION } from "@/components/ui";
import { RowContextMenu, ScrollOnOverflow } from "@/components/shared";
// Labels and icons live beside TabStrip, not in it: the command palette lists
// the same tabs and must name them identically. See tab-descriptors.ts.
import { type TabDescriptor } from "./tab-descriptors";
// What a tab can do, beside what it is called and for the same reason.
import { useTabActions } from "./tab-actions";
import { getMethodColor } from "@/lib/method-display";
// The tab -> panel ids, shared with Shell, which renders the panel end of the
// relationship. See tab-aria.ts.
import { tabElementId, tabPanelElementId } from "./tab-aria";
import { closeTabFromKeyboard } from "./tab-focus";
import { tabItemPropsEqual } from "./tab-item-props-equal";

export interface TabItemProps {
	tab: Tab;
	isActive: boolean;
	width: number;
	descriptor: TabDescriptor;
}

export function TabItemImpl({ tab, isActive, width, descriptor }: TabItemProps) {
	// Actions only - stable references, so TabItem never re-renders on a store
	// write that leaves its own isActive/descriptor props untouched (#1714).
	const focusTab = useTabsStore((s) => s.focusTab);
	const closeTab = useTabsStore((s) => s.closeTab);
	// What this tab can do, beside what it is called. See tab-actions.ts.
	const actions = useTabActions(tab, descriptor);
	// Roving tabindex: the strip is one Tab stop, and Left/Right move within it.
	// Previously every tab carried tabIndex={0}, so a developer with a dozen tabs
	// open had to press Tab a dozen times to get past the strip.
	const rovingTabIndex = isActive ? 0 : -1;
	const Icon = descriptor.icon;

	return (
		/*
		 * Right-click, and the Menu key and Shift+F10 the platform raises the
		 * same `contextmenu` event for - so the keyboard path here is the
		 * browser's own, not a second handler that would open a menu beside the
		 * one Chromium already asked for. The tree needs its own key handling
		 * because its keys reach a `⋯` button; a tab has none to reach.
		 */
		<RowContextMenu label={`More actions for ${descriptor.title}`} actions={actions}>
			<div
				role="tab"
				id={tabElementId(tab.id)}
				aria-selected={isActive}
				aria-controls={tabPanelElementId(tab.id)}
				tabIndex={rovingTabIndex}
				data-tab-id={tab.id}
				title={descriptor.title}
				style={{ width, minWidth: width }}
				onClick={() => focusTab(tab.id)}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						// Space would otherwise scroll the strip's overflow container.
						e.preventDefault();
						focusTab(tab.id);
					}
					// Closing was mouse-only: the X is `tabIndex={-1}` and only appears
					// on hover, and no close shortcut existed anywhere in the app. Delete
					// on the focused tab is the WAI-ARIA pattern for a deletable tab.
					// Backspace is the same key on a Mac keyboard: the one labelled
					// "delete" there reports `"Backspace"`, and `"Delete"` is
					// forward-delete (Fn+Delete), so a `"Delete"`-only handler closes
					// nothing on macOS (#931). Accepted on every platform rather than
					// behind an `isMac` fork - a tab is a view, so closing one loses no
					// work and the request it showed is still in its collection.
					if (e.key === "Delete" || e.key === "Backspace") {
						e.preventDefault();
						// Through the shared helper, because this tab is what holds
						// focus: closing it plainly drops the user on `<body>` (#1218).
						closeTabFromKeyboard(tab.id);
					}
				}}
				onAuxClick={(e) => {
					// Middle-click closes, like browsers
					if (e.button === 1) closeTab(tab.id);
				}}
				data-active={isActive}
				className={cn(
					// `key={tab.id}` (in TabStrip, where this is mapped) makes a
					// genuinely new tab a fresh node - `.enter-fade` fades it in rather
					// than popping it into a strip full of tabs that did not just move.
					// An existing tab re-rendering keeps its node, so this never
					// re-fires for one - only a real open does.
					"enter-fade",
					"group relative flex h-full shrink-0 cursor-pointer select-none items-center gap-1.5",
					// px-3 (issue #1679), not the old pl-2 pr-2.5 - see tab-fit.ts's
					// TAB_CHROME for the reserved-width side of this.
					"border-r border-border/40 px-3 text-sm",
					// The rule sits on the edge the content is on, and matches the
					// section tabs. It reads identically in both themes, unlike a
					// surface shift, which light mode carries far more weakly (see
					// --tab-active). A stable base plus a `data-active` modifier
					// rather than the two-branch ternary this replaced: that ternary
					// swapped the *entire* class string, so the active tab's `after:`
					// bar and the inactive tab's `border-b` never coexisted as the
					// same element with a changing value - one was simply absent,
					// which nothing can transition between. Both are always present
					// now, `border-b-border`/`after:bg-transparent` at rest, so
					// switching the active tab only ever changes a colour.
					// `after:transition-colors` is its own line: a pseudo-element
					// paints its background separately from the box it is on, so the
					// element's own colour transition does not reach it.
					//
					// `transition-[...]` explicit, not `transition-colors`: this
					// element also carries `.enter-fade`, whose own `transition:
					// opacity ...` is a full shorthand that a plain `transition-colors`
					// utility (a different, later-cascading `@layer utilities` rule)
					// silently replaces rather than merges with - confirmed live via
					// computed `transitionProperty`, opacity was missing from the list
					// entirely and a new tab never faded in. Naming every property
					// this element transitions in one utility is the same fix applied
					// everywhere else this bug turned up this session.
					"transition-[background-color,color,border-color,opacity] duration-150",
					"bg-transparent text-muted-foreground",
					"border-b border-b-border",
					"data-[active=false]:hover:bg-muted/50 data-[active=false]:hover:text-foreground",
					"data-[active=true]:bg-tab-active data-[active=true]:text-foreground data-[active=true]:border-b-transparent",
					"after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-transparent after:transition-colors",
					"data-[active=true]:after:bg-primary"
				)}
			>
				{/* The method, as 2px of colour rather than up to 36px of text. */}
				{descriptor.method && (
					<span
						aria-hidden="true"
						className="absolute inset-y-1.5 left-0 w-0.5 rounded-full"
						style={{ background: `hsl(${getMethodColor(descriptor.method)})` }}
					/>
				)}
				{Icon && <Icon className="size-icon-sm shrink-0" />}
				{/*
				 * ScrollOnOverflow is kept: it reads the full name on hover, which an
				 * ellipsis cannot. The ellipsis is what was missing - it clipped
				 * mid-glyph with no mark at all when nothing was hovering.
				 */}
				<ScrollOnOverflow className="min-w-0 flex-1">
					<span className={cn("block truncate", descriptor.isPath && "tab-path")}>
						{descriptor.label}
					</span>
				</ScrollOnOverflow>
				{/* eslint-disable-next-line jsx-a11y/click-events-have-key-events -- close is a keyboard action on the focused `role="tab"` row (Delete/Backspace above); this span is `tabIndex={-1}` on purpose, a pointer affordance for the same thing */}
				<span
					role="button"
					tabIndex={-1}
					aria-label="Close tab"
					onClick={(e) => {
						e.stopPropagation();
						closeTab(tab.id);
					}}
					// Absolute, over the trailing padding: in the flow it reserved 22px on
					// every tab for a control only the hovered or active one ever shows.
					// `size-target` (issue #1679, 24px - was a 16px hit box): the
					// close button is a real interactive target and sat under the
					// WCAG 2.2 SC 2.5.8 24x24px floor. The glyph inside stays
					// `size-icon-sm` (12px, unchanged) - only the hit area grew, and
					// `tab-fit.ts`'s TAB_CLOSE_SPACE reserves strip width for it.
					// `transition-[opacity,background-color]`, not `transition-opacity`:
					// this is `role="button"`, which the baseline (`index.css`) would
					// otherwise cover for free, but a scoped `transition-*` utility here
					// overrides that shorthand rather than merging with it - narrowing
					// coverage to opacity alone and leaving `hover:bg-muted` untransitioned.
					className="absolute right-0.5 flex size-target items-center justify-center rounded-md opacity-0 transition-[opacity,background-color,scale] duration-150 active:scale-[0.98] hover:bg-muted focus-visible:opacity-100 group-hover:opacity-100 data-[active=true]:opacity-100"
					data-active={isActive}
				>
					<X className="size-icon-sm" data-icon-motion={ICON_MOTION.rotate90} />
				</span>
			</div>
		</RowContextMenu>
	);
}

const TabItem = memo(TabItemImpl, tabItemPropsEqual);

export default TabItem;
