/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * When a press becomes a drag, and what happens to the click that follows.
 *
 * A pure state machine over pointer coordinates, with no React and no DOM,
 * because the two things this has to get right are both about *ordering* and
 * neither is observable through a gesture in jsdom:
 *
 * 1. **A press is a click until it has moved far enough.** The tree's rows open
 *    on click and the hit-area rules exist because those rows already fought
 *    dead zones, so the discriminator has to be movement, never a timer -
 *    `RequestItem.test.tsx` pins that opening is synchronous.
 * 2. **A completed drag eats its trailing click.** `pointerup` after a drag is
 *    followed by a real `click` on the row, which would open the thing the user
 *    just dropped. The flag survives the release for exactly one click, so a
 *    normal click on the next row is untouched.
 *
 * Every transition returns the same object when nothing changed, so the hook can
 * hold this in state without a render per `pointermove`.
 */

/**
 * How far the pointer must travel before a press becomes a drag.
 *
 * Small enough that a deliberate drag feels immediate, large enough that the
 * hand tremor in a click never arms one. Native file managers use 4-5px.
 */
export const DRAG_THRESHOLD_PX = 4;

export type DragPhase = "idle" | "pressed" | "dragging";

export interface DragPoint {
	x: number;
	y: number;
}

export interface DragGesture {
	phase: DragPhase;
	/** Where the pointer went down, in client coordinates. `null` when idle. */
	origin: DragPoint | null;
	/**
	 * Set the moment the threshold is crossed and cleared by `consumeClick`, so
	 * the click the browser fires after a drag is swallowed and the next one is
	 * not.
	 */
	suppressClick: boolean;
}

export const IDLE_GESTURE: DragGesture = { phase: "idle", origin: null, suppressClick: false };

/** True once the pointer has travelled far enough from `origin` to arm a drag. */
export function isBeyondThreshold(origin: DragPoint, point: DragPoint): boolean {
	return Math.hypot(point.x - origin.x, point.y - origin.y) >= DRAG_THRESHOLD_PX;
}

/**
 * `pointerdown` on a row: remember where, but commit to nothing.
 *
 * A pending suppression from a previous drag is dropped here rather than
 * carried: if the click never arrived (the pointer left the row, the row
 * unmounted), the next press must not be the one that pays for it.
 */
export function pressGesture(point: DragPoint): DragGesture {
	return { phase: "pressed", origin: { x: point.x, y: point.y }, suppressClick: false };
}

/**
 * `pointermove`. Arms the drag on the first move past the threshold and is a
 * no-op for every move after that - the caller tracks the pointer itself.
 */
export function moveGesture(gesture: DragGesture, point: DragPoint): DragGesture {
	if (gesture.phase !== "pressed" || !gesture.origin) return gesture;
	if (!isBeyondThreshold(gesture.origin, point)) return gesture;
	return { phase: "dragging", origin: gesture.origin, suppressClick: true };
}

/**
 * `pointerup`. A release from `dragging` is a drop - the caller checks the phase
 * *before* calling this - and keeps the suppression for the click that follows.
 * A release from `pressed` never moved, so the click is the user's and passes.
 */
export function releaseGesture(gesture: DragGesture): DragGesture {
	if (gesture.phase === "idle") return gesture;
	return {
		phase: "idle",
		origin: null,
		suppressClick: gesture.phase === "dragging",
	};
}

/**
 * Escape, or `pointercancel`. The drop does not happen, but the click still
 * has to be eaten: the pointer moved, so the browser will fire one.
 */
export function cancelGesture(gesture: DragGesture): DragGesture {
	return releaseGesture(gesture);
}

/**
 * The trailing `click` arrived. Returns whether to swallow it, and the gesture
 * with the flag spent - one click, not every click until the next drag.
 */
export function consumeClick(gesture: DragGesture): {
	gesture: DragGesture;
	suppressed: boolean;
} {
	if (!gesture.suppressClick) return { gesture, suppressed: false };
	return { gesture: { ...gesture, suppressClick: false }, suppressed: true };
}
