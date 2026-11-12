/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a side panel does while it floats over the content instead of pushing
 * it (#3507), shared by `Drawer` and `ContextBar` so the two cannot drift.
 *
 * - One overlay at a time. Opening an overlaying panel closes the other if
 *   that one is overlaying too. This watches the open transition rather than
 *   the actions that cause it, so the rail button, the chords, the palette and
 *   `revealDrawerView` are all covered without each knowing the rule. A panel
 *   that pushes is never closed here: it takes layout space of its own, and its
 *   persisted open flag is the user's.
 * - Escape closes it when focus is inside and nothing of its own is open above
 *   it, and focus goes back to the rail button that toggles it.
 * - A pointer press outside closes it. Heard in the capture phase and never
 *   cancelled, so the click that dismissed it still lands on what it was aimed
 *   at.
 */

import { useEffect, useRef } from "react";
import { isModalOpen } from "@/lib/modal";
import { isTextEntryTarget } from "@/lib/keyboard";
import { useLayoutStore, useTabsStore } from "@/stores";
import type { SidePanelMode } from "@/constants/layout";
import { contextBarHasContent } from "./context-bar-content";
import { focusActiveTab } from "./tab-focus";

export type OverlayPanelId = "drawer" | "context";

/** Which rail edge toggles each panel; `RailButton` stamps it as `data-rail-side`. */
const RAIL_SIDE: Record<OverlayPanelId, "left" | "right"> = { drawer: "left", context: "right" };
const SIBLING: Record<OverlayPanelId, OverlayPanelId> = { drawer: "context", context: "drawer" };

/**
 * A menu, popover, select or dialog. Radix gives each of them one of these
 * roles on its content, which is portalled out of the panel - so a press on a
 * menu item is outside the panel's DOM and still belongs to it.
 */
const FLOATING_LAYER = '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]';

/** Open and actually on screen: the context bar renders nothing without sections. */
function isShowing(panel: OverlayPanelId): boolean {
	const { drawerOpen, contextBarOpen } = useLayoutStore.getState();
	if (panel === "drawer") return drawerOpen;
	const { openTabs, activeTabId } = useTabsStore.getState();
	return contextBarOpen && contextBarHasContent(openTabs.find((t) => t.id === activeTabId));
}

function isOverlaying(panel: OverlayPanelId, mode: SidePanelMode): boolean {
	return mode === "overlay" && isShowing(panel);
}

function closePanel(panel: OverlayPanelId): void {
	const { setDrawerOpen, setContextBarOpen } = useLayoutStore.getState();
	if (panel === "drawer") setDrawerOpen(false);
	else setContextBarOpen(false);
}

/**
 * The rail button that toggles `panel`: the lit one, else the rail's roving
 * stop. The context rail has one button per section and none is "the" opener.
 */
function railButtonFor(panel: OverlayPanelId): HTMLElement | null {
	const buttons = Array.from(
		document.querySelectorAll<HTMLElement>(`[data-rail-side="${RAIL_SIDE[panel]}"]`)
	);
	return (
		buttons.find((b) => b.getAttribute("aria-pressed") === "true") ??
		buttons.find((b) => b.tabIndex === 0) ??
		null
	);
}

/** To the rail button that toggles the panel; the active tab if the rail is not drawn. */
function returnFocus(panel: OverlayPanelId): void {
	const button = railButtonFor(panel);
	if (button) button.focus();
	else focusActiveTab();
}

function hasOpenFloatingLayer(): boolean {
	const layers = document.querySelectorAll<HTMLElement>(FLOATING_LAYER);
	return Array.from(layers).some((layer) => layer.getAttribute("data-state") !== "closed");
}

function shouldEscapeDismiss(e: KeyboardEvent, panelEl: HTMLElement | null): boolean {
	// Radix cancels the Escape it acts on, so a menu or popover that just closed
	// itself has already answered this one.
	if (e.key !== "Escape" || e.defaultPrevented || !panelEl) return false;
	const active = document.activeElement;
	if (!(active instanceof HTMLElement) || !panelEl.contains(active)) return false;
	// A field owns its Escape (cancel a rename, abandon a new name); the same
	// press must not also take the panel away.
	if (isTextEntryTarget(active)) return false;
	return !isModalOpen() && !hasOpenFloatingLayer();
}

function shouldPointerDismiss(
	target: EventTarget | null,
	panel: OverlayPanelId,
	panelEl: HTMLElement | null
): boolean {
	if (!(target instanceof Element) || !panelEl || panelEl.contains(target)) return false;
	// The rail's own button toggles the panel on click; closing it on the press
	// as well would have the click open it again.
	if (target.closest(`[data-rail-side="${RAIL_SIDE[panel]}"]`)) return false;
	return !isModalOpen() && !target.closest(FLOATING_LAYER);
}

interface OverlayPanelOptions {
	panel: OverlayPanelId;
	mode: SidePanelMode;
	/** The other panel's mode, so this one knows whether it is closable. */
	siblingMode: SidePanelMode;
}

/** Returns the ref for the panel's root element. */
export function useOverlayPanel({ panel, mode, siblingMode }: OverlayPanelOptions) {
	const panelRef = useRef<HTMLElement>(null);
	const sibling = SIBLING[panel];

	// Subscribed, so the effects below run on the transition.
	const open = useLayoutStore((s) => (panel === "drawer" ? s.drawerOpen : s.contextBarOpen));
	const hasContent = useTabsStore(
		(s) =>
			panel === "drawer" ||
			contextBarHasContent(s.openTabs.find((t) => t.id === s.activeTabId))
	);
	const overlaying = mode === "overlay" && open && hasContent;

	useEffect(() => {
		if (!overlaying) return;
		// Read again rather than trusting this render: one resize can leave both
		// panels overlaying and run both effects. The first closes the other, and
		// the second finds itself closed.
		if (!isOverlaying(panel, mode) || !isOverlaying(sibling, siblingMode)) return;
		closePanel(sibling);
	}, [overlaying, panel, mode, sibling, siblingMode]);

	useEffect(() => {
		if (!overlaying) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (!shouldEscapeDismiss(e, panelRef.current)) return;
			// Focus first: closing unmounts the element that holds it.
			returnFocus(panel);
			closePanel(panel);
		};
		const onPointerDown = (e: PointerEvent) => {
			if (shouldPointerDismiss(e.target, panel, panelRef.current)) closePanel(panel);
		};
		document.addEventListener("keydown", onKeyDown);
		document.addEventListener("pointerdown", onPointerDown, true);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			document.removeEventListener("pointerdown", onPointerDown, true);
		};
	}, [overlaying, panel]);

	return panelRef;
}
