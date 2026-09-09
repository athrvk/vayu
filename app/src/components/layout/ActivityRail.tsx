/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The app's primary navigation, on the one edge the OS never covers (#1615).
 *
 * This used to be the Dock's own left half: six buttons in the window's
 * bottom-edge footer. On macOS with Dock auto-hide on, the pointer crossing
 * the screen's bottom edge summons the system Dock over the app's lowest
 * 60-80px - exactly where the switchers sat - so reaching Collections or
 * Trash meant waiting out an animation or aiming short. The left edge is an
 * infinite-width target the OS never claims, which is where every desktop
 * tool with a switchable side panel already puts this (IntelliJ's
 * tool-window stripes, VS Code's Activity Bar, Postman's own left rail).
 *
 * **Active view marked by a 2px accent bar on the outer edge, not a filled
 * tile** (`RailButton`'s `"edge-left"` variant): a row of filled squares reads
 * as a toolbar of independent actions, and this is one mutually-exclusive
 * choice of what the Drawer shows.
 *
 * **Deliberately `role="toolbar"`-free**, same as the Dock nav this replaces:
 * that role promises full toolbar semantics beyond arrow-key traversal, and
 * claiming it for a plain `<nav>` would overstate what six toggle buttons are.
 * Arrow keys still move focus (see `onKeyDown` below) - a `<nav>` supporting
 * roving tabindex without the role is what the issue asks for, not an
 * oversight.
 *
 * A fifth stop in the F6 region cycle (`region-focus.ts`), so a keyboard user
 * can reach the rail even with the Drawer collapsed.
 */

import { useCallback, useRef } from "react";
import { DRAWER_VIEWS } from "@/constants/drawer-views";
import { DRAWER_VIEW_CHORDS } from "@/constants/shortcuts";
import { formatChord } from "@/lib/platform";
import { useLayoutStore } from "@/stores";
import { useRunningServiceCount } from "@/modules/services";
import { RailButton } from "./RailButton";
import { regionProps } from "./region-focus";

export function ActivityRail() {
	const { drawerOpen, drawerView, activateDrawerView } = useLayoutStore();
	const runningServices = useRunningServiceCount();
	const navRef = useRef<HTMLElement>(null);

	/**
	 * Up/Down move focus along the rail without activating - the same shape
	 * `TabStrip`'s arrow-key handler uses, and for the same reason: arrowing
	 * past every view on the way to Trash must not switch the Drawer six times.
	 *
	 * DOM query rather than a ref list, so the roving stop always matches what
	 * is actually rendered; direct `.tabIndex` mutation rather than React state,
	 * because promoting a destination without first clearing every other stop
	 * leaves two buttons at `tabIndex={0}` when the vdom prop that would have
	 * cleared the old one does not change (`TabStrip.tsx`'s own comment on this).
	 */
	const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLElement>) => {
		if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;

		const buttons = Array.from(navRef.current?.querySelectorAll<HTMLElement>("button") ?? []);
		if (buttons.length === 0) return;

		const current = buttons.findIndex((el) => el === document.activeElement);
		if (current === -1) return;

		const next =
			e.key === "ArrowDown"
				? (current + 1) % buttons.length
				: (current - 1 + buttons.length) % buttons.length;

		e.preventDefault();
		for (const el of buttons) el.tabIndex = -1;
		buttons[next].tabIndex = 0;
		buttons[next].focus();
	}, []);

	return (
		// eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- roving tabindex for Up/Down between the six view buttons, the same shape TabStrip's tablist uses for Left/Right; the rail is deliberately `role="toolbar"`-free (see the file doc comment), so this lands on a landmark rather than a widget role
		<nav
			ref={navRef}
			onKeyDown={onKeyDown}
			className="flex flex-col items-center gap-1 w-[var(--rail-width)] shrink-0 pt-2 border-r border-border bg-panel"
			aria-label="Sidebar views"
			{...regionProps("rail")}
		>
			{DRAWER_VIEWS.map(({ view, label, icon: Icon }) => {
				// The roving stop tracks the *selected* view, not whether the Drawer
				// is currently open on it - the Drawer being closed must not leave
				// the rail with zero tab stops.
				const isRovingStop = drawerView === view;
				return (
					<RailButton
						key={view}
						active={drawerOpen && drawerView === view}
						onClick={() => activateDrawerView(view)}
						label={label}
						shortcut={formatChord(DRAWER_VIEW_CHORDS[view])}
						side="left"
						variant="indicator"
						tabIndex={isRovingStop ? 0 : -1}
					>
						<Icon className="w-4 h-4" />
						{/* The one badge the footer carried that moves here: a local
						    service listening is otherwise invisible outside the surface
						    that started it (#502). The Dock keeps its own text chip for
						    the count; this is a plain presence dot, so the two do not
						    have to agree on wording. */}
						{view === "services" && runningServices > 0 && (
							<span
								aria-hidden="true"
								data-services-badge
								className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-status-success-text"
							/>
						)}
					</RailButton>
				);
			})}
		</nav>
	);
}
