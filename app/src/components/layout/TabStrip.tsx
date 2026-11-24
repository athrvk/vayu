/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The row of open tabs over the content area (main plus the context bar), with the drawer to its
 * left: that is the region tabs switch, and the drawer is a global navigator keeping its own header
 * band beside this row. Reads tabs-store; one TabItem per open tab plus a "+" button opening a
 * welcome tab. No unsaved dot: autosave is the safety net.
 *
 * **A tab is as wide as its own name, and the strip overflows rather than compressing.** Shrinking
 * every tab together makes each new tab worsen the rest, by an amount that depends on the strip
 * each platform leaves (at ~1450px eight tabs got about 140px each, 71px of it chrome, leaving 93px
 * for a name wanting 104). So the chrome is small:
 *
 * - **The method is a 2px colour rail**, not a word ("GET" cost 18px and "DELETE" 36px, so a tab's
 *   width followed its verb); the colour is the point, said the way the sidebar says it.
 * - **The close button is absolutely positioned over the trailing padding**: `opacity-0` hides a
 *   control without giving back its space, so every tab would pay 22px for one shown on one tab.
 * - **A clipped name fades at rest** (an ellipsis cannot engage inside `ScrollOnOverflow`'s `w-fit`
 *   track) and stops short of the close button, as a hard clip mid-glyph reads as a rendering
 *   fault; the hover-scroll still reads the full name.
 *
 * Path-shaped labels are cut from the *left*: `/v1/orders` and `/v1/orders/42` differ only in the
 * part a right-hand ellipsis removes first.
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Plus, ChevronDown } from "lucide-react";
import { useTabsStore } from "@/stores";
import { TAB_NEW_BUTTON_WIDTH } from "@/constants/layout";
// The hint an empty strip shows names a chord, so it reads the one definition
// of it rather than spelling a modifier that is wrong on half the platforms.
import {
	MOVE_TAB_END_CHORD,
	MOVE_TAB_LEFT_CHORD,
	MOVE_TAB_RIGHT_CHORD,
	MOVE_TAB_START_CHORD,
	NEW_REQUEST_CHORD,
	matchesChord,
} from "@/constants/shortcuts";
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
import { pluralize } from "@/modules/dashboard/utils/format";
// One tab, in its own module so a test can `vi.mock` it (#1714).
import TabItem from "./TabItem";
import { useRovingStop } from "./useRovingStop";
import { moveTabAndFocus } from "./tab-focus";
import { TabStripDndContext } from "./TabStripDndContext";
import { useTabStripDnd } from "./useTabStripDnd";

/**
 * Which place the Alt chord sends the focused tab to, or `null` for an event that is not one of the
 * four move chords. The index is the tab's place in the *store's* `openTabs`, not among the
 * rendered tabs: the strip draws only those that fit, and a move is a statement about the whole
 * list. Past an end the target is out of range and `moveTab` clamps it.
 */
