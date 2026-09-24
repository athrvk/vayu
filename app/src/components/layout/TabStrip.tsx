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
import { Plus, ChevronDown } from "lucide-react";
import { useTabsStore } from "@/stores";
import { TAB_NEW_BUTTON_WIDTH } from "@/constants/layout";
// The hint an empty strip shows names a chord, so it reads the one definition
// of it rather than spelling a modifier that is wrong on half the platforms.
import { NEW_REQUEST_CHORD } from "@/constants/shortcuts";
import { formatChord } from "@/lib/platform";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
	ICON_MOTION,
} from "@/components/ui";
import { fitTabs, makeTextMeasurer, naturalTabWidth } from "./tab-fit";
// Labels and icons live beside this file, not in it: the command palette lists
// the same tabs and must name them identically. See tab-descriptors.ts.
import { useTabDescriptors } from "./tab-descriptors";
import { getMethodColor } from "@/lib/method-display";
// One tab, in its own module so a test can `vi.mock` it (#1714).
import TabItem from "./TabItem";

export function TabStrip() {
	const openTabs = useTabsStore((s) => s.openTabs);
	const activeTabId = useTabsStore((s) => s.activeTabId);
	const openTab = useTabsStore((s) => s.openTab);
	const focusTab = useTabsStore((s) => s.focusTab);
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
			// `text-sm` is the tab label's own size, declared here because this is
			// the element the width measurement reads its font from. Inheriting it
			// from `body` measured whatever the document default happened to be -
			// 16px until #1202 - so every tab came out ~23% wider than its name.
			className="panel-clip flex h-[var(--tabstrip-height)] w-full shrink-0 items-stretch overflow-hidden border-b border-border bg-panel text-sm"
		>
			{/*
			 * The tablist holds tabs and nothing else. The overflow trigger and the
			 * New-tab button are siblings of it rather than children: a `role=tablist`
			 * owns only `role=tab` children, and a button inside one is announced as
			 * part of the tab set - "5 of 6" with a sixth tab that is a menu. The row
			 * is unchanged visually, because the strip's flex layout is on the element
			 * around all three.
			 */}
			{/*
			 * No tabs open: a hint, not a blank band.
			 *
			 * The strip stays - it cannot collapse. Its height is the same token the
			 * drawer's header band reads (see the className above), so a strip that
			 * disappeared would leave the drawer's header as a 32px step in a rule
			 * that runs across the window, and the content area would jump by that
			 * much the moment the last tab closed. What was wrong was what it said:
			 * an empty 32px band with a lone "+" in it, and nothing telling a user
			 * whose last tab just closed where the app went.
			 *
			 * The chord comes from `constants/shortcuts.ts` through `formatChord`,
			 * not from a literal: the modifier and the separator differ by platform,
			 * and a hint naming the wrong key is worse than no hint.
			 */}
			{openTabs.length === 0 && (
				<span className="flex min-w-0 items-center truncate px-3 text-xs text-muted-foreground">
					Open a request from the drawer, or press {formatChord(NEW_REQUEST_CHORD)}
				</span>
			)}

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
							className="flex shrink-0 items-center gap-1 border-l border-border/40 px-2 text-xs font-mono text-muted-foreground hover:bg-muted/50 hover:text-foreground active:scale-[0.98]"
							aria-label={`${overflowed.length} more tabs`}
						>
							+{overflowed.length}
							<ChevronDown className="size-icon-sm" />
						</button>
					</DropdownMenuTrigger>
					{/* `min-w-3xs` (16rem, Tailwind's container scale), not `min-w-56`:
					    this floors the menu wide enough to hold an overflowed tab's
					    name, not chrome rhythm, and `min-w-56` rode `--spacing`,
					    narrowing it at the Default density. */}
					<DropdownMenuContent align="end" className="max-h-80 min-w-3xs overflow-y-auto">
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
									{Icon && <Icon className="size-icon-sm shrink-0" />}
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
				className="group flex shrink-0 items-center justify-center text-muted-foreground hover:bg-muted/50 hover:text-foreground active:scale-[0.98]"
			>
				<Plus className="size-icon-sm" data-icon-motion={ICON_MOTION.rotate90} />
			</button>
		</div>
	);
}
