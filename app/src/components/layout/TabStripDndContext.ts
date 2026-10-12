/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { createContext } from "react";

/**
 * The pointer wiring a tab spreads onto its own box. One object because a tab
 * takes all of it or none: the gesture is only coherent if the same element
 * sees the press, the moves and the release. Which tab an event belongs to is
 * read from the element (`data-tab-id`), so the object is one stable value
 * shared by every tab rather than a closure per tab.
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
 * What a tab needs to know about a drag in progress. It arrives through context
 * rather than props so `tabItemPropsEqual` is untouched: the value changes only
 * while a drag is live, so at rest no tab re-renders on its account.
 *
 * `null` means no drag machinery is mounted, which is what a test rendering one
 * tab in isolation gets - the tab must stay usable without it.
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