function focusedTabMove(
	e: React.KeyboardEvent,
	tabId: string | undefined
): { tabId: string; toIndex: number } | null {
	if (!tabId) return null;
	const { openTabs } = useTabsStore.getState();
	const from = openTabs.findIndex((t) => t.id === tabId);
	if (from === -1) return null;

	if (matchesChord(e, MOVE_TAB_LEFT_CHORD)) return { tabId, toIndex: from - 1 };
	if (matchesChord(e, MOVE_TAB_RIGHT_CHORD)) return { tabId, toIndex: from + 1 };
	if (matchesChord(e, MOVE_TAB_START_CHORD)) return { tabId, toIndex: 0 };
	if (matchesChord(e, MOVE_TAB_END_CHORD)) return { tabId, toIndex: openTabs.length - 1 };
	return null;
}

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
	// The Tab stop is state so TabItem's memo sees it move; see useRovingStop.
	const visibleIds = visible.map((i) => openTabs[i].id);
	const [rovingId, setRovingId] = useRovingStop(activeTabId, visibleIds);
	// A dropped tab takes the Tab stop with it, as an Alt+Arrow move does.
	const dnd = useTabStripDnd({ stripRef: listRef, visibleIds, onMoved: setRovingId });

	/**
	 * Arrow-key navigation across the strip, which `role="tablist"` promises. Delegated here rather
	 * than per tab, so the tabs stay ignorant of their neighbours, and read off the DOM so the
	 * order always matches what is rendered. Focus moves without activating (`aria-selected`
	 * follows the click, not the arrow): with a heavy tab like a dashboard, activate-on-arrow would
	 * fire a mount for every tab you skate past. The Tab stop moves with the focus, as state: a DOM
	 * write would leave the tabs' `tabIndex` props disagreeing with the page. Alt+Arrow / Home /
	 * End move the focused tab instead (`focusedTabMove`) and stop the event here: off macOS
	 * Alt+←/→ is also Go back, which `Shell` would otherwise take from the window.
	 */
	const onKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLDivElement>) => {
			const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
			if (!keys.includes(e.key)) return;

			const tabs = Array.from(
				listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []
			);
			if (tabs.length === 0) return;

			const current = tabs.findIndex((el) => el === document.activeElement);
			if (current === -1) return;

			const move = e.altKey ? focusedTabMove(e, tabs[current].dataset.tabId) : null;
			if (move) {
				// Taken here so `Shell`'s window listener, which reads the same Alt+Arrow
				// as Go back off macOS, never sees it. At an end the move is a no-op and
				// the key is still ours.
				e.preventDefault();
				e.stopPropagation();
				moveTabAndFocus(move.tabId, move.toIndex);
				setRovingId(move.tabId);
				return;
			}

			let next = current;
			if (e.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
			if (e.key === "ArrowRight") next = (current + 1) % tabs.length;
			if (e.key === "Home") next = 0;
			if (e.key === "End") next = tabs.length - 1;

			e.preventDefault();
			setRovingId(tabs[next].dataset.tabId ?? null);
			tabs[next].focus();
		},
		[setRovingId]
	);

	return (
		<div
			ref={listRef}
			/*
			 * `w-full` is load-bearing: sized to its own content, the strip measures its own
			 * clientWidth to decide how many tabs fit, a feedback loop (trim to fit, the content
			 * shrinks, trim again) that settles on one tab with the rest in the overflow menu at
			 * any window width. Filling the parent makes the measurement the available space, not
			 * itself.
			 *
			 * The strip owns its height, from the token the drawer's header band reads too: the two
			 * are one band across the window, and a second literal would put a step in it. No
			 * `app-region` anywhere in this file: nothing drags the window down here.
			 */
			// `text-sm` is the tab label's own size, declared here because the width measurement
			// reads its font from this element. Inherited from `body` it measured the document
			// default, 16px (#1202), and every tab came out ~23% wider than its name.
			className="panel-clip flex h-[var(--tabstrip-height)] w-full shrink-0 items-stretch overflow-hidden border-b border-border bg-panel text-sm"
		>
			{/*
			 * The tablist holds tabs and nothing else. The overflow trigger and the New-tab button
			 * are its siblings, not children: a `role=tablist` owns only `role=tab` children, and a
			 * button inside one is announced as part of the tab set ("5 of 6", with a sixth tab
			 * that is a menu). The row looks the same, as the strip's flex layout is on the element
			 * around all three.
			 */}
			{/*
			 * No tabs open: a hint, not a blank band. The strip cannot collapse: its height is the
			 * token the drawer's header band reads (see the className above), so a vanished strip
			 * would leave a 32px step in a rule running across the window, and the content area
			 * would jump by that much as the last tab closed. An empty band with a lone "+" tells a
			 * user whose last tab just closed nothing about where the app went. The chord comes
			 * from `constants/shortcuts.ts` through `formatChord`, not a literal: the modifier and
			 * separator differ by platform, and a hint naming the wrong key is worse than no hint.
			 */}
			{openTabs.length === 0 && (
				<span className="flex min-w-0 items-center truncate px-3 text-xs text-muted-foreground">
					Open a request from the sidebar, or press {formatChord(NEW_REQUEST_CHORD)}
				</span>
			)}

			{/* eslint-disable-next-line jsx-a11y/interactive-supports-focus -- roving tabindex - the tablist is never a tab stop, the active `role="tab"` child carries `tabIndex={0}` and this onKeyDown moves it */}
			<div role="tablist" onKeyDown={onKeyDown} className="flex min-w-0 items-stretch">
				<TabStripDndContext.Provider value={dnd}>
					{visible.map((i) => (
						<TabItem
							key={openTabs[i].id}
							tab={openTabs[i]}
							isActive={openTabs[i].id === activeTabId}
							isRovingStop={openTabs[i].id === rovingId}
							width={widths[i]}
							descriptor={descriptors[i]}
						/>
					))}
				</TabStripDndContext.Provider>
			</div>

			{/* The tabs that did not fit, reachable rather than scrolled out of sight. */}
			{overflowed.length > 0 && (
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<button
							className="flex shrink-0 items-center gap-1 border-l border-border/40 px-2 text-xs font-mono text-muted-foreground hover:bg-muted/50 hover:text-foreground active:scale-[0.98]"
							aria-label={`${overflowed.length} more ${pluralize(overflowed.length, "tab")}`}
						>
							+{overflowed.length}
							<ChevronDown className="size-icon-sm" />
						</button>
					</DropdownMenuTrigger>
					{/* `min-w-3xs` (16rem, Tailwind's container scale), not `min-w-56`:
					    this floors the menu wide enough to hold an overflowed tab's
					    name, not chrome rhythm, and `min-w-56` rode `--spacing`,
					    narrowing it at the Default density. */}
					<DropdownMenuContent
						align="end"
						className="max-h-80 min-w-3xs overflow-y-auto [scrollbar-gutter:auto]"
					>
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
				className="group flex h-full min-w-target shrink-0 items-center justify-center text-muted-foreground hover:bg-muted/50 hover:text-foreground active:scale-[0.98]"
			>
				<Plus className="size-icon-sm" data-icon-motion={ICON_MOTION.rotate90} />
			</button>
		</div>
	);
}
