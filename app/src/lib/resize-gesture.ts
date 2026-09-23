/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The rAF-coalesced-write, commit-on-release drag (issue #1715), shared
 * between `PanelResizeHandle` (drawer/context-bar width) and
 * `ScriptElementForm` (script editor height) rather than hand-rolled twice
 * (issue #1738 - the two copies had already drifted on day one: this hook's
 * keyboard handling and `pointercancel` cleanup did not exist in either
 * before this file, so neither copy had them).
 *
 * A pointer drag does not call `commit` per `pointermove` - a mouse or
 * trackpad fires 120-240 of those a second, which turns a naive per-move
 * commit into that many `JSON.stringify` + `localStorage.setItem` calls of
 * the whole persisted layout slice (`layout-store` is a zustand `persist`
 * store), plus a re-render of every subscriber. The live value is painted
 * straight into the DOM instead - through the imperative `paint` the caller
 * supplies - once per animation frame, and `commit` runs exactly once, on
 * release, with the final value; the store's own re-render then lands on the
 * same value the last frame already painted, so there is nothing to jump
 * from. (`ScriptElementForm` used to debounce `commit` mid-drag instead,
 * which left a window where a stale debounced write could land after the
 * live override cleared - a revert-then-jump flash on release. This
 * mechanism has no such window: nothing but `commit` ever writes the store,
 * and it writes once.)
 *
 * `pointercancel` (a touch interruption, an OS overlay taking the gesture)
 * aborts rather than commits: the live paint reverts to the value the drag
 * started from and the store is never touched, because the drag did not
 * happen.
 *
 * A held key (OS auto-repeat) is the same flood by another name - holding an
 * arrow fires `keydown` about as often as a drag fires `pointermove`. A
 * single press (`e.repeat === false`) still commits immediately, matching
 * the double-click / Enter-reset contract a caller may also expose; a
 * repeat's commit coalesces to once per animation frame the same way a
 * drag's paint does, and `flushKey` (wired to `onKeyUp` and `onBlur`)
 * commits whatever the last frame never got to, so releasing the key never
 * drops the final position. The handle's own `aria-valuenow` still updates
 * on every keystroke regardless of repeat, so the announced value never
 * lags behind what a screen reader user just pressed.
 */

import { useCallback, useRef } from "react";

export interface ResizeGestureOptions {
	min: number;
	max: number;
	/** Where a drag or a keyboard nudge starts from - read live, never captured once. */
	getValue: () => number;
	/** The one write a gesture makes: a drag's release, a discrete key press, or a held key's coalesced tail. */
	commit: (value: number) => void;
	/**
	 * The live preview during a pointer drag, painted at most once per
	 * animation frame - typically `element.style.width` or `.height`.
	 * Keyboard nudges never call this: `commit` already re-renders from the
	 * real value, immediately for a discrete press.
	 */
	paint: (value: number) => void;
}

export interface ResizeGesture {
	/** `onPointerDown`. `sign` flips which pointer direction grows the value (a left-edge handle, say); defaults to growing with the pointer. */
	startDrag: (e: React.PointerEvent<HTMLElement>, axis: "x" | "y", sign?: 1 | -1) => void;
	/**
	 * `onKeyDown`, once the caller has computed the candidate value (a nudge
	 * or an absolute jump). Clamps, updates the handle's own `aria-valuenow`
	 * immediately, and commits now for a discrete press or coalesces for a
	 * held one (`e.repeat`).
	 */
	applyKey: (e: React.KeyboardEvent<HTMLElement>, value: number) => void;
	/** What a keyboard action should compute its next step from - the in-flight value during a held key, otherwise `getValue()`. */
	currentValue: () => number;
	/** `onKeyUp` and `onBlur`: commits a still-pending coalesced keyboard value, a no-op if there is none. */
	flushKey: () => void;
}

export function useResizeGesture({
	min,
	max,
	getValue,
	commit,
	paint,
}: ResizeGestureOptions): ResizeGesture {
	const clamp = useCallback((value: number) => Math.max(min, Math.min(max, value)), [min, max]);

	// Coalescing state shared by the drag and the keyboard-repeat paths - only
	// one of the two is ever active at once, so one rAF id and one pending
	// value cover both.
	const rafIdRef = useRef<number | null>(null);
	const pendingRef = useRef<number | null>(null);
	// The in-flight value during a keyboard hold, so the next repeat nudges
	// from where the last one left off rather than from the store, which a
	// coalesced repeat has not written to yet.
	const liveKeyRef = useRef<number | null>(null);

	const cancelFrame = useCallback(() => {
		if (rafIdRef.current !== null) {
			cancelAnimationFrame(rafIdRef.current);
			rafIdRef.current = null;
		}
	}, []);

	const scheduleFrame = useCallback((value: number, run: (value: number) => void) => {
		pendingRef.current = value;
		if (rafIdRef.current !== null) return;
		rafIdRef.current = requestAnimationFrame(() => {
			rafIdRef.current = null;
			const scheduled = pendingRef.current;
			pendingRef.current = null;
			if (scheduled !== null) run(scheduled);
		});
	}, []);

	const startDrag = useCallback(
		(e: React.PointerEvent<HTMLElement>, axis: "x" | "y", sign: 1 | -1 = 1) => {
			const handleEl = e.currentTarget;
			handleEl.setPointerCapture(e.pointerId);
			const startCoord = axis === "x" ? e.clientX : e.clientY;
			const startValue = getValue();
			let liveValue = startValue;

			const paintFrame = (value: number) => {
				paint(value);
				handleEl.setAttribute("aria-valuenow", String(Math.round(value)));
			};

			const onMove = (moveEvent: PointerEvent) => {
				const coord = axis === "x" ? moveEvent.clientX : moveEvent.clientY;
				liveValue = clamp(startValue + (coord - startCoord) * sign);
				scheduleFrame(liveValue, paintFrame);
			};
			const cleanup = () => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				window.removeEventListener("pointercancel", onCancel);
				cancelFrame();
			};
			const onUp = () => {
				cleanup();
				commit(liveValue);
			};
			const onCancel = () => {
				cleanup();
				// The drag didn't happen - the live preview goes back exactly where
				// it started, since nothing was ever committed to undo.
				paintFrame(startValue);
			};
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
			window.addEventListener("pointercancel", onCancel);
		},
		[clamp, getValue, commit, paint, scheduleFrame, cancelFrame]
	);

	const currentValue = useCallback(() => liveKeyRef.current ?? getValue(), [getValue]);

	const applyKey = useCallback(
		(e: React.KeyboardEvent<HTMLElement>, value: number) => {
			const clamped = clamp(value);
			liveKeyRef.current = clamped;
			e.currentTarget.setAttribute("aria-valuenow", String(Math.round(clamped)));
			if (e.repeat) {
				scheduleFrame(clamped, commit);
			} else {
				cancelFrame();
				pendingRef.current = null;
				commit(clamped);
				// `liveKeyRef` is left set until `flushKey` (`onKeyUp`/`onBlur`)
				// clears it - a repeat immediately following this same press
				// continues nudging from here, not from `getValue()`, which the
				// caller has not necessarily re-rendered with the just-committed
				// value yet.
			}
		},
		[clamp, commit, scheduleFrame, cancelFrame]
	);

	const flushKey = useCallback(() => {
		cancelFrame();
		if (pendingRef.current !== null) {
			commit(pendingRef.current);
			pendingRef.current = null;
		}
		liveKeyRef.current = null;
	}, [cancelFrame, commit]);

	return { startDrag, applyKey, currentValue, flushKey };
}
