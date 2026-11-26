/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The app's primary navigation, on the one edge the OS never covers (#1615). On macOS with Dock
 * auto-hide on, the pointer crossing the screen's bottom edge summons the system Dock over the
 * app's lowest 60-80px, where these switchers once sat; the left edge is an infinite-width target
 * the OS never claims, where IntelliJ, VS Code and Postman put theirs.
 *
 * **The active view is a 2px accent bar on the outer edge, not a filled tile** (`RailButton`'s
 * `"indicator"` variant): a row of filled squares reads as independent actions, and this is one
 * mutually-exclusive choice of what the Drawer shows.
 *
 * **Deliberately `role="toolbar"`-free:** that role promises full toolbar semantics, which six
 * toggle buttons in a `<nav>` do not have. Arrow keys still move focus (`onKeyDown`); a `<nav>`
 * with roving tabindex and no role is what the issue asks for, not an oversight.
 *
 * A stop in the F6 region cycle (`region-focus.ts`), so a keyboard user can reach the rail with the
 * Drawer collapsed.
 */

import { useCallback, useRef } from "react";
import { DRAWER_VIEWS } from "@/constants/drawer-views";
import { DRAWER_VIEW_CHORDS } from "@/constants/shortcuts";
import { formatChord } from "@/lib/platform";
import { useLayoutStore } from "@/stores";
import { useRunningServiceCount } from "@/modules/services";
import { RailButton } from "./RailButton";
import { regionProps } from "./region-focus";
import { useRovingStop } from "./useRovingStop";

const VIEW_IDS = DRAWER_VIEWS.map(({ view }) => view);

export function ActivityRail() {
	const drawerOpen = useLayoutStore((s) => s.drawerOpen);
	const drawerView = useLayoutStore((s) => s.drawerView);
	const activateDrawerView = useLayoutStore((s) => s.activateDrawerView);
	const runningServices = useRunningServiceCount();
	const navRef = useRef<HTMLElement>(null);
	// The roving stop tracks the *selected* view, not whether the Drawer is open on it: a closed
	// Drawer must not leave the rail with no tab stop.
	const [rovingView, setRovingView] = useRovingStop(drawerView, VIEW_IDS);

	/**
	 * Up/Down move focus without activating, as `TabStrip`'s arrow keys do: arrowing to Trash must
	 * not switch the Drawer six times.
	 *
	 * The focused button is a DOM query, so it always matches what is rendered; the roving stop is
	 * state (`useRovingStop`), since a `.tabIndex` write leaves `RailButton`'s prop unchanged and a
	 * later view change would add a second stop (#1856).
	 */
	const onKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLElement>) => {
			if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;

			const buttons = Array.from(
				navRef.current?.querySelectorAll<HTMLElement>("button") ?? []
			);
			if (buttons.length === 0) return;

			const current = buttons.findIndex((el) => el === document.activeElement);
			if (current === -1) return;

			const next =
				e.key === "ArrowDown"
					? (current + 1) % buttons.length
					: (current - 1 + buttons.length) % buttons.length;

			e.preventDefault();
			setRovingView(VIEW_IDS[next]);
			buttons[next].focus();
		},
		[setRovingView]
	);

	return (
		// eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- roving tabindex for Up/Down between the six view buttons, the same shape TabStrip's tablist uses for Left/Right; the rail is deliberately `role="toolbar"`-free (see the file doc comment), so this lands on a landmark rather than a widget role
		<nav
			ref={navRef}
			onKeyDown={onKeyDown}
			className="flex flex-col items-center gap-1 w-[var(--rail-width)] shrink-0 pt-2 border-r border-border bg-panel"
			aria-label="Sidebar views"
			{...regionProps("rail")}
		>
			{DRAWER_VIEWS.map(({ view, label, hint, icon: Icon, motion }) => {
				return (
					<RailButton
						key={view}
						active={drawerOpen && drawerView === view}
						onClick={() => activateDrawerView(view)}
						label={label}
						hint={hint}
						shortcut={formatChord(DRAWER_VIEW_CHORDS[view])}
						side="left"
						variant="indicator"
						tabIndex={view === rovingView ? 0 : -1}
					>
						{/*
						 * The descriptor names the motion: the rail draws six glyphs generically
						 * and must not learn which one it has (#1687). An entry without `motion`
						 * renders no attribute (React drops an undefined one), which matters
						 * because an empty `data-icon-motion` would still match the
						 * default-duration rule. The hover it fires from is `RailButton`'s own
						 * `group`.
						 */}
						<Icon className="size-icon" data-icon-motion={motion} />
						{/*
						 * A presence dot: a listening local service is otherwise invisible outside
						 * the surface that started it (#502). The Dock's text chip carries the
						 * count, so the two need not agree on wording.
						 */}
						{view === "services" && runningServices > 0 && (
							<span
								aria-hidden="true"
								data-services-badge
								className="enter-fade absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-status-success-text"
							/>
						)}
					</RailButton>
				);
			})}
		</nav>
	);
}
