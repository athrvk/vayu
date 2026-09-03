/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Closing a tab from the keyboard, and the focus that has to follow it.
 *
 * The element holding focus *is* the tab being closed, and it unmounts. Nothing
 * claimed focus afterwards, so it fell to `<body>` and the next Tab restarted
 * from the top of the document (#1218) - the same defect the collection tree
 * already fixes for a rename by handing focus back to its row.
 *
 * Two call sites close a tab from the keyboard - Delete/Backspace on a focused
 * tab, and the close-tab chord from wherever focus happens to be - and they
 * share this function rather than a copy each.
 */

import { flushSync } from "react-dom";
import { useTabsStore } from "@/stores/tabs-store";
import { tabElementId } from "./tab-aria";

/**
 * Close `tabId` and leave focus on the tab that takes its place.
 *
 * The replacement is the store's own choice of next active tab, read back
 * after the close rather than re-derived here: which tab follows a close is one
 * rule, in `tabs-store`, not two that can drift.
 *
 * The store write is flushed because that replacement need not be in the DOM
 * until the render commits - the strip renders only the tabs that fit, so the
 * tab that becomes active can be one that was inside the overflow menu a moment
 * ago, and a batched `closeTab` leaves it unrendered until after this function
 * returns. No test pins that line: `fireEvent` flushes through `act` either
 * way, and jsdom has no layout, so nothing overflows there. The browser is
 * where it is the difference between the right tab and the "+" fallback.
 */
export function closeTabFromKeyboard(tabId: string): void {
	flushSync(() => useTabsStore.getState().closeTab(tabId));

	const { activeTabId } = useTabsStore.getState();
	const replacement = activeTabId ? document.getElementById(tabElementId(activeTabId)) : null;
	// Closing the last tab leaves no tab to hold focus. The button that opens
	// the next one is where the user is headed anyway, and it is a real stop
	// rather than the top of the document.
	const fallback = document.querySelector<HTMLElement>("[data-tab-new]");
	(replacement ?? fallback)?.focus();
}
