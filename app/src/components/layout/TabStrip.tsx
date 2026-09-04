/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * TabStrip Component
 *
 * The horizontal row of open tabs, rendered over the content area - main plus
 * the context bar - with the drawer to its left. It sits there rather than
 * across the window because that is the region tabs actually switch: the drawer
 * is a global navigator and keeps its own header band beside this row. Reads
 * from tabs-store; one TabItem per open tab plus a "+" button that opens a
 * welcome tab. No unsaved-dot - autosave is the safety net.
 *
 * **A tab is as wide as its own name, and the strip overflows rather than
 * compressing.** It used to do the reverse - `min-w-20 max-w-50 shrink` shrank
 * every tab together, so opening a ninth made the other eight worse, and how
 * bad it got depended on the platform, because macOS, Windows and Linux each
 * leave a different amount of strip. With eight open at ~1450px each got about
 * 140px, of which 71px was chrome, leaving 93px for a name that wanted 104.
 *
 * Where that 71px went, and where it went instead:
 *
 * - **The method was a word.** "GET" cost 18px and "DELETE" 36px, so a tab's
 *   width depended on its verb. It is a 2px colour rail now. The colour was
 *   always the point - the sidebar says the same thing the same way - and a
 *   rail keeps it for 2px.
 * - **The close button was reserved on every tab.** `opacity-0` hides a control
 *   without giving back its space, so all eight paid 22px for something shown
 *   on one. It is absolutely positioned over the trailing padding now.
 * - **Nothing said the text was cut.** `ScrollOnOverflow` clips with
 *   `overflow-hidden` and no ellipsis, so a name ended mid-glyph and eight tabs
 *   all looked like a rendering fault. The ellipsis is back; the hover-scroll
 *   it was hiding behind is untouched and still reads the full name.
 *
 * Path-shaped labels are cut from the *left*. `/v1/orders` and `/v1/orders/42`
 * differ only in the part a right-hand ellipsis removes first.
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { X, Plus, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTabsStore, type Tab } from "@/stores";
import { TAB_NEW_BUTTON_WIDTH } from "@/constants/layout";
import { ScrollOnOverflow, RowContextMenu } from "@/components/shared";
import {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuItem,
} from "@/components/ui";
import { fitTabs, makeTextMeasurer, naturalTabWidth } from "./tab-fit";
// Labels and icons live beside this file, not in it: the command palette lists
// the same tabs and must name them identically. See tab-descriptors.ts.
import { useTabDescriptors, type TabDescriptor } from "./tab-descriptors";
// What a tab can do, beside what it is called and for the same reason.
import { useTabActions } from "./tab-actions";
import { getMethodColor } from "@/utils";
// The tab -> panel ids, shared with Shell, which renders the panel end of the
// relationship. See tab-aria.ts.
import { tabElementId, tabPanelElementId } from "./tab-aria";
import { closeTabFromKeyboard } from "./tab-focus";

