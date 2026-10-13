/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Drag-to-reorder for the tab strip: the pointer half of moving a tab, beside
 * the Alt+Arrow chords (#2038).
 *
 * The collection tree's `useTreeDnd` with everything tree-shaped removed. The
 * gesture (`lib/drag/drag-gesture`) and the slot arithmetic (`lib/drag/drop-slot`)
 * are the shared primitives; what is left is pointer capture, hit testing against
 * the rendered tabs, and the one write, which is `moveTabAndFocus` - the same call
 * the keyboard path makes, so a drop and an Alt+Arrow cannot disagree about focus.
 *
 * **No edge auto-scroll.** The strip is `overflow-hidden` on purpose and what does
 * not fit lives in the overflow menu, so there is nothing to scroll. A pointer past
 * the last visible tab's midpoint names the slot after it, wherever it is
 * horizontally: `slotAt` counts midpoints, so a pointer over the "+N" trigger or
 * the "+" button needs no clamping to resolve to that same slot. Overflowed tabs
 * cannot be dropped onto; choosing one from the menu surfaces it in the strip.
 *
 * **Release outside the strip cancels.** The pointer's y outside the strip root's
 * rect resolves no slot, and a release with no slot drops nothing.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useTabsStore } from "@/stores";
import {
	consumeClick,
	cancelGesture,
	isOwnEvent,
	moveGesture,
	pressGesture,
	releaseGesture,
	IDLE_GESTURE,
	type DragGesture,
} from "@/lib/drag/drag-gesture";
import { landingIndex, slotAt, type ItemExtent } from "@/lib/drag/drop-slot";
import { moveTabAndFocus } from "./tab-focus";
import type { TabStripDnd, TabStripPointerHandlers } from "./TabStripDndContext";

export interface TabStripDndOptions {
	/** The strip root: the rect a release is tested against, and the tabs' ancestor. */
	stripRef: RefObject<HTMLElement | null>;
	/** The ids of the tabs the strip renders, in strip order - not the overflowed ones. */
	visibleIds: readonly string[];
	/** The tab landed in a new place; the strip hands the roving Tab stop to it. */
	onMoved: (tabId: string) => void;
}

