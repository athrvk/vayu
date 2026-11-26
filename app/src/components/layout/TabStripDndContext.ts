/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { createContext } from "react";

/**
 * The pointer wiring a tab spreads onto its own box, one object as a tab takes all of it or none:
 * the gesture is coherent only if one element sees the press, the moves and the release. The tab an
 * event belongs to is read from the element (`data-tab-id`), so this is one stable value shared by
 * every tab, not a closure per tab.
 */
export interface TabStripPointerHandlers {
	onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
	onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
	onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
	onPointerCancel: (e: React.PointerEvent<HTMLElement>) => void;
	/** Swallows the click the browser fires after a completed drag. */
	onClickCapture: (e: React.MouseEvent<HTMLElement>) => void;
}

/**
 * What a tab needs to know about a live drag, through context rather than props so
 * `tabItemPropsEqual` is untouched: the value changes only during a drag, so at rest no tab
 * re-renders on its account. `null` means no drag machinery is mounted (a test rendering one tab
 * alone), and the tab must stay usable without it.
 */
export interface TabStripDnd {
	/** The tab being dragged, or `null` when no drag is armed. */
	draggingId: string | null;
	/** The visible tab the drop line is drawn on, and which of its edges. */
	dropTabId: string | null;
	dropEdge: "before" | "after" | null;
	handlers: TabStripPointerHandlers;
}

export const TabStripDndContext = createContext<TabStripDnd | null>(null);