function TabItem({
	tab,
	isActive,
	width,
	descriptor,
}: {
	tab: Tab;
	isActive: boolean;
	width: number;
	descriptor: TabDescriptor;
}) {
	const { focusTab, closeTab } = useTabsStore();
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
				className={cn(
					"group relative flex h-full shrink-0 cursor-pointer select-none items-center gap-1.5",
					"border-r border-border/40 pl-2 pr-2.5 text-sm",
					isActive
						? // The rule sits on the edge the content is on, and matches the
							// section tabs. It reads identically in both themes, unlike a
							// surface shift, which light mode carries far more weakly
							// (see --tab-active).
							"bg-tab-active text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-primary"
						: "border-b border-b-border bg-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground"
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
				{Icon && <Icon className="w-3 h-3 shrink-0" />}
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
				{/* eslint-disable-next-line jsx-a11y/click-events-have-key-events -- close is a keyboard action on the focused `role="tab"` row (Delete/Backspace, TabStrip.tsx:109-114); this span is `tabIndex={-1}` on purpose, a pointer affordance for the same thing */}
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
					className="absolute right-0.5 rounded-md p-0.5 opacity-0 transition-opacity hover:bg-muted focus-visible:opacity-100 group-hover:opacity-100 data-[active=true]:opacity-100"
					data-active={isActive}
				>
					<X className="w-3 h-3" />
				</span>
			</div>
		</RowContextMenu>
	);
}

export function TabStrip() {
	const { openTabs, activeTabId, openTab, focusTab } = useTabsStore();
	const listRef = useRef<HTMLDivElement>(null);
	const [available, setAvailable] = useState(0);
	const [font, setFont] = useState("13px sans-serif");

	// Descriptors first: the strip has to know what each tab says before it can
	// decide how many fit.
	const descriptors = useTabDescriptors(openTabs);

	/** Remeasure on resize - the strip's width is whatever the chrome leaves it. */
	useLayoutEffect(() => {
		const el = listRef.current;
		if (!el) return;
		const read = () => {
			setAvailable(el.clientWidth);
			// The user can change the interface font and scale, so the measuring
			// font is read from the strip rather than assumed.
			const cs = getComputedStyle(el);
			setFont(`${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`);
		};
		read();
		if (typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(read);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const measure = useMemo(() => makeTextMeasurer(font), [font]);
	const widths = descriptors.map((d) =>
		naturalTabWidth({ label: d.label, hasIcon: Boolean(d.icon) }, measure)
	);
	const activeIndex = openTabs.findIndex((t) => t.id === activeTabId);
	const { visible, overflowed } = fitTabs(widths, available, activeIndex);

	/**
	 * Arrow-key navigation across the strip.
	 *
	 * `role="tablist"` is a promise that arrow keys work, and it was not being
	 * kept - the only key handling was Enter/Space on an individual tab. Handled
	 * here by delegation rather than per-tab so the tabs stay ignorant of their
	 * neighbours, and read off the DOM so the order always matches what is
	 * rendered.
	 *
	 * Focus moves without activating (`aria-selected` follows the click, not the
	 * arrow). With a heavy tab like a dashboard in the strip, activate-on-arrow
	 * would fire a mount for every tab you skate past.
	 */
	const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
		const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
		if (!keys.includes(e.key)) return;

		const tabs = Array.from(
			listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []
		);
		if (tabs.length === 0) return;

		const current = tabs.findIndex((el) => el === document.activeElement);
		if (current === -1) return;

		let next = current;
		if (e.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
		if (e.key === "ArrowRight") next = (current + 1) % tabs.length;
		if (e.key === "Home") next = 0;
		if (e.key === "End") next = tabs.length - 1;

		e.preventDefault();
		// Reset every tab before promoting the destination, the shape `focusItem`
		// in useRovingTreeFocus uses. Setting the destination alone leaked a tab
		// stop per arrow press: this is a DOM mutation on top of a vdom prop that
		// did not change, so React re-renders to nothing and the stray `0` on each
		// tab skated past survives. There is no render to rely on either, because
		// focus deliberately moves without activating - arrow across a dozen tabs
		// and the strip was a dozen Tab stops again, the thing roving tabindex is
		// here to prevent.
		for (const el of tabs) el.tabIndex = -1;
		tabs[next].tabIndex = 0;
		tabs[next].focus();
	}, []);

	return (
		<div
			ref={listRef}
			/*
			 * `w-full` is load-bearing, not cosmetic - it is the `flex-1` this
			 * carried while the strip was a row item in the title bar, restated for
			 * a column. Sized to its own content, the strip measures its own
			 * clientWidth to decide how many tabs fit, which is a feedback loop:
			 * measure the tabs, trim to fit "the space", the content shrinks, trim
			 * again. It settled on a single tab with everything else in the overflow
			 * menu regardless of how wide the window was. It has to be told to fill
			 * the parent so the measurement is of available space, not of itself.
			 *
			 * The strip owns its height, from the token the drawer's header band
			 * reads too - the two are one band across the window, and a step in it
			 * is what a second literal would produce.
			 *
			 * No `app-region` anywhere in this file any more. It used to live in the
			 * title bar, where the row was a drag region and every interactive child
			 * had to opt out; down here nothing drags the window, so the opt-outs
			 * were guarding against a rule that no longer applies to this subtree.
			 */
			className="panel-clip flex h-[var(--tabstrip-height)] w-full shrink-0 items-stretch overflow-hidden border-b border-border bg-panel"
		>
			{/*
			 * The tablist holds tabs and nothing else. The overflow trigger and the
			 * New-tab button are siblings of it rather than children: a `role=tablist`
			 * owns only `role=tab` children, and a button inside one is announced as
			 * part of the tab set - "5 of 6" with a sixth tab that is a menu. The row
			 * is unchanged visually, because the strip's flex layout is on the element
			 * around all three.
			 */}
			{/* eslint-disable-next-line jsx-a11y/interactive-supports-focus -- roving tabindex - the tablist is never a tab stop, the active `role="tab"` child carries `tabIndex={0}` and this onKeyDown moves it */}
			<div role="tablist" onKeyDown={onKeyDown} className="flex min-w-0 items-stretch">
				{visible.map((i) => (
					<TabItem
						key={openTabs[i].id}
						tab={openTabs[i]}
						isActive={openTabs[i].id === activeTabId}
						width={widths[i]}
						descriptor={descriptors[i]}
					/>
				))}
			</div>

			{/*
			 * The tabs that did not fit, reachable rather than scrolled out of
			 * sight. The strip used to be `overflow-x-auto`, which hid them behind a
			 * scroll with nothing to say they existed.
			 */}
			{overflowed.length > 0 && (
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<button
							className="flex shrink-0 items-center gap-1 border-l border-border/40 px-2 text-xs font-mono text-muted-foreground hover:bg-muted/50 hover:text-foreground"
							aria-label={`${overflowed.length} more tabs`}
						>
							+{overflowed.length}
							<ChevronDown className="w-3 h-3" />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="max-h-80 min-w-56 overflow-y-auto">
						{overflowed.map((i) => {
							const d = descriptors[i];
							const Icon = d.icon;
							return (
								<DropdownMenuItem
									key={openTabs[i].id}
									onClick={() => focusTab(openTabs[i].id)}
									className="gap-2 text-xs"
								>
									{d.method && (
										<span
											aria-hidden="true"
											className="h-3 w-0.5 shrink-0 rounded-full"
											style={{
												background: `hsl(${getMethodColor(d.method)})`,
											}}
										/>
									)}
									{Icon && <Icon className="w-3 h-3 shrink-0" />}
									{/* Full name here - the menu is where a truncated tab
									    becomes readable, so it must not truncate too. */}
									<span className="flex-1 truncate">{d.label}</span>
								</DropdownMenuItem>
							);
						})}
					</DropdownMenuContent>
				</DropdownMenu>
			)}

			<button
				onClick={() => openTab({ type: "welcome", entityId: null })}
				aria-label="New tab"
				// Where focus lands when the last tab is closed from the keyboard
				// (tab-focus.ts), the way the tree's hidden controls are reached.
				data-tab-new
				style={{ width: TAB_NEW_BUTTON_WIDTH }}
				className="flex shrink-0 items-center justify-center text-muted-foreground hover:bg-muted/50 hover:text-foreground"
			>
				<Plus className="w-3.5 h-3.5" />
			</button>
		</div>
	);
}