function renderedTabs(strip: HTMLElement | null): HTMLElement[] {
	return Array.from(strip?.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"]') ?? []);
}

function extentOf(el: HTMLElement): ItemExtent {
	const { left, right } = el.getBoundingClientRect();
	return { start: left, end: right };
}

/**
 * The `openTabs` index a visible slot inserts before. The strip renders only the
 * tabs that fit, and the active tab is surfaced beside them from wherever it sits,
 * so the visible tabs can have hidden ones between them. A slot other than the
 * first therefore lands right after the visible tab to its left, never before the
 * one to its right: a drop beside a run of hidden tabs goes to the head of that
 * run and the dropped tab stays on screen. The end slot lands after the last
 * rendered tab. `null` when a tab the slot names has since closed.
 */
function insertionIndex(slot: number, visibleIds: readonly string[]): number | null {
	if (visibleIds.length === 0) return null;
	const { openTabs } = useTabsStore.getState();
	const indexOf = (id: string) => openTabs.findIndex((t) => t.id === id);

	if (slot === 0) {
		const at = indexOf(visibleIds[0]);
		return at === -1 ? null : at;
	}
	const left = indexOf(visibleIds[Math.min(slot, visibleIds.length) - 1]);
	return left === -1 ? null : left + 1;
}

/**
 * Where dropping `draggedId` in visible `slot` moves it in the store's list, or
 * `null` when either tab has since closed. Compared in store terms because a gap
 * of hidden tabs makes the visible neighbours of a tab differ from its store ones.
 */
function storeMove(
	slot: number,
	draggedId: string,
	visibleIds: readonly string[]
): { from: number; to: number } | null {
	const insertBefore = insertionIndex(slot, visibleIds);
	const from = useTabsStore.getState().openTabs.findIndex((t) => t.id === draggedId);
	if (insertBefore === null || from === -1) return null;
	return { from, to: landingIndex(insertBefore, from) };
}

/**
 * The slot among the rendered tabs a pointer names, or `null` for none: outside
 * the strip vertically, or a slot whose drop would leave the dragged tab where it is.
 */
function slotUnderPointer(
	strip: HTMLElement,
	point: { x: number; y: number },
	draggedId: string,
	visibleIds: readonly string[]
): number | null {
	const bounds = strip.getBoundingClientRect();
	if (point.y < bounds.top || point.y > bounds.bottom) return null;

	const slot = slotAt(renderedTabs(strip).map(extentOf), point.x);
	const move = storeMove(slot, draggedId, visibleIds);
	return move && move.to !== move.from ? slot : null;
}

/** The tab and edge the drop line is drawn on: slot `s` is before tab `s`, slot `n` after tab `n - 1`. */
function dropLineFor(
	slot: number | null,
	visibleIds: readonly string[]
): { tabId: string; edge: "before" | "after" } | null {
	if (slot === null || visibleIds.length === 0) return null;
	if (slot < visibleIds.length) return { tabId: visibleIds[slot], edge: "before" };
	return { tabId: visibleIds[visibleIds.length - 1], edge: "after" };
}

export function useTabStripDnd({ stripRef, visibleIds, onMoved }: TabStripDndOptions): TabStripDnd {
	const [draggingId, setDraggingId] = useState<string | null>(null);
	const [slot, setSlot] = useState<number | null>(null);

	/*
	 * The gesture, the pressed tab and the resolved slot are refs, not state: they
	 * change on every `pointermove`, and a render per move would rebuild the strip
	 * to move a 2px line. What renders - the dimmed tab and the line - is state,
	 * and is only written when it changes.
	 */
	const gestureRef = useRef<DragGesture>(IDLE_GESTURE);
	const pressedRef = useRef<{ tabId: string; pointerId: number; el: HTMLElement } | null>(null);
	const slotRef = useRef<number | null>(null);

	// The tabs as of the last render, for handlers that outlive it.
	const visibleIdsRef = useRef(visibleIds);
	useEffect(() => {
		visibleIdsRef.current = visibleIds;
	}, [visibleIds]);

	const endDrag = useCallback(() => {
		const pressed = pressedRef.current;
		if (pressed?.el.hasPointerCapture?.(pressed.pointerId)) {
			pressed.el.releasePointerCapture(pressed.pointerId);
		}
		pressedRef.current = null;
		slotRef.current = null;
		setDraggingId(null);
		setSlot(null);
	}, []);

	const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
		if (e.button !== 0) return;
		// An open tab menu is a React child of this tab but not a DOM one.
		if (!isOwnEvent(e)) return;
		// The close control is its own button; a press on it is not a press on the tab.
		if (e.target instanceof Element && e.target.closest("[data-tab-close]")) return;
		const tabId = e.currentTarget.dataset.tabId;
		if (!tabId) return;

		gestureRef.current = pressGesture({ x: e.clientX, y: e.clientY });
		pressedRef.current = { tabId, pointerId: e.pointerId, el: e.currentTarget };
		// Capture keeps `pointermove` coming to this tab wherever the pointer goes,
		// which is what lets a release outside the strip be seen at all.
		e.currentTarget.setPointerCapture?.(e.pointerId);
	}, []);

	const onPointerMove = useCallback(
		(e: React.PointerEvent<HTMLElement>) => {
			const pressed = pressedRef.current;
			// While a drag is live the tab holds the pointer capture, so every real
			// move targets it - anything else reaching here came through a portal.
			if (!pressed || !isOwnEvent(e)) return;

			const next = moveGesture(gestureRef.current, { x: e.clientX, y: e.clientY });
			if (next !== gestureRef.current) {
				gestureRef.current = next;
				if (next.phase === "dragging") setDraggingId(pressed.tabId);
			}
			if (gestureRef.current.phase !== "dragging" || !stripRef.current) return;

			const resolved = slotUnderPointer(
				stripRef.current,
				{ x: e.clientX, y: e.clientY },
				pressed.tabId,
				visibleIdsRef.current
			);
			if (resolved === slotRef.current) return;
			slotRef.current = resolved;
			setSlot(resolved);
		},
		[stripRef]
	);

	const onPointerUp = useCallback(
		(e: React.PointerEvent<HTMLElement>) => {
			const pressed = pressedRef.current;
			if (!pressed || !isOwnEvent(e)) return;
			const dropped = gestureRef.current.phase === "dragging";
			gestureRef.current = releaseGesture(gestureRef.current);
			const target = slotRef.current;
			endDrag();
			if (!dropped || target === null) return;

			const move = storeMove(target, pressed.tabId, visibleIdsRef.current);
			if (!move) return;

			moveTabAndFocus(pressed.tabId, move.to);
			onMoved(pressed.tabId);
		},
		[endDrag, onMoved]
	);

	const onPointerCancel = useCallback(() => {
		gestureRef.current = cancelGesture(gestureRef.current);
		endDrag();
	}, [endDrag]);

	const onClickCapture = useCallback((e: React.MouseEvent<HTMLElement>) => {
		// A menu item's click bubbles through the tab it belongs to. Swallowing it
		// would be the drag eating the very action the user chose *because* the
		// drag before it left a suppression armed.
		if (!isOwnEvent(e)) return;
		const { gesture, suppressed } = consumeClick(gestureRef.current);
		gestureRef.current = gesture;
		if (!suppressed) return;
		e.preventDefault();
		e.stopPropagation();
	}, []);

	// Escape cancels mid-drag. On `window` rather than the tab: the tab is not
	// focused during a drag, so a keydown never reaches it.
	useEffect(() => {
		if (!draggingId) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			gestureRef.current = cancelGesture(gestureRef.current);
			endDrag();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [draggingId, endDrag]);

	const handlers = useMemo<TabStripPointerHandlers>(
		() => ({ onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture }),
		[onClickCapture, onPointerCancel, onPointerDown, onPointerMove, onPointerUp]
	);

	// Primitives, so the value below is the same object from one render to the
	// next while no drag is live and no tab re-renders on its account.
	const line = dropLineFor(slot, visibleIds);
	const dropTabId = line?.tabId ?? null;
	const dropEdge = line?.edge ?? null;

	return useMemo(
		() => ({ draggingId, dropTabId, dropEdge, handlers }),
		[draggingId, dropTabId, dropEdge, handlers]
	);
}
