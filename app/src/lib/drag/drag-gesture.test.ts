/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The press-versus-drag machine (#367).
 *
 * Node environment: the whole point of extracting this is that the two rules
 * that matter - a press below the threshold is still a click, and a completed
 * drag eats exactly one trailing click - are decidable without a DOM, and are
 * the two a jsdom gesture cannot observe directly.
 */

import { describe, it, expect } from "vitest";
import {
	DRAG_THRESHOLD_PX,
	IDLE_GESTURE,
	cancelGesture,
	consumeClick,
	isBeyondThreshold,
	moveGesture,
	pressGesture,
	releaseGesture,
} from "./drag-gesture";

const at = (x: number, y: number) => ({ x, y });

describe("arming a drag", () => {
	it("stays pressed while the pointer has not travelled far enough", () => {
		const pressed = pressGesture(at(100, 100));
		const moved = moveGesture(pressed, at(100 + DRAG_THRESHOLD_PX - 1, 100));
		expect(moved.phase).toBe("pressed");
		// Same object, not an equal one: the hook holds this in state and a new
		// reference per pointermove is a render per pointermove.
		expect(moved).toBe(pressed);
	});

	it("arms at the threshold, in any direction", () => {
		const pressed = pressGesture(at(100, 100));
		expect(moveGesture(pressed, at(100, 100 + DRAG_THRESHOLD_PX)).phase).toBe("dragging");
		expect(moveGesture(pressed, at(100 - DRAG_THRESHOLD_PX, 100)).phase).toBe("dragging");
		// Diagonal distance, not per-axis: 3,3 is 4.24px away.
		expect(moveGesture(pressed, at(103, 103)).phase).toBe("dragging");
		expect(moveGesture(pressed, at(102, 102)).phase).toBe("pressed");
	});

	it("measures from the press, not from the previous move", () => {
		const pressed = pressGesture(at(100, 100));
		const crept = moveGesture(moveGesture(pressed, at(102, 100)), at(104, 100));
		expect(crept.phase).toBe("dragging");
	});

	it("ignores moves with no press behind them", () => {
		expect(moveGesture(IDLE_GESTURE, at(500, 500))).toBe(IDLE_GESTURE);
	});

	it("computes the threshold from the origin", () => {
		expect(isBeyondThreshold(at(0, 0), at(0, DRAG_THRESHOLD_PX))).toBe(true);
		expect(isBeyondThreshold(at(0, 0), at(0, DRAG_THRESHOLD_PX - 0.5))).toBe(false);
	});
});

describe("the click that follows", () => {
	it("is swallowed after a drag, exactly once", () => {
		const dragging = moveGesture(pressGesture(at(0, 0)), at(0, 20));
		const released = releaseGesture(dragging);
		expect(released.phase).toBe("idle");

		const first = consumeClick(released);
		expect(first.suppressed).toBe(true);
		// The next click is the user's - a drag suppresses its own trailing click
		// and nothing else.
		expect(consumeClick(first.gesture).suppressed).toBe(false);
	});

	it("is untouched when the press never became a drag", () => {
		const released = releaseGesture(pressGesture(at(0, 0)));
		expect(consumeClick(released).suppressed).toBe(false);
	});

	it("is still swallowed when the drag was cancelled", () => {
		// Escape stops the drop, not the browser: the pointer moved, so a click
		// is coming either way and it must not open the row.
		const dragging = moveGesture(pressGesture(at(0, 0)), at(0, 20));
		expect(consumeClick(cancelGesture(dragging)).suppressed).toBe(true);
	});

	it("does not carry a stale suppression into the next press", () => {
		const dragging = moveGesture(pressGesture(at(0, 0)), at(0, 20));
		const released = releaseGesture(dragging);
		// The click never arrived (the row unmounted, the pointer left). A fresh
		// press must not be the one that pays for it.
		expect(consumeClick(pressGesture(at(0, 0))).suppressed).toBe(false);
		expect(released.suppressClick).toBe(true);
	});
});
